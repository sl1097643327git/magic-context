import type { Database } from "../../shared/sqlite";
export declare function executeStatus(db: Database, sessionId: string, protectedTags: number, executeThresholdPercentageConfig?: number | {
    default: number;
    [modelKey: string]: number;
}, liveModelKey?: string, historyBudgetPercentage?: number, commitClusterTrigger?: {
    enabled: boolean;
    min_clusters: number;
}, executeThresholdTokens?: {
    default?: number;
    [modelKey: string]: number | undefined;
}, contextLimit?: number): string;
//# sourceMappingURL=execute-status.d.ts.map