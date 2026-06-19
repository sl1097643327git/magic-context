import type { Database } from "../../../shared/sqlite";

/**
 * Per-task dreamer scheduling state (Dreamer v2). One row per (project, task):
 * when it last ran, when it's next due, and its last outcome. Replaces the
 * project-level `dream_queue` + the single `last_dream_at:<project>` key — drains
 * run straight off this table + keyed leases (see lease.ts).
 *
 * Project-scoped, NOT session-scoped → intentionally absent from clearSession().
 */

export interface TaskScheduleStateRow {
    projectPath: string;
    task: string;
    /** Epoch ms of the last actual run (success or fail). null = never run. */
    lastRunAt: number | null;
    /** Epoch ms of the next scheduled fire. null = never due (disabled / impossible cron). */
    nextDueAt: number | null;
    /** The cron `schedule` string `next_due_at` was last computed FROM. The
     *  scheduler reconciles this against the live config each pass: when the
     *  config schedule differs, `next_due_at` is recomputed so config is always
     *  authoritative (a disabled/enabled/changed task takes effect immediately,
     *  not only after the stale slot fires once). null on legacy rows. */
    schedule: string | null;
    lastStatus: "completed" | "failed" | "skipped" | null;
    lastError: string | null;
    retryCount: number;
}

interface RawRow {
    project_path: string;
    task: string;
    last_run_at: number | null;
    next_due_at: number | null;
    schedule: string | null;
    last_status: string | null;
    last_error: string | null;
    retry_count: number | null;
}

function toRow(r: RawRow): TaskScheduleStateRow {
    return {
        projectPath: r.project_path,
        task: r.task,
        lastRunAt: r.last_run_at,
        nextDueAt: r.next_due_at,
        schedule: r.schedule ?? null,
        lastStatus: (r.last_status as TaskScheduleStateRow["lastStatus"]) ?? null,
        lastError: r.last_error,
        retryCount: r.retry_count ?? 0,
    };
}

export function getTaskScheduleState(
    db: Database,
    projectPath: string,
    task: string,
): TaskScheduleStateRow | null {
    const row = db
        .prepare<[string, string], RawRow>(
            "SELECT project_path, task, last_run_at, next_due_at, schedule, last_status, last_error, retry_count FROM task_schedule_state WHERE project_path = ? AND task = ?",
        )
        .get(projectPath, task);
    return row ? toRow(row) : null;
}

export function getTaskScheduleStatesForProject(
    db: Database,
    projectPath: string,
): TaskScheduleStateRow[] {
    return db
        .prepare<[string], RawRow>(
            "SELECT project_path, task, last_run_at, next_due_at, schedule, last_status, last_error, retry_count FROM task_schedule_state WHERE project_path = ? ORDER BY task",
        )
        .all(projectPath)
        .map(toRow);
}

/**
 * Idempotent first-seed: insert the row only if absent. Concurrent processes can
 * both call this safely — ON CONFLICT DO NOTHING means the first writer wins and
 * the second is a no-op (both compute the same next_due_at from the same cron).
 */
export function seedTaskScheduleState(
    db: Database,
    projectPath: string,
    task: string,
    nextDueAt: number | null,
    lastRunAt: number | null,
    schedule: string,
): void {
    db.prepare(
        "INSERT INTO task_schedule_state (project_path, task, last_run_at, next_due_at, schedule, last_status, last_error, retry_count) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0) ON CONFLICT(project_path, task) DO NOTHING",
    ).run(projectPath, task, lastRunAt, nextDueAt, schedule);
}

/** Full upsert of a row's schedule fields (used on run completion / gate-skip /
 *  retry advancement / schedule reconciliation). Callers that read-then-write
 *  should wrap in BEGIN IMMEDIATE; run-completion writes are already
 *  single-writer under the domain lease. */
export function writeTaskScheduleState(db: Database, row: TaskScheduleStateRow): void {
    db.prepare(
        `INSERT INTO task_schedule_state
           (project_path, task, last_run_at, next_due_at, schedule, last_status, last_error, retry_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_path, task) DO UPDATE SET
           last_run_at = excluded.last_run_at,
           next_due_at = excluded.next_due_at,
           schedule    = excluded.schedule,
           last_status = excluded.last_status,
           last_error  = excluded.last_error,
           retry_count = excluded.retry_count`,
    ).run(
        row.projectPath,
        row.task,
        row.lastRunAt,
        row.nextDueAt,
        row.schedule,
        row.lastStatus,
        row.lastError,
        row.retryCount,
    );
}
