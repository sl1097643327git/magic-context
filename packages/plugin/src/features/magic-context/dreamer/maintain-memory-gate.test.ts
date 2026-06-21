/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { insertMemory, recordMemoryVerifications } from "../memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { checkMaintainMemoryCoverage, partitionMaintainMemoryScope } from "./maintain-memory-gate";
import type { TaskScheduleStateRow } from "./storage-task-schedule";

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function git(args: string[], cwd: string): string {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    });
}

function makeGitRepo(): { dir: string; head: string } {
    const dir = mkdtempSync(join(tmpdir(), "mc-verify-"));
    git(["init"], dir);
    git(["config", "user.email", "test@example.invalid"], dir);
    git(["config", "user.name", "Magic Context Test"], dir);
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
    git(["add", "a.ts", "b.ts"], dir);
    git(["commit", "-m", "initial"], dir);
    return { dir, head: git(["rev-parse", "HEAD"], dir).trim() };
}

function activeMemory(db: Database, projectPath: string, content: string) {
    return insertMemory(db, {
        projectPath,
        category: "CONFIG_VALUES",
        content,
        sourceSessionId: "ses",
    });
}

function scheduleState(
    projectPath: string,
    commit: string | null,
    now: number,
): TaskScheduleStateRow {
    return {
        projectPath,
        task: "verify",
        lastRunAt: now - 1000,
        nextDueAt: now,
        schedule: "0 3 * * *",
        lastStatus: "completed",
        lastError: null,
        retryCount: 0,
        lastCheckedCommit: commit,
        lastBroadRunAt: now,
    };
}

let db: Database | null = null;
let dirs: string[] = [];
afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
});

describe("verify incremental gate", () => {
    test("never-verified memories are in scope while sentinel-only memories skip", async () => {
        db = freshDb();
        const repo = makeGitRepo();
        dirs.push(repo.dir);
        const never = activeMemory(db, repo.dir, "A is configured in a.ts.");
        const sentinel = activeMemory(db, repo.dir, "Use concise memories.");
        recordMemoryVerifications(db, sentinel.id, [], 1000);

        const result = await partitionMaintainMemoryScope({
            db,
            projectIdentity: repo.dir,
            projectDirectory: repo.dir,
            scheduleState: scheduleState(repo.dir, repo.head, Date.now()),
        });

        expect(result.mode).toBe("incremental");
        expect(result.inScopeIds).toEqual([never.id]);
        expect(result.skippedIds).toContain(sentinel.id);
    });

    test("changed and missing mapped files are in scope", async () => {
        db = freshDb();
        const repo = makeGitRepo();
        dirs.push(repo.dir);
        const changed = activeMemory(db, repo.dir, "A is configured in a.ts.");
        const missing = activeMemory(db, repo.dir, "Old path backs a memory.");
        recordMemoryVerifications(db, changed.id, ["a.ts"], 1000);
        recordMemoryVerifications(db, missing.id, ["old.ts"], 1000);
        writeFileSync(join(repo.dir, "a.ts"), "export const a = 2;\n");

        const result = await partitionMaintainMemoryScope({
            db,
            projectIdentity: repo.dir,
            projectDirectory: repo.dir,
            scheduleState: scheduleState(repo.dir, repo.head, Date.now()),
        });

        expect(result.inScopeIds.sort((a, b) => a - b)).toEqual([changed.id, missing.id].sort());
    });

    test("non-git full-verify, and forceBroad pulls the WHOLE pool incl sentinel-only", async () => {
        db = freshDb();
        const nonGitDir = mkdtempSync(join(tmpdir(), "mc-verify-non-git-"));
        dirs.push(nonGitDir);
        const nonGitMemory = activeMemory(db, nonGitDir, "Non-git memory.");
        const nonGit = await partitionMaintainMemoryScope({
            db,
            projectIdentity: nonGitDir,
            projectDirectory: nonGitDir,
            scheduleState: null,
        });
        expect(nonGit.mode).toBe("non-git");
        expect(nonGit.inScopeIds).toEqual([nonGitMemory.id]);

        // verify-broad: even with a current watermark + a sentinel-only memory
        // (which incremental SKIPS), forceBroad pulls the entire active pool.
        const repo = makeGitRepo();
        dirs.push(repo.dir);
        const sentinel = activeMemory(db, repo.dir, "File independent.");
        recordMemoryVerifications(db, sentinel.id, [], 1000);
        const broad = await partitionMaintainMemoryScope({
            db,
            projectIdentity: repo.dir,
            projectDirectory: repo.dir,
            scheduleState: scheduleState(repo.dir, repo.head, Date.now()),
            forceBroad: true,
        });
        expect(broad.mode).toBe("broad");
        expect(broad.inScopeIds).toEqual([sentinel.id]);
    });

    test("invalid stored watermark falls back to full verification", async () => {
        db = freshDb();
        const repo = makeGitRepo();
        dirs.push(repo.dir);
        const memory = activeMemory(db, repo.dir, "A is configured in a.ts.");
        recordMemoryVerifications(db, memory.id, ["a.ts"], 1000);

        const result = await partitionMaintainMemoryScope({
            db,
            projectIdentity: repo.dir,
            projectDirectory: repo.dir,
            scheduleState: scheduleState(repo.dir, "deadbeef", Date.now()),
        });

        expect(result.mode).toBe("full");
        expect(result.startHead).toBe(repo.head);
        expect(result.inScopeIds).toEqual([memory.id]);
    });
});

describe("verify deterministic coverage", () => {
    test("requires fresh verification rows unless memory is no longer active", () => {
        db = freshDb();
        const project = "git:coverage";
        const covered = activeMemory(db, project, "Covered.");
        const uncovered = activeMemory(db, project, "Uncovered.");
        const archived = activeMemory(db, project, "Archived.");
        const runStartedAt = 5000;
        recordMemoryVerifications(db, covered.id, ["a.ts"], runStartedAt);
        db.prepare("UPDATE memories SET status='archived' WHERE id=?").run(archived.id);

        const result = checkMaintainMemoryCoverage({
            db,
            inScopeIds: [covered.id, uncovered.id, archived.id],
            runStartedAt,
        });

        expect(result.covered).toBe(false);
        expect(result.uncoveredIds).toEqual([uncovered.id]);

        recordMemoryVerifications(db, uncovered.id, [], runStartedAt + 1);
        expect(
            checkMaintainMemoryCoverage({
                db,
                inScopeIds: [covered.id, uncovered.id, archived.id],
                runStartedAt,
            }),
        ).toEqual({ covered: true, uncoveredIds: [] });
    });
});
