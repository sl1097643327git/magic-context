/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";

import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    type RetrospectiveProjectSession,
    type RetrospectiveRawMessage,
    type RetrospectiveRawProvider,
    readRetrospectiveScanWindow,
} from "./retrospective-raw-provider";
import {
    isRetrospectiveWindowProcessed,
    recordRetrospectiveWindowProcessed,
} from "./storage-task-schedule";

let db: Database | null = null;
afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});
function freshDb(): Database {
    const database = new Database(":memory:");
    initializeDatabase(database);
    runMigrations(database);
    return database;
}

function u(sessionId: string, ts: number, text: string): RetrospectiveRawMessage {
    return { sessionId, ordinal: 0, role: "user", text, ts };
}

/** A scripted provider: `since` returns rows with ts > watermark; `before`
 *  returns the newest `count` rows with ts <= watermark. */
class ScriptedProvider implements RetrospectiveRawProvider {
    constructor(
        private readonly sessions: string[],
        private readonly rowsBySession: Map<string, RetrospectiveRawMessage[]>,
    ) {}
    listProjectSessions(): RetrospectiveProjectSession[] {
        return this.sessions.map((sessionId) => ({ sessionId }));
    }
    readUserMessagesSince(sessionId: string, sinceMs: number): RetrospectiveRawMessage[] {
        return (this.rowsBySession.get(sessionId) ?? []).filter((r) => r.ts > sinceMs);
    }
    readUserMessagesBefore(
        sessionId: string,
        beforeMs: number,
        count: number,
    ): RetrospectiveRawMessage[] {
        return (this.rowsBySession.get(sessionId) ?? [])
            .filter((r) => r.ts <= beforeMs)
            .sort((a, b) => a.ts - b.ts)
            .slice(-count);
    }
}

describe("readRetrospectiveScanWindow", () => {
    test("merges since + overlap; maxScannedTs comes ONLY from the since portion", async () => {
        const rows = new Map([
            [
                "s1",
                [
                    u("s1", 100, "old1"),
                    u("s1", 150, "old2"),
                    u("s1", 250, "new1"),
                    u("s1", 300, "new2"),
                ],
            ],
        ]);
        const provider = new ScriptedProvider(["s1"], rows);

        const win = await readRetrospectiveScanWindow(provider, "proj", 200, 2);
        const texts = win.messages.map((m) => m.text);
        // since (>200): new1, new2. overlap (<=200, last 2): old1, old2.
        expect(texts.sort()).toEqual(["new1", "new2", "old1", "old2"]);
        // watermark only advances to the newest SINCE row, never pulled back by overlap.
        expect(win.maxScannedTs).toBe(300);
    });

    test("watermark=0 (never scanned) reads no overlap, only since", async () => {
        const rows = new Map([["s1", [u("s1", 100, "a"), u("s1", 200, "b")]]]);
        const provider = new ScriptedProvider(["s1"], rows);
        const win = await readRetrospectiveScanWindow(provider, "proj", 0, 12);
        expect(win.messages.map((m) => m.text).sort()).toEqual(["a", "b"]);
        expect(win.maxScannedTs).toBe(200);
    });

    test("dedupes a row that appears in both since and overlap reads", async () => {
        // A provider whose `before` overlaps the `since` boundary row.
        const rows = new Map([["s1", [u("s1", 200, "boundary"), u("s1", 250, "after")]]]);
        const provider: RetrospectiveRawProvider = {
            listProjectSessions: () => [{ sessionId: "s1" }],
            readUserMessagesSince: (_s, since) =>
                (rows.get("s1") ?? []).filter((r) => r.ts > since),
            // deliberately also return the boundary row (ts == watermark) in overlap
            readUserMessagesBefore: () => [u("s1", 200, "boundary")],
        };
        const win = await readRetrospectiveScanWindow(provider, "proj", 199, 5);
        // "boundary" (ts 200) is > 199 so in since AND returned by overlap → one copy.
        expect(win.messages.filter((m) => m.text === "boundary")).toHaveLength(1);
    });
});

describe("retrospective processed-window idempotence", () => {
    test("record then check round-trips per (project, key)", () => {
        db = freshDb();
        expect(isRetrospectiveWindowProcessed(db, "proj", "k1")).toBe(false);
        recordRetrospectiveWindowProcessed(db, "proj", "k1");
        expect(isRetrospectiveWindowProcessed(db, "proj", "k1")).toBe(true);
        // scoped by project + key
        expect(isRetrospectiveWindowProcessed(db, "proj", "k2")).toBe(false);
        expect(isRetrospectiveWindowProcessed(db, "other", "k1")).toBe(false);
    });

    test("re-recording the same key is an idempotent no-op (no throw)", () => {
        db = freshDb();
        recordRetrospectiveWindowProcessed(db, "proj", "k1");
        expect(() => recordRetrospectiveWindowProcessed(db, "proj", "k1")).not.toThrow();
        expect(isRetrospectiveWindowProcessed(db, "proj", "k1")).toBe(true);
    });
});
