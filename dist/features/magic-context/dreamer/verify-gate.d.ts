import type { Database } from "../../../shared/sqlite";
import type { VerifyPromptMemory } from "./verify-prompt";
/**
 * Per-memory verify scope (DreamerV2 rework).
 *
 * Replaces the old GLOBAL commit-watermark + all-or-nothing coverage gate. Now
 * each memory carries its own `verified_at` (set by the verify apply), so:
 *  - partial progress STICKS: a timed-out verify banks the memories it checked;
 *    the next run skips them and continues (the cold-start trap is gone).
 *  - there is no watermark to advance and no coverage check.
 *
 * Scope = active memories that have a REAL backing-file mapping (recorded by the
 * map-memories backfill). Excluded:
 *  - file-independent memories (no-file sentinel) — they describe external
 *    behavior and cannot be checked against local code; curate + age decay own
 *    them.
 *  - unmapped memories — map-memories maps them first; once mapped they enter
 *    verify scope as never-verified (verified_at = 0).
 *
 * Modes:
 *  - `verify` (incremental, default): a candidate is in scope if it was never
 *    content-verified (verified_at = 0) OR any mapped file changed since THAT
 *    memory's verified_at (committed change-time newer, an uncommitted edit, or
 *    the file was deleted).
 *  - `verify-broad` (`forceBroad`): every candidate, regardless of change time —
 *    full-pool drift catching over the file-mapped memories.
 */
export interface VerifyGateResult {
    runStartedAt: number;
    mode: "non-git" | "full" | "broad" | "incremental";
    inScope: VerifyPromptMemory[];
    inScopeIds: number[];
    skippedIds: number[];
    reason: string;
}
export declare function partitionVerifyScope(args: {
    db: Database;
    projectIdentity: string;
    projectDirectory: string;
    forceBroad?: boolean;
    now?: number;
}): Promise<VerifyGateResult>;
//# sourceMappingURL=verify-gate.d.ts.map