import { isSensitiveName } from './redact.js';
const DEFAULT_TEXT_LIMIT = 1_000;
const DYNAMIC_NAME_LIMIT = 200;
const STATUS_LIMIT = 64;
const HEALTH_COMPONENT_LIMIT = 200;
const HEALTH_DEPTH_LIMIT = 6;
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function text(value, max = DEFAULT_TEXT_LIMIT) {
    if (typeof value !== 'string')
        return undefined;
    return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
function dynamicName(value) {
    return text(value, DYNAMIC_NAME_LIMIT) ?? '';
}
function stringList(value, maxItems = 20) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((entry) => typeof entry === 'string' ? [text(entry, 200) ?? ''] : []).slice(0, maxItems);
}
function contexts(payload) {
    const root = record(payload);
    const value = record(root?.contexts);
    if (value === undefined)
        return [];
    return Object.entries(value).flatMap(([id, entry]) => {
        const context = record(entry);
        return context === undefined ? [] : [[dynamicName(id), context]];
    });
}
function searchable(item) {
    return JSON.stringify(item).toLowerCase();
}
function listResult(target, statusCode, query, items, limit, redactedCount, sourceTruncated) {
    return {
        target,
        statusCode,
        query,
        total: items.length,
        returned: Math.min(items.length, limit),
        truncated: sourceTruncated || items.length > limit,
        sourceTruncated,
        redactedCount,
        items: items.slice(0, limit),
    };
}
function mappingItem(context, dispatcher, value) {
    const details = record(value.details);
    const handlerMethod = record(details?.handlerMethod);
    const conditions = record(details?.requestMappingConditions);
    const item = { context, dispatcher };
    const fields = [
        ['predicate', text(value.predicate)],
        ['handler', text(value.handler)],
        ['controller', text(handlerMethod?.className)],
        ['method', text(handlerMethod?.name)],
    ];
    for (const [key, field] of fields)
        if (field !== undefined)
            item[key] = field;
    const methods = stringList(conditions?.methods);
    const patterns = stringList(conditions?.patterns);
    if (methods.length > 0)
        item.httpMethods = methods;
    if (patterns.length > 0)
        item.patterns = patterns;
    return item;
}
function appendDispatcher(path, key) {
    const segment = dynamicName(key);
    return dynamicName(path === '' ? segment : `${path}.${segment}`);
}
function walkMappings(node, context, path, output, depth = 0) {
    if (depth > 12 || output.length >= 10_000)
        return;
    if (Array.isArray(node)) {
        for (const entry of node) {
            const candidate = record(entry);
            if (candidate !== undefined && (typeof candidate.predicate === 'string' || typeof candidate.handler === 'string')) {
                output.push(mappingItem(context, path, candidate));
            }
            else {
                walkMappings(entry, context, path, output, depth + 1);
            }
        }
        return;
    }
    const object = record(node);
    if (object === undefined)
        return;
    for (const [key, entry] of Object.entries(object)) {
        walkMappings(entry, context, appendDispatcher(path, key), output, depth + 1);
    }
}
function healthStatus(value) {
    return text(value, STATUS_LIMIT) ?? null;
}
function healthComponents(value, depth, budget) {
    const components = record(value);
    if (components === undefined)
        return [];
    const entries = Object.entries(components);
    if (depth >= HEALTH_DEPTH_LIMIT) {
        if (entries.length > 0)
            budget.truncated = true;
        return [];
    }
    const output = [];
    for (const [name, rawComponent] of entries) {
        if (budget.remaining === 0) {
            budget.truncated = true;
            break;
        }
        budget.remaining -= 1;
        budget.returned += 1;
        const component = record(rawComponent);
        const item = {
            name: dynamicName(name),
            status: healthStatus(component?.status),
        };
        const children = healthComponents(component?.components, depth + 1, budget);
        if (children.length > 0)
            item.components = children;
        output.push(item);
    }
    return output;
}
export function projectHealth(payload, target, statusCode, redactedCount, sourceTruncated = false) {
    const root = record(payload);
    const budget = {
        remaining: HEALTH_COMPONENT_LIMIT,
        returned: 0,
        truncated: false,
    };
    const status = healthStatus(root?.status);
    const health = {
        status,
        components: healthComponents(root?.components, 0, budget),
        returnedComponents: budget.returned,
        truncated: sourceTruncated || budget.truncated,
    };
    return { target, statusCode, status, health, redactedCount, sourceTruncated };
}
export function projectMappings(payload, target, statusCode, query, limit, redactedCount, sourceTruncated = false) {
    const needle = query.toLowerCase();
    const items = [];
    for (const [contextId, context] of contexts(payload)) {
        if (context.mappings !== undefined)
            walkMappings(context.mappings, contextId, '', items);
    }
    return listResult(target, statusCode, query, items.filter((item) => searchable(item).includes(needle)), limit, redactedCount, sourceTruncated);
}
export function projectBeans(payload, target, statusCode, query, limit, redactedCount, sourceTruncated = false) {
    const needle = query.toLowerCase();
    const items = [];
    for (const [contextId, context] of contexts(payload)) {
        const beans = record(context.beans);
        if (beans === undefined)
            continue;
        for (const [name, rawBean] of Object.entries(beans)) {
            const bean = record(rawBean);
            if (bean === undefined)
                continue;
            const item = { context: contextId, name: dynamicName(name) };
            const fields = [
                ['type', text(bean.type)],
                ['scope', text(bean.scope)],
                ['resource', text(bean.resource)],
            ];
            for (const [key, field] of fields)
                if (field !== undefined)
                    item[key] = field;
            const aliases = stringList(bean.aliases);
            const dependencies = stringList(bean.dependencies, 50);
            if (aliases.length > 0)
                item.aliases = aliases;
            if (dependencies.length > 0)
                item.dependencies = dependencies;
            if (searchable(item).includes(needle))
                items.push(item);
        }
    }
    return listResult(target, statusCode, query, items, limit, redactedCount, sourceTruncated);
}
function conditionItems(contextId, outcome, matches) {
    const groups = record(matches);
    if (groups === undefined)
        return [];
    const output = [];
    for (const [configuration, rawEntries] of Object.entries(groups)) {
        if (!Array.isArray(rawEntries))
            continue;
        for (const rawEntry of rawEntries) {
            const entry = record(rawEntry);
            if (entry === undefined)
                continue;
            const item = { context: contextId, configuration: dynamicName(configuration), outcome };
            const condition = text(entry.condition);
            const message = text(entry.message, 2_000);
            if (condition !== undefined)
                item.condition = condition;
            if (message !== undefined)
                item.message = message;
            output.push(item);
        }
    }
    return output;
}
export function projectConditions(payload, target, statusCode, query, outcome, limit, redactedCount, sourceTruncated = false) {
    const needle = query.toLowerCase();
    const items = [];
    for (const [contextId, context] of contexts(payload)) {
        if (outcome !== 'negative')
            items.push(...conditionItems(contextId, 'positive', context.positiveMatches));
        if (outcome !== 'positive')
            items.push(...conditionItems(contextId, 'negative', context.negativeMatches));
    }
    const filtered = needle === '' ? items : items.filter((item) => searchable(item).includes(needle));
    return listResult(target, statusCode, query, filtered, limit, redactedCount, sourceTruncated);
}
export function projectMetric(payload, target, statusCode, redactedCount, sourceTruncated = false) {
    const root = record(payload);
    if (root === undefined)
        throw new Error(`Spring Actuator metric response for target "${target}" is not an object`);
    const metric = { target, statusCode, redactedCount, sourceTruncated };
    const fields = [
        ['name', text(root.name, DYNAMIC_NAME_LIMIT)],
        ['description', text(root.description, 2_000)],
        ['baseUnit', text(root.baseUnit, DYNAMIC_NAME_LIMIT)],
    ];
    for (const [key, field] of fields)
        if (field !== undefined)
            metric[key] = field;
    metric.measurements = Array.isArray(root.measurements)
        ? root.measurements.flatMap((rawMeasurement) => {
            const measurement = record(rawMeasurement);
            if (measurement === undefined)
                return [];
            const statistic = text(measurement.statistic, DYNAMIC_NAME_LIMIT);
            const value = measurement.value;
            if (statistic === undefined || typeof value !== 'number')
                return [];
            return [{ statistic, value }];
        }).slice(0, 100)
        : [];
    metric.availableTags = Array.isArray(root.availableTags)
        ? root.availableTags.flatMap((rawTag) => {
            const tag = record(rawTag);
            const rawName = tag?.tag;
            const name = text(rawName, DYNAMIC_NAME_LIMIT);
            if (name === undefined)
                return [];
            return [{ tag: name, values: typeof rawName === 'string' && isSensitiveName(rawName) ? [] : stringList(tag?.values, 100) }];
        }).slice(0, 100)
        : [];
    return metric;
}
