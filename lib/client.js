import { request as httpRequest, validateHeaderValue } from 'node:http';
import { endpointUrl } from './security.js';
import { redactSensitive } from './redact.js';
function safeStatusMessage(status, endpoint, target) {
    if (status === 401 || status === 403) {
        return `Spring Actuator denied ${endpoint} for target "${target}"; verify authorizationRef and endpoint access policy`;
    }
    if (status === 404) {
        return `Spring Actuator endpoint ${endpoint} is unavailable for target "${target}"; expose only the endpoint you need and verify actuatorUrl`;
    }
    return `Spring Actuator returned HTTP ${status} for ${endpoint} on target "${target}"`;
}
function contentLength(response) {
    const raw = response.headers['content-length'];
    if (raw === undefined || Array.isArray(raw) || !/^\d+$/.test(raw))
        return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : undefined;
}
function readJsonResponse(response, maxBytes, endpoint, target, acceptedStatuses) {
    return new Promise((resolve, reject) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
            response.destroy();
            reject(new Error(`Spring Actuator redirect refused for ${endpoint} on target "${target}"`));
            return;
        }
        if ((status < 200 || status >= 300) && !acceptedStatuses.has(status)) {
            response.destroy();
            reject(new Error(safeStatusMessage(status, endpoint, target)));
            return;
        }
        const declaredLength = contentLength(response);
        if (declaredLength !== undefined && declaredLength > maxBytes) {
            response.destroy();
            reject(new Error(`Spring Actuator response exceeded ${maxBytes} bytes for target "${target}"`));
            return;
        }
        const contentEncoding = response.headers['content-encoding'];
        if (contentEncoding !== undefined && contentEncoding !== 'identity') {
            response.destroy();
            reject(new Error(`Spring Actuator returned unsupported content encoding for target "${target}"`));
            return;
        }
        const rawContentType = response.headers['content-type'];
        const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
        const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
        if (mediaType !== 'application/json' && !mediaType?.endsWith('+json')) {
            response.destroy();
            reject(new Error(`Spring Actuator returned non-JSON content for target "${target}"`));
            return;
        }
        const chunks = [];
        let bytes = 0;
        let settled = false;
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            response.destroy();
            reject(error);
        };
        response.on('data', (chunk) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.byteLength;
            if (bytes > maxBytes) {
                fail(new Error(`Spring Actuator response exceeded ${maxBytes} bytes for target "${target}"`));
                return;
            }
            chunks.push(buffer);
        });
        response.once('aborted', () => fail(new Error(`Spring Actuator response was aborted for target "${target}"`)));
        response.once('error', () => fail(new Error(`Spring Actuator response failed for target "${target}"`)));
        response.once('end', () => {
            if (settled)
                return;
            settled = true;
            try {
                const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
                if (text.length === 0)
                    throw new Error('empty body');
                const redacted = redactSensitive(JSON.parse(text));
                resolve({
                    statusCode: status,
                    data: redacted.value,
                    redactedCount: redacted.redactedCount,
                    sourceTruncated: redacted.truncated,
                });
            }
            catch (cause) {
                reject(new Error(`Spring Actuator returned invalid JSON for target "${target}"`, { cause }));
            }
        });
    });
}
export class ActuatorClient {
    #targets;
    #timeoutMs;
    #maxResponseBytes;
    #resolveAuthorization;
    constructor(options) {
        this.#targets = new Map(options.targets.map((target) => [target.id, target]));
        this.#timeoutMs = options.timeoutMs;
        this.#maxResponseBytes = options.maxResponseBytes;
        this.#resolveAuthorization = options.resolveAuthorization;
    }
    async get(targetId, segments, signal, query, acceptedStatuses = []) {
        const target = this.#targets.get(targetId);
        if (target === undefined)
            throw new TypeError(`unknown Spring target "${targetId}"`);
        if (signal.aborted)
            throw new Error(`Spring Actuator request aborted for target "${targetId}"`);
        const headers = {
            accept: 'application/json',
            'accept-encoding': 'identity',
        };
        if (target.authorizationRef !== undefined) {
            let value;
            try {
                value = await this.#resolveAuthorization(target.authorizationRef);
            }
            catch {
                throw new Error(`credential reference "${target.authorizationRef}" could not be resolved`);
            }
            if (value === undefined || value.length === 0) {
                throw new Error(`credential reference "${target.authorizationRef}" is not configured`);
            }
            if (value.length > 8192 || /[\r\n]/.test(value)) {
                throw new Error(`credential reference "${target.authorizationRef}" contains an invalid Authorization value`);
            }
            try {
                validateHeaderValue('authorization', value);
            }
            catch {
                throw new Error(`credential reference "${target.authorizationRef}" contains an invalid Authorization value`);
            }
            headers.authorization = value;
        }
        if (signal.aborted)
            throw new Error(`Spring Actuator request aborted for target "${targetId}"`);
        const url = endpointUrl(target, segments, query);
        const endpoint = segments.join('/');
        return new Promise((resolve, reject) => {
            let settled = false;
            let rejectionScheduled = false;
            let timer;
            let req;
            let response;
            let requestClosed = false;
            let responseClosed = false;
            let terminalError;
            const cleanup = () => {
                if (timer !== undefined)
                    clearTimeout(timer);
                signal.removeEventListener('abort', abort);
            };
            const finishReject = (error) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                reject(error);
            };
            const finishResolve = (value) => {
                if (settled || terminalError !== undefined)
                    return;
                settled = true;
                cleanup();
                resolve(value);
            };
            const maybeFinishTermination = () => {
                if (settled || terminalError === undefined || !requestClosed)
                    return;
                if (response !== undefined && !responseClosed)
                    return;
                if (rejectionScheduled)
                    return;
                rejectionScheduled = true;
                // Give close/error callbacks already queued by destroy() one turn to
                // drain before the tool promise settles.
                setImmediate(() => finishReject(terminalError));
            };
            const terminate = (error) => {
                terminalError ??= error;
                response?.destroy();
                req?.destroy();
                maybeFinishTermination();
            };
            const abort = () => terminate(new Error(`Spring Actuator request aborted for target "${targetId}"`));
            try {
                req = httpRequest(url, {
                    method: 'GET',
                    headers,
                    agent: false,
                }, (incoming) => {
                    response = incoming;
                    responseClosed = incoming.closed;
                    incoming.once('close', () => {
                        responseClosed = true;
                        maybeFinishTermination();
                    });
                    if (terminalError !== undefined) {
                        incoming.destroy();
                        maybeFinishTermination();
                        return;
                    }
                    void readJsonResponse(incoming, this.#maxResponseBytes, endpoint, targetId, new Set(acceptedStatuses))
                        .then(finishResolve, terminate);
                });
            }
            catch {
                finishReject(new Error(`Spring Actuator request failed for target "${targetId}"`));
                return;
            }
            req.once('close', () => {
                requestClosed = true;
                maybeFinishTermination();
            });
            timer = setTimeout(() => {
                terminate(new Error(`Spring Actuator request timed out after ${this.#timeoutMs}ms for target "${targetId}"`));
            }, this.#timeoutMs);
            signal.addEventListener('abort', abort, { once: true });
            req.once('error', () => {
                if (terminalError !== undefined)
                    return;
                terminate(new Error(`Spring Actuator request failed for target "${targetId}"`));
            });
            try {
                req.end();
            }
            catch {
                terminate(new Error(`Spring Actuator request failed for target "${targetId}"`));
            }
        });
    }
}
