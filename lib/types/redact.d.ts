import type { JsonValue } from './types.js';
export declare const CANONICAL_NODE_LIMIT = 10000;
export interface RedactionResult {
    value: JsonValue;
    redactedCount: number;
    truncated: boolean;
}
export declare function isSensitiveName(value: string): boolean;
export declare function redactSensitive(value: unknown): RedactionResult;
