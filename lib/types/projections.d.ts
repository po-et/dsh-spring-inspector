import type { JsonObject, JsonValue, ListResult } from './types.js';
export declare function projectHealth(payload: JsonValue, target: string, statusCode: number, redactedCount: number, sourceTruncated?: boolean): JsonObject;
export declare function projectMappings(payload: JsonValue, target: string, statusCode: number, query: string, limit: number, redactedCount: number, sourceTruncated?: boolean): ListResult;
export declare function projectBeans(payload: JsonValue, target: string, statusCode: number, query: string, limit: number, redactedCount: number, sourceTruncated?: boolean): ListResult;
export declare function projectConditions(payload: JsonValue, target: string, statusCode: number, query: string, outcome: 'positive' | 'negative' | 'all', limit: number, redactedCount: number, sourceTruncated?: boolean): ListResult;
export declare function projectMetric(payload: JsonValue, target: string, statusCode: number, redactedCount: number, sourceTruncated?: boolean): JsonObject;
