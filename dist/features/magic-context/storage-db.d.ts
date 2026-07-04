import { Database } from "../../shared/sqlite";
import { ensureColumn, healAllNullColumns } from "./storage-schema-helpers";
export { ensureColumn, healAllNullColumns };
export declare function getSchemaFenceRejection(): {
    persistedVersion: number;
    supportedVersion: number;
} | null;
export declare const LATEST_SUPPORTED_VERSION = 49;
export interface OpenDatabaseOptions {
    dbPath?: string;
    latestSupportedVersion?: number;
}
export declare function resolveDatabasePath(dbPathOverride?: string): {
    dbDir: string;
    dbPath: string;
};
export declare function getDatabasePath(db: Database): string | null;
export declare function getPersistedSchemaVersion(db: Database): number;
export declare function schemaVersionIsSupported(db: Database, latestSupportedVersion?: number): boolean;
export declare function enforceSchemaFence(db: Database, dbPath: string, latestSupportedVersion: number): boolean;
export declare function setSqlitePragmaConfig(config: {
    cacheSizeMb: number;
    mmapSizeMb: number;
}): void;
/**
 * Apply the tunable per-connection PRAGMAs (cache_size, mmap_size,
 * analysis_limit) from the current `sqlitePragmaConfig`. Idempotent and safe on
 * an already-open connection — cache_size/mmap_size take effect immediately —
 * so harnesses that open the DB before loading config (Pi) can call this once
 * config is available without reopening.
 */
export declare function applySqliteTuningPragmas(db: Database): void;
/**
 * Run SQLite's self-gating planner-stats refresh. `analysis_limit=400` caps the
 * rows sampled per index so even a huge table can't cause a multi-second
 * ANALYZE; `optimize` then re-analyzes only tables whose row counts drifted
 * since the last ANALYZE (a no-op otherwise). Cheap to call periodically.
 */
export declare function runSqliteOptimize(db: Database): void;
export declare function initializeDatabase(db: Database): void;
/**
 * Open the persistent Magic Context SQLite database.
 *
 * Fails closed: if the database cannot be opened (binary ABI mismatch,
 * unwritable path, corrupted file, etc.), this throws. Magic Context CANNOT
 * silently fall back to an in-memory database, because:
 *   1. An in-memory DB has no project memories, no historian state, no
 *      tag persistence — features that depend on durable storage become
 *      silently broken instead of explicitly disabled.
 *   2. More importantly, an in-memory DB across process restarts effectively
 *      means "no Magic Context", but the plugin still tags messages and
 *      tries to drive transforms. On Pi/OpenCode this can let the full
 *      raw history reach the model and overflow the context window — the
 *      exact failure mode that broke a real test session.
 *
 * Two failure modes, both fail-closed:
 *   - **Schema fence** (the on-disk DB is newer than this binary supports, e.g.
 *     a stale process after a rolling upgrade): returns `null`. This is an
 *     expected, recoverable condition (restart onto the newer binary), so it is
 *     not exceptional.
 *   - **Fatal open error** (ABI mismatch, unwritable path, corrupt file):
 *     throws. The thrown message carries the failure detail for surfacing.
 *
 * The return type is therefore `Database | null`, and callers MUST both
 * null-check the result AND be prepared for a throw (typically a try/catch that
 * also treats a null result as "storage unavailable"). On either outcome the
 * caller disables Magic Context for that run (server plugin: registers a
 * startup warning + skips the runtime; Pi plugin: logs warning + skips the
 * extension). There is NEVER a silent in-memory fallback.
 */
export declare function openDatabase(): Database | null;
export declare function openDatabase(dbPath: string): Database | null;
export declare function openDatabase(options: OpenDatabaseOptions): Database | null;
export declare function isDatabasePersisted(db: Database | null): boolean;
export declare function getDatabasePersistenceError(db: Database | null): string | null;
export declare function closeDatabase(): void;
export type ContextDatabase = Database;
//# sourceMappingURL=storage-db.d.ts.map