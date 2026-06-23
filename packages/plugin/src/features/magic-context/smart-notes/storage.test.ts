/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { evaluateSmartNotes } from "../dreamer/evaluate-smart-notes";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { addNote, getPendingSmartNotes } from "../storage-notes";
import { SMART_NOTE_CHECK_POLICY_VERSION } from "./types";
import { getSmartNotesNeedingCompilation } from "./storage";

const PROJECT = "git:test";
const tempDirs: string[] = [];

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function tempProject(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "mc-smart-note-storage-"));
    tempDirs.push(dir);
    return dir;
}

function setCheckColumns(db: Database, noteId: number, columns: Record<string, unknown>): void {
    const entries = Object.entries(columns);
    db.prepare(
        `UPDATE notes SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`,
    ).run(...entries.map(([, value]) => value), noteId);
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

describe("smart-note compilation selection", () => {
    test("honors check_next_due_at backoff before recompiling notes", () => {
        const db = freshDb();
        try {
            const now = 10_000;
            const due = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "due",
                surfaceCondition: "compile now",
            });
            const backedOff = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "backoff",
                surfaceCondition: "compile later",
            });
            setCheckColumns(db, due.id, { check_next_due_at: now - 1 });
            setCheckColumns(db, backedOff.id, { check_next_due_at: now + 60_000 });

            expect(getSmartNotesNeedingCompilation(db, PROJECT, now, 10).map((n) => n.id)).toEqual([
                due.id,
            ]);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("evaluateSmartNotes lease guard", () => {
    test("does not commit due-check results after the lease is lost", async () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "ready when check passes",
                surfaceCondition: "test condition",
            });
            setCheckColumns(db, note.id, {
                compiled_check: "function check() { return { met: true }; }",
                manifest_json: JSON.stringify({ capabilities: [], summary: "test" }),
                check_hash: "hash",
                check_cron: "* * * * *",
                check_version: 1,
                check_status: "compiled",
                check_next_due_at: 0,
                policy_version: SMART_NOTE_CHECK_POLICY_VERSION,
            });

            await expect(
                evaluateSmartNotes({
                    db,
                    client: {} as never,
                    projectIdentity: PROJECT,
                    parentSessionId: undefined,
                    sessionDirectory: tempProject(),
                    holderId: "missing-holder",
                    leaseKey: "smart-note-lease",
                    deadline: Date.now() + 60_000,
                }),
            ).rejects.toThrow("Dream lease lost");

            expect(getPendingSmartNotes(db, PROJECT).map((n) => [n.id, n.status])).toEqual([
                [note.id, "pending"],
            ]);
        } finally {
            closeQuietly(db);
        }
    });
});
