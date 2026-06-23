/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import {
    insertMemory,
    readGitFileChangeTimesSince,
    recordMemoryMapping,
    recordMemoryVerifications,
} from "../memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { partitionVerifyScope } from "./verify-gate";

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function git(args: string[], cwd: string, env?: Record<string, string>): string {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "ignore"],
    });
}

function makeGitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-verify-gate-"));
    git(["init"], dir);
    git(["config", "user.email", "test@example.invalid"], dir);
    git(["config", "user.name", "Magic Context Test"], dir);
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
    git(["add", "a.ts", "b.ts"], dir);
    git(["commit", "-m", "initial"], dir, {
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    });
    return dir;
}

function mem(db: Database, projectPath: string, content: string): number {
    const m = insertMemory(db, {
        projectPath,
        category: "ARCHITECTURE",
        content,
        sourceSessionId: "ses",
    });
    if (!m) throw new Error("insertMemory failed");
    return m.id;
}

const PROJECT = "git:test";

describe("partitionVerifyScope (per-memory verified_at gate)", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs) rmSync(d, { recursive: true, force: true });
        dirs.length = 0;
    });

    test("excludes file-independent (sentinel) and unmapped memories", async () => {
        const db = freshDb();
        const dir = makeGitRepo();
        dirs.push(dir);
        try {
            const mapped = mem(db, PROJECT, "A in a.ts");
            const independent = mem(db, PROJECT, "Anthropic returns 400 on empty content");
            mem(db, PROJECT, "unmapped fact"); // no mapping row at all
            recordMemoryMapping(db, mapped, ["a.ts"], 1);
            recordMemoryMapping(db, independent, [], 1); // sentinel

            const gate = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                now: 1000,
            });
            // Only the file-mapped, never-verified memory is in scope.
            expect(gate.inScopeIds).toEqual([mapped]);
        } finally {
            closeQuietly(db);
        }
    });

    test("never-verified mapped memory is always in scope (verified_at=0)", async () => {
        const db = freshDb();
        const dir = makeGitRepo();
        dirs.push(dir);
        try {
            const m = mem(db, PROJECT, "A in a.ts");
            recordMemoryMapping(db, m, ["a.ts"], 1); // mapped, verified_at=0
            const gate = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                now: Date.now(),
            });
            expect(gate.inScopeIds).toEqual([m]);
            expect(gate.mode).toBe("incremental");
        } finally {
            closeQuietly(db);
        }
    });

    test("a verified memory whose file is unchanged is SKIPPED", async () => {
        const db = freshDb();
        const dir = makeGitRepo();
        dirs.push(dir);
        try {
            const m = mem(db, PROJECT, "A in a.ts");
            // Verified in the FUTURE relative to all commits → no change is newer.
            recordMemoryVerifications(db, m, ["a.ts"], Date.now() + 60_000);
            const gate = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                now: Date.now(),
            });
            expect(gate.inScopeIds).toEqual([]);
            expect(gate.skippedIds).toEqual([m]);
        } finally {
            closeQuietly(db);
        }
    });

    test("a verified memory whose file changed AFTER verification is in scope", async () => {
        const db = freshDb();
        const dir = makeGitRepo();
        dirs.push(dir);
        try {
            const m = mem(db, PROJECT, "A in a.ts");
            // Verified far in the past, then a.ts changes in a new commit.
            recordMemoryVerifications(db, m, ["a.ts"], 1000);
            writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
            git(["commit", "-am", "change a"], dir);
            const gate = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                now: Date.now(),
            });
            expect(gate.inScopeIds).toEqual([m]);
        } finally {
            closeQuietly(db);
        }
    });

    test("reads commit change times using Unix timestamp --since format", async () => {
        const dir = makeGitRepo();
        dirs.push(dir);
        const changeDate = "2026-01-02T00:00:00Z";
        writeFileSync(join(dir, "a.ts"), "export const a = 3;\n");
        git(["commit", "-am", "dated change"], dir, {
            GIT_AUTHOR_DATE: changeDate,
            GIT_COMMITTER_DATE: changeDate,
        });

        const beforeChange = Date.parse("2026-01-01T12:00:00Z");
        const changeTimes = await readGitFileChangeTimesSince(dir, beforeChange);

        expect(changeTimes?.get("a.ts")).toBe(Date.parse(changeDate));

        const afterChange = Date.parse("2026-01-03T00:00:00Z");
        const laterTimes = await readGitFileChangeTimesSince(dir, afterChange);
        expect(laterTimes?.has("a.ts")).toBe(false);
    });

    test("verify-broad includes every file-mapped memory regardless of change time", async () => {
        const db = freshDb();
        const dir = makeGitRepo();
        dirs.push(dir);
        try {
            const a = mem(db, PROJECT, "A in a.ts");
            const b = mem(db, PROJECT, "B in b.ts");
            recordMemoryVerifications(db, a, ["a.ts"], Date.now() + 60_000); // would be skipped incrementally
            recordMemoryVerifications(db, b, ["b.ts"], Date.now() + 60_000);
            const gate = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                forceBroad: true,
                now: Date.now(),
            });
            expect(gate.mode).toBe("broad");
            expect(gate.inScopeIds.sort()).toEqual([a, b].sort());
        } finally {
            closeQuietly(db);
        }
    });
});
