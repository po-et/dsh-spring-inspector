export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | {
    [key: string]: JsonValue;
};
export type JsonObject = {
    [key: string]: JsonValue;
};
export interface TargetConfig {
    id: string;
    actuatorUrl: string;
    authorizationRef?: string;
}
export interface InspectorConfig {
    targets: TargetConfig[];
    timeoutMs: number;
    maxResponseBytes: number;
    defaultLimit: number;
    maxLimit: number;
}
export interface NormalizedTarget {
    readonly id: string;
    readonly actuatorUrl: URL;
    readonly authorizationRef?: string;
}
export interface ListResult {
    target: string;
    statusCode: number;
    query: string;
    total: number;
    returned: number;
    truncated: boolean;
    sourceTruncated: boolean;
    redactedCount: number;
    items: JsonValue[];
}
export interface ActuatorResponse {
    statusCode: number;
    data: JsonValue;
    redactedCount: number;
    sourceTruncated: boolean;
}
export type AuthorizationResolver = (ref: string) => Promise<string | undefined>;
