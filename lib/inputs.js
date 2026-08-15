function objectArgs(value, allowed) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new TypeError('tool arguments must be an object');
    const args = value;
    const unknown = Object.keys(args).find((key) => !allowed.includes(key));
    if (unknown !== undefined)
        throw new TypeError(`unknown tool argument "${unknown}"`);
    return args;
}
function requiredString(args, key, maxLength) {
    const value = args[key];
    if (typeof value !== 'string' || value.trim() === '')
        throw new TypeError(`"${key}" must be a non-empty string`);
    if (value.length > maxLength)
        throw new TypeError(`"${key}" must be at most ${maxLength} characters`);
    return value.trim();
}
function optionalString(args, key, maxLength) {
    const value = args[key];
    if (value === undefined)
        return '';
    if (typeof value !== 'string')
        throw new TypeError(`"${key}" must be a string`);
    if (value.length > maxLength)
        throw new TypeError(`"${key}" must be at most ${maxLength} characters`);
    return value.trim();
}
function limit(args, defaultLimit, maxLimit) {
    const value = args.limit;
    if (value === undefined)
        return defaultLimit;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maxLimit) {
        throw new TypeError(`"limit" must be an integer between 1 and ${maxLimit}`);
    }
    return value;
}
export function parseTargetArgs(value) {
    const args = objectArgs(value, ['target']);
    return { target: requiredString(args, 'target', 64) };
}
export function parseSearchArgs(value, defaultLimit, maxLimit) {
    const args = objectArgs(value, ['target', 'query', 'limit']);
    return {
        target: requiredString(args, 'target', 64),
        query: requiredString(args, 'query', 200),
        limit: limit(args, defaultLimit, maxLimit),
    };
}
export function parseConditionArgs(value, defaultLimit, maxLimit) {
    const args = objectArgs(value, ['target', 'query', 'outcome', 'limit']);
    const outcome = args.outcome ?? 'all';
    if (outcome !== 'positive' && outcome !== 'negative' && outcome !== 'all') {
        throw new TypeError('"outcome" must be positive, negative, or all');
    }
    return {
        target: requiredString(args, 'target', 64),
        query: optionalString(args, 'query', 200),
        outcome,
        limit: limit(args, defaultLimit, maxLimit),
    };
}
export function parseMetricArgs(value) {
    const args = objectArgs(value, ['target', 'metric', 'tags']);
    const rawTags = args.tags ?? [];
    if (!Array.isArray(rawTags) || rawTags.length > 20 || rawTags.some((tag) => typeof tag !== 'string' || tag.length < 3 || tag.length > 200 || !tag.includes(':'))) {
        throw new TypeError('"tags" must contain at most 20 key:value strings');
    }
    const metric = requiredString(args, 'metric', 200);
    if (metric === '.' || metric === '..' || !/^[A-Za-z0-9._-]+$/.test(metric)) {
        throw new TypeError('"metric" contains unsupported characters');
    }
    return {
        target: requiredString(args, 'target', 64),
        metric,
        tags: rawTags,
    };
}
