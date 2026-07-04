export declare function isDreamerRunnable(config: {
    dreamer?: {
        disable?: boolean;
    } | null;
}): boolean;
export declare function isSidekickRunnable(config: {
    sidekick?: {
        disable?: boolean;
    } | null;
}): boolean;
export declare function isHistorianRunnable(config: {
    historian?: {
        disable?: boolean;
    } | null;
}): boolean;
export declare function migrateLegacyAgentEnabledInMemory(rawConfig: Record<string, unknown>, warnings: string[]): Record<string, unknown>;
//# sourceMappingURL=agent-disable.d.ts.map