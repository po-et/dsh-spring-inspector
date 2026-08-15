import type { NormalizedTarget, TargetConfig } from './types.js';
export declare function normalizeTargets(configured: readonly TargetConfig[]): readonly NormalizedTarget[];
export declare function endpointUrl(target: NormalizedTarget, segments: readonly string[], query?: URLSearchParams): URL;
