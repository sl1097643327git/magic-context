import type { Database } from "../../shared/sqlite";
/**
 * Run `fn` inside a `BEGIN IMMEDIATE` transaction, committing on success and
 * rolling back on throw. Used by the in-session ctx_memory mutation actions so
 * a memory write + its mutation-log row commit atomically.
 */
export declare function runImmediateTransaction<T>(db: Database, fn: () => T): T;
//# sourceMappingURL=verification-recording.d.ts.map