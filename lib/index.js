import Schema from '@deepseek-ai/schemastery';
import { ActuatorClient } from './client.js';
import { parseConditionArgs, parseMetricArgs, parseSearchArgs, parseTargetArgs } from './inputs.js';
import { projectBeans, projectConditions, projectHealth, projectMappings, projectMetric } from './projections.js';
import { normalizeTargets } from './security.js';
export const name = 'spring-inspector';
export const inject = ['tools'];
const MODEL_TEXT_MAX_BYTES = 262_144;
const TargetSchema = Schema.object({
    id: Schema.string().required(),
    actuatorUrl: Schema.string().required(),
    authorizationRef: Schema.string(),
});
export const Config = Schema.object({
    targets: Schema.array(TargetSchema).default([
        { id: 'local', actuatorUrl: 'http://127.0.0.1:8080/actuator' },
    ]),
    timeoutMs: Schema.number().step(1).min(100).max(30_000).default(5_000),
    maxResponseBytes: Schema.number().step(1).min(1_024).max(2_000_000).default(262_144),
    defaultLimit: Schema.number().step(1).min(1).max(100).default(25),
    maxLimit: Schema.number().step(1).min(1).max(500).default(100),
});
const TARGET_PARAMETERS = {
    type: 'object',
    additionalProperties: false,
    properties: {
        target: { type: 'string', description: 'Configured Spring application target id; runtime guard limits it to 64 characters.' },
    },
    required: ['target'],
};
function searchParameters(maxLimit) {
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            target: { type: 'string', description: 'Configured Spring application target id; runtime guard limits it to 64 characters.' },
            query: { type: 'string', description: 'Case-insensitive text to match; runtime guard limits it to 200 characters.' },
            limit: { type: 'integer', description: `Maximum rows to return (1-${maxLimit}); enforced by the runtime guard.` },
        },
        required: ['target', 'query'],
    };
}
const LIST_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        target: { type: 'string' },
        statusCode: { type: 'integer' },
        query: { type: 'string' },
        total: { type: 'integer' },
        returned: { type: 'integer' },
        truncated: { type: 'boolean' },
        sourceTruncated: { type: 'boolean' },
        redactedCount: { type: 'integer' },
        items: { type: 'array', items: {} },
    },
    required: ['target', 'statusCode', 'query', 'total', 'returned', 'truncated', 'sourceTruncated', 'redactedCount', 'items'],
    additionalProperties: false,
};
const HEALTH_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        target: { type: 'string' },
        statusCode: { type: 'integer' },
        status: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        health: {},
        sourceTruncated: { type: 'boolean' },
        redactedCount: { type: 'integer' },
    },
    required: ['target', 'statusCode', 'status', 'health', 'sourceTruncated', 'redactedCount'],
    additionalProperties: false,
};
const METRIC_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        target: { type: 'string' },
        statusCode: { type: 'integer' },
        name: { type: 'string' },
        description: { type: 'string' },
        baseUnit: { type: 'string' },
        measurements: { type: 'array', items: {} },
        availableTags: { type: 'array', items: {} },
        sourceTruncated: { type: 'boolean' },
        redactedCount: { type: 'integer' },
    },
    required: ['target', 'statusCode', 'measurements', 'availableTags', 'sourceTruncated', 'redactedCount'],
    additionalProperties: false,
};
function renderJson(_args, value) {
    const serialized = JSON.stringify(value) ?? 'null';
    const bytes = Buffer.byteLength(serialized);
    if (bytes <= MODEL_TEXT_MAX_BYTES) {
        return [{ type: 'text', text: serialized }];
    }
    return [{
            type: 'text',
            text: JSON.stringify({
                renderOmitted: true,
                reason: 'Canonical tool value exceeds the model text budget; narrow the query or lower the limit.',
                actualBytes: bytes,
                maxBytes: MODEL_TEXT_MAX_BYTES,
            }),
        }];
}
export function apply(ctx, config) {
    if (config.defaultLimit > config.maxLimit)
        throw new TypeError('defaultLimit must not exceed maxLimit');
    const targets = normalizeTargets(config.targets);
    const client = new ActuatorClient({
        targets,
        timeoutMs: config.timeoutMs,
        maxResponseBytes: config.maxResponseBytes,
        resolveAuthorization: async (ref) => {
            const credentials = ctx.get('credentials');
            if (credentials === undefined) {
                throw new Error(`credential service is unavailable for reference "${ref}"`);
            }
            return (await credentials.resolve(ref))?.value;
        },
    });
    const timeoutMs = config.timeoutMs + 1_000;
    const common = {
        timeoutMs,
    };
    const definitions = [
        {
            ...common,
            name: 'spring_health',
            description: 'Read a bounded status and component-status tree from a configured local Spring Boot Actuator target.',
            parameters: TARGET_PARAMETERS,
            output: { schema: HEALTH_OUTPUT_SCHEMA, render: renderJson },
            async execute(raw, exec) {
                const args = parseTargetArgs(raw);
                const response = await client.get(args.target, ['health'], exec.signal, undefined, [503]);
                return projectHealth(response.data, args.target, response.statusCode, response.redactedCount, response.sourceTruncated);
            },
        },
        {
            ...common,
            name: 'spring_route_search',
            description: 'Search bounded, structured Spring MVC/WebFlux mappings from a configured local Actuator target.',
            parameters: searchParameters(config.maxLimit),
            output: { schema: LIST_OUTPUT_SCHEMA, render: renderJson },
            async execute(raw, exec) {
                const args = parseSearchArgs(raw, config.defaultLimit, config.maxLimit);
                const response = await client.get(args.target, ['mappings'], exec.signal);
                return projectMappings(response.data, args.target, response.statusCode, args.query, args.limit, response.redactedCount, response.sourceTruncated);
            },
        },
        {
            ...common,
            name: 'spring_bean_search',
            description: 'Search bounded bean metadata from a configured local Spring Boot Actuator target.',
            parameters: searchParameters(config.maxLimit),
            output: { schema: LIST_OUTPUT_SCHEMA, render: renderJson },
            async execute(raw, exec) {
                const args = parseSearchArgs(raw, config.defaultLimit, config.maxLimit);
                const response = await client.get(args.target, ['beans'], exec.signal);
                return projectBeans(response.data, args.target, response.statusCode, args.query, args.limit, response.redactedCount, response.sourceTruncated);
            },
        },
        {
            ...common,
            name: 'spring_condition_report',
            description: 'Inspect bounded positive or negative auto-configuration condition matches on a local Actuator target.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    target: { type: 'string', description: 'Configured Spring application target id; runtime guard limits it to 64 characters.' },
                    query: { type: 'string', description: 'Optional case-insensitive text to match; runtime guard limits it to 200 characters.' },
                    outcome: { type: 'string', enum: ['positive', 'negative', 'all'], description: 'Condition outcome to include.' },
                    limit: { type: 'integer', description: `Maximum rows to return (1-${config.maxLimit}); enforced by the runtime guard.` },
                },
                required: ['target'],
            },
            output: { schema: LIST_OUTPUT_SCHEMA, render: renderJson },
            async execute(raw, exec) {
                const args = parseConditionArgs(raw, config.defaultLimit, config.maxLimit);
                const response = await client.get(args.target, ['conditions'], exec.signal);
                return projectConditions(response.data, args.target, response.statusCode, args.query, args.outcome, args.limit, response.redactedCount, response.sourceTruncated);
            },
        },
        {
            ...common,
            name: 'spring_metric_read',
            description: 'Read one named metric, with optional key:value tag filters, from a configured local Actuator target.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    target: { type: 'string', description: 'Configured Spring application target id; runtime guard limits it to 64 characters.' },
                    metric: {
                        type: 'string',
                        description: 'Metric name, for example jvm.memory.used; runtime guard enforces its 200-character safe-character policy.',
                    },
                    tags: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional key:value tag filters; runtime guard enforces at most 20 values of 3-200 characters.',
                    },
                },
                required: ['target', 'metric'],
            },
            output: { schema: METRIC_OUTPUT_SCHEMA, render: renderJson },
            async execute(raw, exec) {
                const args = parseMetricArgs(raw);
                const query = new URLSearchParams();
                for (const tag of args.tags)
                    query.append('tag', tag);
                const response = await client.get(args.target, ['metrics', args.metric], exec.signal, query);
                return projectMetric(response.data, args.target, response.statusCode, response.redactedCount, response.sourceTruncated);
            },
        },
    ];
    for (const definition of definitions)
        ctx.tools.register(definition);
}
