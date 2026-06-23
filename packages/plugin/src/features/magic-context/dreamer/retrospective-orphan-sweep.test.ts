/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, test } from "bun:test";

import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import {
    RETROSPECTIVE_CHILD_TITLE,
    USER_MEMORIES_CHILD_TITLE,
    retrospectiveOrphanStaleMs,
    sweepOrphanedRetrospectiveChildren,
} from "./retrospective-orphan-sweep";

let db: Database | null = null;
afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function makeOpencodeDb(): Database {
    const database = new Database(":memory:");
    database.exec(`
        CREATE TABLE session (
            id TEXT PRIMARY KEY,
            title TEXT,
            directory TEXT,
            time_created INTEGER
        );
    `);
    return database;
}

function insert(database: Database, id: string, title: string, dir: string, created: number) {
    database
        .prepare("INSERT INTO session (id, title, directory, time_created) VALUES (?, ?, ?, ?)")
        .run(id, title, dir, created);
}

describe("retrospectiveOrphanStaleMs", () => {
    test("is at least 60min and scales with timeout×3", () => {
        expect(retrospectiveOrphanStaleMs(20)).toBe(60 * 60_000); // 60min floor wins
        expect(retrospectiveOrphanStaleMs(30)).toBe(90 * 60_000); // 30×3 wins
        expect(retrospectiveOrphanStaleMs(undefined)).toBe(60 * 60_000);
    });
});

describe("sweepOrphanedRetrospectiveChildren", () => {
    const DIR = "/repo/project";
    const now = 10_000_000;
    const staleMs = 60 * 60_000;

    function deleteClient() {
        const deleted: string[] = [];
        const client = {
            session: {
                delete: mock(async ({ path }: { path: { id: string } }) => {
                    deleted.push(path.id);
                    return {};
                }),
            },
        } as never;
        return { client, deleted };
    }

    test("deletes old privacy-sensitive children in this directory", async () => {
        db = makeOpencodeDb();
        // old orphan in this dir → swept
        insert(db, "old-user-memories", USER_MEMORIES_CHILD_TITLE, DIR, now - staleMs - 2);
        insert(db, "old", RETROSPECTIVE_CHILD_TITLE, DIR, now - staleMs - 1);
        // recent child (live run) → NOT swept
        insert(db, "fresh", RETROSPECTIVE_CHILD_TITLE, DIR, now - 1000);
        // old but a different title → NOT swept
        insert(db, "other-title", "magic-context-dream-verify", DIR, now - staleMs - 1);
        // old retrospective but ANOTHER directory → NOT swept
        insert(db, "other-dir", RETROSPECTIVE_CHILD_TITLE, "/repo/elsewhere", now - staleMs - 1);

        const { client, deleted } = deleteClient();
        const count = await sweepOrphanedRetrospectiveChildren({
            opencodeDb: db,
            client,
            sessionDirectory: DIR,
            staleMs,
            now,
        });

        expect(deleted).toEqual(["old-user-memories", "old"]);
        expect(count).toBe(2);
    });

    test("treats a delete error (404 / already removed) as success", async () => {
        db = makeOpencodeDb();
        insert(db, "gone", RETROSPECTIVE_CHILD_TITLE, DIR, now - staleMs - 1);
        const client = {
            session: {
                delete: mock(async () => {
                    throw new Error("404 not found");
                }),
            },
        } as never;

        const count = await sweepOrphanedRetrospectiveChildren({
            opencodeDb: db,
            client,
            sessionDirectory: DIR,
            staleMs,
            now,
        });
        expect(count).toBe(1);
    });

    test("null db → no-op", async () => {
        const { client } = deleteClient();
        const count = await sweepOrphanedRetrospectiveChildren({
            opencodeDb: null,
            client,
            sessionDirectory: DIR,
            staleMs,
            now,
        });
        expect(count).toBe(0);
    });

    test("missing session table fails open (no throw)", async () => {
        db = new Database(":memory:"); // no `session` table
        const { client } = deleteClient();
        const count = await sweepOrphanedRetrospectiveChildren({
            opencodeDb: db,
            client,
            sessionDirectory: DIR,
            staleMs,
            now,
        });
        expect(count).toBe(0);
    });
});
