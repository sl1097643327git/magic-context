/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { insertMemory } from "../memory/storage-memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { acquireLease } from "./lease";
import { setDreamState } from "./storage-dream-state";
import { getTaskScheduleState, writeTaskScheduleState } from "./storage-task-schedule";
import { leaseKeyFor } from "./task-registry";
import {
    type DreamTaskRuntimeConfig,
    planDueTasks,
    runDueTasksForProject,
    runManualDream,
    type TaskExecOutcome,
} from "./task-scheduler";

let db: Database | null = null;
afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function freshDb(): Database {
    const d = new Database(":memory:");
    initializeDatabase(d);
    runMigrations(d);
    return d;
}

const PROJECT = "git:abc";

function cfg(
    task: DreamTaskRuntimeConfig["task"],
    schedule: string,
    extra: Partial<DreamTaskRuntimeConfig> = {},
): DreamTaskRuntimeConfig {
    return { task, schedule, timeoutMinutes: 20, ...extra };
}

/** Give a project active memories so memory-domain gates pass. */
let memorySeq = 0;
function seedActiveMemory(d: Database, project = PROJECT): void {
    memorySeq += 1;
    insertMemory(d, {
        projectPath: project,
        category: "PROJECT_RULES",
        content: `mem-${memorySeq}`,
    });
}

describe("task-scheduler — planDueTasks", () => {
    it("first-seed does NOT fire immediately (next_due in the future)", () => {
        db = freshDb();
        const now = Date.UTC(2026, 0, 1, 12, 0); // midday
        const due = planDueTasks(db, PROJECT, [cfg("consolidate", "0 3 * * *")], now);
        expect(due).toHaveLength(0);
        // A row was seeded with a future next_due.
        const state = getTaskScheduleState(db, PROJECT, "consolidate");
        expect(state?.nextDueAt).not.toBeNull();
        expect(state?.nextDueAt).toBeGreaterThan(now);
    });

    it("seeds last_run_at from legacy last_dream_at (no full historical pass)", () => {
        db = freshDb();
        setDreamState(db, `last_dream_at:${PROJECT}`, "555000");
        planDueTasks(db, PROJECT, [cfg("consolidate", "0 3 * * *")], Date.now());
        expect(getTaskScheduleState(db, PROJECT, "consolidate")?.lastRunAt).toBe(555000);
    });

    it("disabled schedule ('') seeds a NULL-due row that is never due", () => {
        db = freshDb();
        const due = planDueTasks(db, PROJECT, [cfg("maintain-docs", "")], Date.now());
        expect(due).toHaveLength(0);
        expect(getTaskScheduleState(db, PROJECT, "maintain-docs")?.nextDueAt).toBeNull();
    });

    it("a past next_due_at is collected as due", () => {
        db = freshDb();
        // Seed then force the row's next_due into the past.
        const now = Date.now();
        planDueTasks(db, PROJECT, [cfg("consolidate", "0 3 * * *")], now);
        writeTaskScheduleState(db, {
            projectPath: PROJECT,
            task: "consolidate",
            lastRunAt: null,
            nextDueAt: now - 1000,
            schedule: "0 3 * * *",
            lastStatus: null,
            lastError: null,
            retryCount: 0,
        });
        const due = planDueTasks(db, PROJECT, [cfg("consolidate", "0 3 * * *")], now);
        expect(due.map((d) => d.config.task)).toEqual(["consolidate"]);
    });

    // ── Config-authoritative reconciliation (Oracle P0 #1) ──────────────
    it("disabling a task AFTER it was seeded forces next_due_at NULL (no stale fire)", () => {
        db = freshDb();
        const now = Date.now();
        // Seed enabled, force it due.
        planDueTasks(db, PROJECT, [cfg("consolidate", "0 3 * * *")], now);
        forceDue(db, "consolidate", now);
        // Now the config disables it. The stale past-due slot must NOT fire.
        const due = planDueTasks(db, PROJECT, [cfg("consolidate", "")], now);
        expect(due).toHaveLength(0);
        expect(getTaskScheduleState(db, PROJECT, "consolidate")?.nextDueAt).toBeNull();
    });

    it("enabling a task that was seeded NULL (disabled) makes it due-eligible", () => {
        db = freshDb();
        const now = Date.UTC(2026, 0, 1, 12, 0);
        // Seed disabled → next_due NULL.
        planDueTasks(db, PROJECT, [cfg("maintain-docs", "")], now);
        expect(getTaskScheduleState(db, PROJECT, "maintain-docs")?.nextDueAt).toBeNull();
        // Now enable it: a fresh next_due is computed (future, not immediate).
        planDueTasks(db, PROJECT, [cfg("maintain-docs", "0 3 * * *")], now);
        const state = getTaskScheduleState(db, PROJECT, "maintain-docs");
        expect(state?.nextDueAt).not.toBeNull();
        expect(state?.nextDueAt).toBeGreaterThan(now);
        expect(state?.schedule).toBe("0 3 * * *");
    });

    it("changing the cron recomputes next_due_at from the new schedule", () => {
        db = freshDb();
        const now = Date.UTC(2026, 0, 1, 12, 0);
        planDueTasks(db, PROJECT, [cfg("consolidate", "0 3 * * *")], now);
        const before = getTaskScheduleState(db, PROJECT, "consolidate")?.nextDueAt;
        // Switch to hourly: next_due must move earlier (next top-of-hour).
        planDueTasks(db, PROJECT, [cfg("consolidate", "0 * * * *")], now);
        const after = getTaskScheduleState(db, PROJECT, "consolidate");
        expect(after?.schedule).toBe("0 * * * *");
        expect(after?.nextDueAt).not.toBe(before);
        expect(after?.nextDueAt).toBeLessThan(before ?? Number.POSITIVE_INFINITY);
    });

    it("legacy row (schedule IS NULL) with a live next_due is backfilled, not recomputed", () => {
        db = freshDb();
        const now = Date.now();
        const due = now - 1000;
        // Simulate a pre-column row: live next_due in the past, schedule NULL.
        writeTaskScheduleState(db, {
            projectPath: PROJECT,
            task: "consolidate",
            lastRunAt: null,
            nextDueAt: due,
            schedule: null,
            lastStatus: null,
            lastError: null,
            retryCount: 0,
        });
        const collected = planDueTasks(db, PROJECT, [cfg("consolidate", "0 3 * * *")], now);
        // The past-due slot is preserved (NOT recomputed into the future) and fires.
        expect(collected.map((d) => d.config.task)).toEqual(["consolidate"]);
        const state = getTaskScheduleState(db, PROJECT, "consolidate");
        expect(state?.schedule).toBe("0 3 * * *");
        expect(state?.nextDueAt).toBe(due);
    });
});

/** Force a task due by overwriting its seeded next_due into the past. */
function forceDue(d: Database, task: DreamTaskRuntimeConfig["task"], now: number): void {
    const prior = getTaskScheduleState(d, PROJECT, task);
    writeTaskScheduleState(d, {
        projectPath: PROJECT,
        task,
        lastRunAt: null,
        nextDueAt: now - 1000,
        schedule: prior?.schedule ?? "0 3 * * *",
        lastStatus: null,
        lastError: null,
        retryCount: 0,
    });
}

describe("task-scheduler — runDueTasksForProject", () => {
    it("runs a due+gated task and advances next_due to the future", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [cfg("consolidate", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "consolidate", now);

        const ran: string[] = [];
        const executor = async (): Promise<TaskExecOutcome> => {
            ran.push("consolidate");
            return { status: "completed" };
        };
        const count = await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            now,
        });
        expect(count).toBe(1);
        expect(ran).toEqual(["consolidate"]);
        const state = getTaskScheduleState(db, PROJECT, "consolidate");
        expect(state?.lastStatus).toBe("completed");
        expect(state?.nextDueAt).toBeGreaterThan(now);
    });

    it("skips a due task whose gate fails (no active memories) and advances it", async () => {
        db = freshDb();
        // No memories → consolidate gate fails.
        const now = Date.now();
        const tasks = [cfg("consolidate", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "consolidate", now);

        let ranExecutor = false;
        const executor = async (): Promise<TaskExecOutcome> => {
            ranExecutor = true;
            return { status: "completed" };
        };
        const count = await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            now,
        });
        expect(count).toBe(0);
        expect(ranExecutor).toBe(false);
        const state = getTaskScheduleState(db, PROJECT, "consolidate");
        expect(state?.lastStatus).toBe("skipped");
        expect(state?.nextDueAt).toBeGreaterThan(now);
    });

    it("memory-domain tasks run SEQUENTIALLY in canonical order under one lease", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [
            cfg("improve", "0 3 * * *"),
            cfg("consolidate", "0 3 * * *"),
            cfg("verify", "0 3 * * *"),
        ];
        planDueTasks(db, PROJECT, tasks, now);
        for (const t of ["improve", "consolidate", "verify"] as const) forceDue(db, t, now);

        const order: string[] = [];
        const executor = async (c: DreamTaskRuntimeConfig): Promise<TaskExecOutcome> => {
            order.push(c.task);
            return { status: "completed" };
        };
        await runDueTasksForProject({ db, projectIdentity: PROJECT, tasks, executor, now });
        // Canonical order: consolidate < verify < improve.
        expect(order).toEqual(["consolidate", "verify", "improve"]);
    });

    it("a busy domain lease defers its tasks (next_due unchanged, no run)", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [cfg("consolidate", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "consolidate", now);
        // Hold the memory-domain lease from "another process".
        expect(acquireLease(db, "other-holder", leaseKeyFor("consolidate", PROJECT))).toBe(true);

        let ran = false;
        const executor = async (): Promise<TaskExecOutcome> => {
            ran = true;
            return { status: "completed" };
        };
        await runDueTasksForProject({ db, projectIdentity: PROJECT, tasks, executor, now });
        expect(ran).toBe(false);
        // next_due stayed in the past → still due next tick.
        const state = getTaskScheduleState(db, PROJECT, "consolidate");
        expect(state?.nextDueAt).toBeLessThan(now);
        expect(state?.lastStatus).toBeNull();
    });

    it("different domains run CONCURRENTLY (memory + smart-notes both execute)", async () => {
        db = freshDb();
        seedActiveMemory(db);
        // pending smart note for the evaluate-smart-notes gate
        db.prepare(
            `INSERT INTO notes (type, project_path, content, status, created_at, updated_at)
             VALUES ('smart', ?, 'n', 'pending', 1, 1)`,
        ).run(PROJECT);
        const now = Date.now();
        const tasks = [cfg("consolidate", "0 3 * * *"), cfg("evaluate-smart-notes", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "consolidate", now);
        forceDue(db, "evaluate-smart-notes", now);

        const ran = new Set<string>();
        const executor = async (c: DreamTaskRuntimeConfig): Promise<TaskExecOutcome> => {
            ran.add(c.task);
            return { status: "completed" };
        };
        const count = await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            now,
        });
        expect(count).toBe(2);
        expect(ran.has("consolidate")).toBe(true);
        expect(ran.has("evaluate-smart-notes")).toBe(true);
    });

    it("transient failure keeps next_due (hot-retry) until MAX_TASK_RETRIES, then advances", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [cfg("consolidate", "0 3 * * *")];

        const executor = async (): Promise<TaskExecOutcome> => ({
            status: "failed",
            transient: true,
            error: "rate limit",
        });

        // Force due ONCE; a transient failure leaves next_due in the past, so the
        // task stays due across ticks without re-forcing (re-forcing would reset
        // retry_count, which is the bug this exercises).
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "consolidate", now);
        // Attempts 1..3 keep next_due in the past (retry next tick).
        for (let attempt = 1; attempt <= 3; attempt++) {
            await runDueTasksForProject({ db, projectIdentity: PROJECT, tasks, executor, now });
            const s = getTaskScheduleState(db, PROJECT, "consolidate");
            expect(s?.retryCount).toBe(attempt);
            expect(s?.nextDueAt).toBeLessThan(now); // still due
        }
        // Attempt 4 exceeds MAX_TASK_RETRIES=3 → advance + reset.
        await runDueTasksForProject({ db, projectIdentity: PROJECT, tasks, executor, now });
        const s = getTaskScheduleState(db, PROJECT, "consolidate");
        expect(s?.retryCount).toBe(0);
        expect(s?.nextDueAt).toBeGreaterThan(now);
        expect(s?.lastStatus).toBe("failed");
    });

    it("permanent failure advances to the next cron slot (no hot-retry)", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [cfg("consolidate", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "consolidate", now);
        const executor = async (): Promise<TaskExecOutcome> => ({
            status: "failed",
            transient: false,
            error: "model not found",
        });
        await runDueTasksForProject({ db, projectIdentity: PROJECT, tasks, executor, now });
        const s = getTaskScheduleState(db, PROJECT, "consolidate");
        expect(s?.nextDueAt).toBeGreaterThan(now);
        expect(s?.retryCount).toBe(0);
        expect(s?.lastStatus).toBe("failed");
    });
});

describe("task-scheduler — runManualDream", () => {
    it("no task arg runs ALL enabled tasks regardless of schedule (not due)", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const tasks = [
            cfg("consolidate", "0 3 * * *"),
            cfg("verify", "0 3 * * *"),
            cfg("maintain-docs", ""), // disabled → must NOT run even manually
        ];
        const ran: string[] = [];
        const executor = async (c: DreamTaskRuntimeConfig): Promise<TaskExecOutcome> => {
            ran.push(c.task);
            return { status: "completed" };
        };
        const result = await runManualDream({ db, projectIdentity: PROJECT, tasks, executor });
        expect(result.ran.sort()).toEqual(["consolidate", "verify"]);
        expect(ran).not.toContain("maintain-docs"); // disabled stays off
    });

    it("a single task arg FORCE-runs it ignoring the activity gate", async () => {
        db = freshDb();
        // No active memories → consolidate's gate would normally fail. Forced runs anyway.
        const tasks = [cfg("consolidate", "0 3 * * *")];
        let ran = false;
        const executor = async (): Promise<TaskExecOutcome> => {
            ran = true;
            return { status: "completed" };
        };
        const result = await runManualDream({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            task: "consolidate",
        });
        expect(ran).toBe(true);
        expect(result.ran).toEqual(["consolidate"]);
    });

    it("a single DISABLED task can still be force-run by name", async () => {
        db = freshDb();
        const tasks = [cfg("maintain-docs", "")]; // disabled
        let ran = false;
        const executor = async (): Promise<TaskExecOutcome> => {
            ran = true;
            return { status: "completed" };
        };
        const result = await runManualDream({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            task: "maintain-docs",
        });
        expect(ran).toBe(true);
        expect(result.ran).toEqual(["maintain-docs"]);
    });

    it("reports gate-skipped tasks in the all-enabled run", async () => {
        db = freshDb();
        // No active memories → consolidate gate fails; it is enabled but skipped.
        const tasks = [cfg("consolidate", "0 3 * * *")];
        const executor = async (): Promise<TaskExecOutcome> => ({ status: "completed" });
        const result = await runManualDream({ db, projectIdentity: PROJECT, tasks, executor });
        expect(result.ran).toEqual([]);
        expect(result.skippedNoWork).toEqual(["consolidate"]);
    });

    it("an unknown forced task name is a no-op", async () => {
        db = freshDb();
        const tasks = [cfg("consolidate", "0 3 * * *")];
        const executor = async (): Promise<TaskExecOutcome> => ({ status: "completed" });
        const result = await runManualDream({
            db,
            projectIdentity: PROJECT,
            tasks,
            // biome-ignore lint/suspicious/noExplicitAny: testing an out-of-set name
            executor,
            task: "not-a-task" as never,
        });
        expect(result.ran).toEqual([]);
    });
});
