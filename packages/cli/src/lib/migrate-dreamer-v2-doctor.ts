/**
 * On-disk Dreamer v2 migration for doctor (mirrors the plugin's in-memory
 * migrateDreamerV2). Converts the legacy v1 dreamer shape (window schedule, tasks
 * ARRAY, user_memories/pin_key_files blocks, task_timeout_minutes,
 * max_runtime_minutes) into the v2 per-task `tasks` RECORD.
 *
 * Operates in place on a comment-json-parsed config object. Returns true when it
 * mutated `mcConfig.dreamer`. Idempotent: a no-op when `tasks` is already an
 * object (v2) or when no legacy keys are present.
 *
 * Run AFTER the experimental→dreamer migration so a relocated
 * dreamer.user_memories / dreamer.pin_key_files is folded into the tasks record.
 */

const AGENTIC = ["consolidate", "verify", "archive-stale", "improve", "maintain-docs"] as const;
const DEFAULT_BASE_CRON = "0 2 * * *";

function windowToCron(schedule: unknown): string {
    if (typeof schedule !== "string") return DEFAULT_BASE_CRON;
    const m = /^(\d{1,2}):(\d{2})\s*-/.exec(schedule.trim());
    if (!m) return DEFAULT_BASE_CRON;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour >= 24 || minute >= 60) return DEFAULT_BASE_CRON;
    return `${minute} ${hour} * * *`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

export function migrateDreamerV2ForDoctor(mcConfig: Record<string, unknown>): boolean {
    const dreamer = asObject(mcConfig.dreamer);
    if (!dreamer) return false;

    // Idempotent: v2 already has tasks as an OBJECT (v1 had an ARRAY).
    if (asObject(dreamer.tasks)) return false;

    const hasLegacy =
        "schedule" in dreamer ||
        Array.isArray(dreamer.tasks) ||
        "user_memories" in dreamer ||
        "pin_key_files" in dreamer ||
        "task_timeout_minutes" in dreamer ||
        "max_runtime_minutes" in dreamer;
    if (!hasLegacy) return false;

    const baseCron = windowToCron(dreamer.schedule);
    const timeout =
        typeof dreamer.task_timeout_minutes === "number" ? dreamer.task_timeout_minutes : undefined;
    const withTimeout = (entry: Record<string, unknown>): Record<string, unknown> =>
        timeout !== undefined ? { ...entry, timeout_minutes: timeout } : entry;

    const tasks: Record<string, Record<string, unknown>> = {};

    const legacyArray = Array.isArray(dreamer.tasks)
        ? (dreamer.tasks as unknown[]).filter((t): t is string => typeof t === "string")
        : null;
    for (const task of AGENTIC) {
        const schedule = legacyArray
            ? legacyArray.includes(task)
                ? baseCron
                : ""
            : task === "maintain-docs"
              ? ""
              : baseCron;
        tasks[task] = withTimeout({ schedule });
    }

    tasks["evaluate-smart-notes"] = withTimeout({ schedule: baseCron });

    const um = asObject(dreamer.user_memories);
    const umEnabled = um ? um.enabled !== false : true;
    tasks["review-user-memories"] = withTimeout({
        schedule: umEnabled ? baseCron : "",
        ...(um && typeof um.promotion_threshold === "number"
            ? { promotion_threshold: um.promotion_threshold }
            : {}),
    });

    const pkf = asObject(dreamer.pin_key_files);
    const pkfEnabled = pkf ? pkf.enabled === true : false;
    tasks["key-files"] = withTimeout({
        schedule: pkfEnabled ? baseCron : "",
        ...(pkf && typeof pkf.token_budget === "number" ? { token_budget: pkf.token_budget } : {}),
        ...(pkf && typeof pkf.min_reads === "number" ? { min_reads: pkf.min_reads } : {}),
    });

    // Mutate in place: drop retired keys, keep agent-config keys, add tasks.
    delete dreamer.schedule;
    delete dreamer.task_timeout_minutes;
    delete dreamer.max_runtime_minutes;
    delete dreamer.user_memories;
    delete dreamer.pin_key_files;
    dreamer.tasks = tasks;
    mcConfig.dreamer = dreamer;
    return true;
}
