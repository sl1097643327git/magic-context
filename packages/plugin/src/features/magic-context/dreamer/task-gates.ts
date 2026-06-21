import type { Database } from "../../../shared/sqlite";
import { getPendingSmartNotes } from "../storage-notes";
import { getUserMemoryCandidates } from "../user-memory/storage-user-memory";
import type { DreamTaskName } from "./task-registry";

/**
 * Per-task activity gates (Dreamer v2 A+B). A due task runs ONLY if its gate
 * passes, so cron cadence never burns a 60-turn agentic loop on an unchanged
 * pool. Gates are conservative — allow when uncertain — and cheap (count
 * queries, no full-row loads, no LLM).
 *
 * `lastRunAt` is the task's own `task_schedule_state.last_run_at` (null = never
 * run → treat "changed since" gates as "is there anything at all").
 */

export interface TaskGateContext {
    db: Database;
    projectIdentity: string;
    lastRunAt: number | null;
    /** retrospective content watermark (max message ts scanned). Distinct from
     *  lastRunAt: a session updated mid-run is newer than its scanned content but
     *  older than the run-completion time, so gating on lastRunAt would skip it. */
    retrospectiveWatermarkMs?: number | null;
    /** review-user-memories: min candidate observations before a review is worthwhile. */
    promotionThreshold: number;
}

function countActiveMemories(db: Database, projectPath: string): number {
    const row = db
        .prepare<[string], { cnt: number }>(
            "SELECT COUNT(*) AS cnt FROM memories WHERE project_path = ? AND status IN ('active','permanent')",
        )
        .get(projectPath);
    return row?.cnt ?? 0;
}

function countCompartmentsSince(db: Database, projectPath: string, since: number): number {
    // Compartments are keyed by session_id; map to project via session_projects.
    const row = db
        .prepare<[string, number], { cnt: number }>(
            `SELECT COUNT(*) AS cnt
               FROM compartments c
               JOIN session_projects sp ON sp.session_id = c.session_id
              WHERE sp.project_path = ? AND c.created_at > ?`,
        )
        .get(projectPath, since);
    return row?.cnt ?? 0;
}

function countProjectSessionsSince(
    db: Database,
    projectPath: string,
    since: number | null,
): number {
    const row =
        since === null
            ? db
                  .prepare<[string], { cnt: number }>(
                      "SELECT COUNT(*) AS cnt FROM session_projects WHERE project_path = ?",
                  )
                  .get(projectPath)
            : db
                  .prepare<[string, number], { cnt: number }>(
                      "SELECT COUNT(*) AS cnt FROM session_projects WHERE project_path = ? AND updated_at > ?",
                  )
                  .get(projectPath, since);
    return row?.cnt ?? 0;
}

/**
 * Evaluate a task's activity gate. Returns true if the task has work to do.
 * Throwing DB errors propagate to the caller (a gate that can't read is a real
 * problem, not silently "no work").
 */
export function evaluateTaskGate(task: DreamTaskName, ctx: TaskGateContext): boolean {
    const { db, projectIdentity: project, lastRunAt } = ctx;
    switch (task) {
        case "verify":
            // The executor's file gate does the precise incremental partition; the
            // scheduler only avoids taking the memory lease when there is no pool.
            return countActiveMemories(db, project) > 0;

        case "verify-broad":
            // Broad re-verifies the WHOLE pool (incl. file-independent memories the
            // incremental gate skips) — only needs a non-empty pool to run.
            return countActiveMemories(db, project) > 0;

        case "curate":
            // Curate is whole-pool hygiene, but still needs an active pool before
            // taking the shared memory lease.
            return countActiveMemories(db, project) > 0;

        case "classify-memories":
            // Classification scores the active project memory pool directly. It has
            // no file gate, watermark, or completeness prerequisites.
            return countActiveMemories(db, project) > 0;

        case "retrospective":
            // Cheap pre-gate: any project session updated since the CONTENT
            // watermark (max message ts actually scanned), not lastRunAt — a
            // session updated mid-run would otherwise be skipped. The executor's
            // raw provider does the precise typed-user-message scan and bails
            // before any child session if empty. Never-run → "sessions exist".
            return countProjectSessionsSince(db, project, ctx.retrospectiveWatermarkMs ?? null) > 0;

        case "maintain-docs":
            // New compartments since the last maintain-docs run. Never-run → any exist.
            return countCompartmentsSince(db, project, lastRunAt ?? 0) > 0;

        case "evaluate-smart-notes":
            return getPendingSmartNotes(db, project).length > 0;

        case "review-user-memories":
            // Candidate observations are GLOBAL (cross-project user profile).
            return getUserMemoryCandidates(db).length >= ctx.promotionThreshold;

        case "key-files":
            // Permissive: the candidate scan needs the OpenCode DB (too heavy for a
            // per-tick gate). The task itself collects candidates and bails cheaply
            // before any LLM call when there aren't enough reads. Default schedule
            // is "" (off) anyway, so this gate runs only when explicitly enabled.
            return true;

        default: {
            const _exhaustive: never = task;
            return Boolean(_exhaustive);
        }
    }
}
