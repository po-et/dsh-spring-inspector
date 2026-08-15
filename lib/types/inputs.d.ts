export declare function parseTargetArgs(value: unknown): {
    target: string;
};
export declare function parseSearchArgs(value: unknown, defaultLimit: number, maxLimit: number): {
    target: string;
    query: string;
    limit: number;
};
export declare function parseConditionArgs(value: unknown, defaultLimit: number, maxLimit: number): {
    target: string;
    query: string;
    outcome: 'positive' | 'negative' | 'all';
    limit: number;
};
export declare function parseMetricArgs(value: unknown): {
    target: string;
    metric: string;
    tags: string[];
};
