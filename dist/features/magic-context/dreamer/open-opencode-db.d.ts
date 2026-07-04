import { Database } from "../../../shared/sqlite";
/**
 * Open OpenCode's DB read-only (used by the key-files task's read-history scan).
 * Returns null when absent or unopenable — callers degrade gracefully.
 */
export declare function openOpenCodeDb(): Database | null;
//# sourceMappingURL=open-opencode-db.d.ts.map