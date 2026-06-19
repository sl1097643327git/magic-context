/**
 * In-memory migration of the legacy v1 dreamer config shape to the Dreamer v2
 * per-task shape (shared OpenCode + Pi; runs on every config load, like
 * migrate-experimental). Doctor performs the on-disk equivalent.
 *
 * v1 shape (any subset):
 *   dreamer: {
 *     schedule: "02:00-06:00",            // a TIME WINDOW
 *     tasks: ["consolidate","verify"],    // an ARRAY of agentic task names
 *     task_timeout_minutes: 20,
 *     max_runtime_minutes: 120,
 *     user_memories: { enabled, promotion_threshold },
 *     pin_key_files: { enabled, token_budget, min_reads },
 *   }
 *
 * v2 shape:
 *   dreamer: {
 *     tasks: { <task>: { schedule: "<cron>"|"", model?, timeout_minutes?, ... } }
 *   }
 *
 * Rules (see dreamer-v2-AB-spec.md):
 *  - Base cron derived from the WINDOW START: "02:00-06:00" → "0 2 * * *".
 *  - Legacy `tasks` array PRESENT → it is the user's deliberate selection: each
 *    LISTED agentic task gets the base cron; each OMITTED canonical task gets ""
 *    (disabled). Built-in defaults are used ONLY when `tasks` is absent.
 *  - user_memories.enabled false → review-user-memories "" ; true → base cron
 *    (promotion_threshold carried). Same for pin_key_files → key-files.
 *  - evaluate-smart-notes → base cron (it always ran on pending notes).
 *  - task_timeout_minutes → each task's timeout_minutes default; max_runtime_minutes dropped.
 *  - Idempotent: if dreamer.tasks is already an OBJECT (v2), do nothing.
 */

const AGENTIC = ["consolidate", "verify", "archive-stale", "improve", "maintain-docs"] as const;
const DEFAULT_BASE_CRON = "0 2 * * *"; // matches the historical "02:00-06:00" default window start

/** "02:00-06:00" → "0 2 * * *". Falls back to the default base cron on any
 *  unparseable window (never throws — config migration is fail-open). */
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

export function migrateDreamerV2(
    rawConfig: Record<string, unknown>,
    warnings: string[],
): Record<string, unknown> {
    const dreamer = asObject(rawConfig.dreamer);
    if (!dreamer) return rawConfig;

    // Idempotent: v2 already has `tasks` as an OBJECT. A v1 `tasks` is an ARRAY.
    if (asObject(dreamer.tasks)) return rawConfig;

    // Nothing legacy to migrate (no window/array/blocks) → leave as-is; the
    // schema default fills `tasks`.
    const hasLegacy =
        "schedule" in dreamer ||
        Array.isArray(dreamer.tasks) ||
        "user_memories" in dreamer ||
        "pin_key_files" in dreamer ||
        "task_timeout_minutes" in dreamer ||
        "max_runtime_minutes" in dreamer;
    if (!hasLegacy) return rawConfig;

    const baseCron = windowToCron(dreamer.schedule);
    const timeout =
        typeof dreamer.task_timeout_minutes === "number" ? dreamer.task_timeout_minutes : undefined;
    const withTimeout = <T extends Record<string, unknown>>(entry: T): T =>
        timeout !== undefined ? { ...entry, timeout_minutes: timeout } : entry;

    const tasks: Record<string, Record<string, unknown>> = {};

    // Agentic tasks: array present → listed-on / omitted-off; array absent →
    // historical defaults (the 4 v1-default tasks on, maintain-docs off).
    const legacyArray = Array.isArray(dreamer.tasks)
        ? (dreamer.tasks as unknown[]).filter((t): t is string => typeof t === "string")
        : null;
    for (const task of AGENTIC) {
        let schedule: string;
        if (legacyArray) {
            schedule = legacyArray.includes(task) ? baseCron : "";
        } else {
            // No explicit selection → preserve v1 default suite (maintain-docs was
            // not in the default list).
            schedule = task === "maintain-docs" ? "" : baseCron;
        }
        tasks[task] = withTimeout({ schedule });
    }

    // evaluate-smart-notes always ran post-suite on pending notes.
    tasks["evaluate-smart-notes"] = withTimeout({ schedule: baseCron });

    // review-user-memories ← user_memories block (default enabled in v1).
    const um = asObject(dreamer.user_memories);
    const umEnabled = um ? um.enabled !== false : true;
    tasks["review-user-memories"] = withTimeout({
        schedule: umEnabled ? baseCron : "",
        ...(um && typeof um.promotion_threshold === "number"
            ? { promotion_threshold: um.promotion_threshold }
            : {}),
    });

    // key-files ← pin_key_files block (default DISABLED in v1).
    const pkf = asObject(dreamer.pin_key_files);
    const pkfEnabled = pkf ? pkf.enabled === true : false;
    tasks["key-files"] = withTimeout({
        schedule: pkfEnabled ? baseCron : "",
        ...(pkf && typeof pkf.token_budget === "number" ? { token_budget: pkf.token_budget } : {}),
        ...(pkf && typeof pkf.min_reads === "number" ? { min_reads: pkf.min_reads } : {}),
    });

    // Build the new dreamer block: keep agent-config keys (model, disable, etc.),
    // drop the retired scheduling keys, add the tasks record.
    const {
        schedule: _schedule,
        tasks: _tasks,
        task_timeout_minutes: _tto,
        max_runtime_minutes: _max,
        user_memories: _um,
        pin_key_files: _pkf,
        ...rest
    } = dreamer;

    warnings.push(
        'Migrated legacy dreamer scheduling (schedule window / tasks array / user_memories / pin_key_files) → per-task "dreamer.tasks" in-memory (run `doctor` to persist).',
    );

    return { ...rawConfig, dreamer: { ...rest, tasks } };
}
