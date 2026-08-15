import type { ActuatorResponse, AuthorizationResolver, NormalizedTarget } from './types.js';
export interface ActuatorClientOptions {
    targets: readonly NormalizedTarget[];
    timeoutMs: number;
    maxResponseBytes: number;
    resolveAuthorization: AuthorizationResolver;
}
export declare class ActuatorClient {
    #private;
    constructor(options: ActuatorClientOptions);
    get(targetId: string, segments: readonly string[], signal: AbortSignal, query?: URLSearchParams, acceptedStatuses?: readonly number[]): Promise<ActuatorResponse>;
}
