import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { InspectorConfig } from './types.js';
export declare const name = "spring-inspector";
export declare const inject: string[];
export interface Config extends InspectorConfig {
}
export declare const Config: Schema<Config>;
export declare function apply(ctx: Context, config: Config): void;
export type { InspectorConfig, JsonValue, TargetConfig } from './types.js';
