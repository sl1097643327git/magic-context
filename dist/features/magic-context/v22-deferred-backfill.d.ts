import type { Database } from "../../shared/sqlite";
export declare const BATCH_SIZE = 25;
export declare const YIELD_EVERY_N_ROWS = 5;
type V22BackfillStatus = "pending" | "completed" | "completed_with_failures" | "skipped";
interface LegacyMemoryRow {
    id: number;
    project_path: string;
    category: string;
    normalized_hash: string;
    seen_count: number;
}
export interface V22BackfillSummary {
    status: V22BackfillStatus;
    processedRows: number;
    changedRows: number;
    failedRows: number;
    failureCount: number;
    lastCursor: number;
}
export interface DeferredV22BackfillOptions {
    resolveIdentity?: (rawProjectPath: string) => string;
    yieldToEventLoop?: () => Promise<void>;
    onBatchResolved?: (batch: readonly LegacyMemoryRow[]) => void | Promise<void>;
}
export declare function computeLegacyRustDirIdentity(rawProjectPath: string): string;
export declare function getV22BackfillStatus(db: Database): {
    status: V22BackfillStatus | "missing";
    failureCount: number;
    cursor: number;
    maxLegacyMemoryId: number;
};
export declare function runDeferredV22Backfill(db: Database, options?: DeferredV22BackfillOptions): Promise<V22BackfillSummary>;
export declare function doctorRetryV22Backfill(db: Database): Promise<{
    attempted: number;
    succeeded: number;
    failed: number;
    skipped: number;
    status: V22BackfillStatus;
}>;
export declare function doctorRekeyV22DirIdentity(db: Database, rawProjectPath: string): Promise<{
    oldIdentity: string;
    newIdentity: string;
    changedRows: number;
}>;
export {};
//# sourceMappingURL=v22-deferred-backfill.d.ts.map