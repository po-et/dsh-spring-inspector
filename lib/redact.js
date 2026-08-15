const SENSITIVE_KEY_PATTERN = /(?:authorization|cookie|credential|secret|token|passw(?:or)?d|passwd|pwd|api[-_]?key|private[-_]?key|client[-_]?secret)/i;
const DESCRIPTOR_KEY_PATTERN = /^(?:name|key|tag|property)$/i;
const DESCRIPTOR_VALUE_KEY_PATTERN = /^(?:value|values|defaultValue|currentValue)$/i;
const AUTHORIZATION_VALUE_PATTERN = /\b(Bearer|Basic)\s+[^\s,;"']+/gi;
const SENSITIVE_QUERY_PATTERN = /([?&](?:access_token|api_key|apikey|key|password|secret|token)=)[^&#\s]+/gi;
const REDACTED = '[REDACTED]';
const NODE_LIMIT_MARKER = '[TRUNCATED: node limit]';
const DEPTH_LIMIT = 48;
export const CANONICAL_NODE_LIMIT = 10_000;
function redactString(value, counter) {
    const redacted = value
        .replace(AUTHORIZATION_VALUE_PATTERN, '$1 [REDACTED]')
        .replace(SENSITIVE_QUERY_PATTERN, '$1[REDACTED]');
    if (redacted !== value)
        counter.value += 1;
    return redacted;
}
function hasSensitiveDescriptor(value) {
    const object = value;
    for (const key in object) {
        if (!Object.hasOwn(object, key))
            continue;
        const entry = object[key];
        if (DESCRIPTOR_KEY_PATTERN.test(key) && typeof entry === 'string' && isSensitiveName(entry))
            return true;
    }
    return false;
}
function markArrayTruncated(output, state) {
    state.truncated = true;
    if (state.markerEmitted)
        return;
    state.markerEmitted = true;
    output.push(NODE_LIMIT_MARKER);
}
function markObjectTruncated(output, state) {
    state.truncated = true;
    if (state.markerEmitted)
        return;
    state.markerEmitted = true;
    output['[TRUNCATED]'] = NODE_LIMIT_MARKER;
}
function visit(value, depth, state) {
    state.remainingNodes -= 1;
    if (depth > DEPTH_LIMIT) {
        state.truncated = true;
        return '[TRUNCATED: depth limit]';
    }
    if (value === null || typeof value === 'boolean')
        return value;
    if (typeof value === 'string') {
        const counter = { value: state.redactedCount };
        const redacted = redactString(value, counter);
        state.redactedCount = counter.value;
        return redacted;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            return null;
        return Object.is(value, -0) ? 0 : value;
    }
    if (Array.isArray(value)) {
        const output = [];
        for (const entry of value) {
            if (state.remainingNodes === 0) {
                markArrayTruncated(output, state);
                break;
            }
            output.push(visit(entry, depth + 1, state));
        }
        return output;
    }
    if (typeof value !== 'object')
        return String(value);
    const output = Object.create(null);
    const object = value;
    const descriptorIsSensitive = hasSensitiveDescriptor(value);
    for (const key in object) {
        if (!Object.hasOwn(object, key))
            continue;
        if (state.remainingNodes === 0) {
            markObjectTruncated(output, state);
            break;
        }
        const entry = object[key];
        if (isSensitiveName(key) || (descriptorIsSensitive && DESCRIPTOR_VALUE_KEY_PATTERN.test(key))) {
            state.remainingNodes -= 1;
            state.redactedCount += 1;
            output[key] = REDACTED;
        }
        else {
            output[key] = visit(entry, depth + 1, state);
        }
    }
    return output;
}
export function isSensitiveName(value) {
    return SENSITIVE_KEY_PATTERN.test(value);
}
export function redactSensitive(value) {
    const state = {
        redactedCount: 0,
        remainingNodes: CANONICAL_NODE_LIMIT,
        truncated: false,
        markerEmitted: false,
    };
    const redacted = visit(value, 0, state);
    return { value: redacted, redactedCount: state.redactedCount, truncated: state.truncated };
}
