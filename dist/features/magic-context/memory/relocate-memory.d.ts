import type { Database } from "../../../shared/sqlite";
import type { MemoryStatus } from "./types";
/**
 * Memory relocation primitives shared by the v22 dir-identity backfill and the
 * `doctor migrate-session` command (re-homing a session to a different project).
 *
 * All operations are collision-aware against UNIQUE(project_path, category,
 * normalized_hash): the target identity may already hold an equivalent memory,
 * and a blind write there would abort the surrounding transaction. MUST run
 * inside a transaction.
 */
export interface RelocateMemorySelection {
    /** Status set to operate on. Archived memories are deliberately excluded by
     *  default — they are suppressed history, not injectable knowledge. */
    statuses?: MemoryStatus[];
    /** When set, restrict to memories whose `source_session_id` matches (the
     *  "only memories originated from this session" option). */
    sourceSessionId?: string;
}
/**
 * Resolve the memory ids under `fromProjectPath` that a relocation should act
 * on, honoring the status filter and the optional originator-session filter.
 */
export declare function selectRelocatableMemoryIds(db: Database, fromProjectPath: string, selection?: RelocateMemorySelection): number[];
/**
 * Collision-aware single-row rekey. If the target identity already holds an
 * equivalent memory (same category + normalized_hash), merge into it (keep the
 * larger seen_count, delete the source — embedding FK-cascades) instead of
 * aborting the transaction on the UNIQUE violation; otherwise do the guarded
 * UPDATE. Returns true if the row was rekeyed or merged. MUST run inside a
 * transaction.
 */
export declare function rekeyMemoryRowWithCollisionMerge(db: Database, rowId: number, fromProjectPath: string, toIdentity: string): boolean;
export interface RelocateResult {
    /** Rows rekeyed/inserted under the target identity. */
    relocated: number;
    /** Rows merged into a pre-existing equivalent at the target (move only). */
    merged: number;
    /** Rows skipped because an equivalent already existed at the target (copy only). */
    skipped: number;
}
/**
 * MOVE a set of memory ids from `fromProjectPath` to `toIdentity`. The source
 * project loses them. Collision-safe (merge into an existing equivalent at the
 * target). Embeddings follow automatically (memory_id is unchanged on a rekey,
 * FK-cascade on a merge-delete). MUST run inside a transaction.
 */
export declare function moveMemoriesToProject(db: Database, ids: number[], fromProjectPath: string, toIdentity: string): RelocateResult;
/**
 * COPY a set of memory ids under `toIdentity`, leaving the source rows intact.
 * Each copy gets a fresh id; its embedding (if any) is duplicated. Collision-safe
 * via INSERT OR IGNORE against the UNIQUE constraint — a row already present at
 * the target is skipped (no duplicate). `project_path` is overridden to the
 * target; all other columns (including source_session_id and timestamps) are
 * preserved for provenance. MUST run inside a transaction.
 */
export declare function copyMemoriesToProject(db: Database, ids: number[], toIdentity: string): RelocateResult;
//# sourceMappingURL=relocate-memory.d.ts.map