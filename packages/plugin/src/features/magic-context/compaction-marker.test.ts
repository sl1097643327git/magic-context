/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    closeCompactionMarkerDb,
    findBoundaryUserMessage,
    injectCompactionMarker,
} from "./compaction-marker";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function useTempDataHome(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    mkdirSync(join(dir, "opencode"), { recursive: true });
    return dir;
}

function createOpenCodeDb(dataHome: string): Database {
    const db = new Database(join(dataHome, "opencode", "opencode.db"));
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    db.exec(
        "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    return db;
}

function insertMessage(
    db: Database,
    id: string,
    role: string,
    timeCreated: number,
    data: Record<string, unknown> = {},
): void {
    db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 'ses-1', ?, ?, ?)",
    ).run(id, timeCreated, timeCreated, JSON.stringify({ role, ...data }));
}

afterEach(() => {
    closeCompactionMarkerDb();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    tempDirs.length = 0;
});

describe("findBoundaryUserMessage", () => {
    it("anchors by endMessageId after rows before the target were deleted", () => {
        const dataHome = useTempDataHome("marker-boundary-deleted-before-");
        const db = createOpenCodeDb(dataHome);
        insertMessage(db, "msg_001_deleted_user", "user", 100);
        insertMessage(db, "msg_002_deleted_assistant", "assistant", 200);
        insertMessage(db, "msg_003_prior_user", "user", 300);
        insertMessage(db, "msg_004_target", "assistant", 400);
        insertMessage(db, "msg_005_after_user", "user", 500);
        db.prepare(
            "DELETE FROM message WHERE id IN ('msg_001_deleted_user', 'msg_002_deleted_assistant')",
        ).run();
        closeQuietly(db);

        expect(findBoundaryUserMessage("ses-1", "msg_004_target")?.id).toBe("msg_003_prior_user");
    });

    it("uses the canonical time_created/id tie-break at equal timestamps", () => {
        const dataHome = useTempDataHome("marker-boundary-tiebreak-");
        const db = createOpenCodeDb(dataHome);
        insertMessage(db, "msg_a_prior_user", "user", 1_000);
        insertMessage(db, "msg_b_target", "assistant", 1_000);
        insertMessage(db, "msg_c_after_user", "user", 1_000);
        closeQuietly(db);

        expect(findBoundaryUserMessage("ses-1", "msg_b_target")?.id).toBe("msg_a_prior_user");
    });

    it("returns the target itself when the target message is a user", () => {
        const dataHome = useTempDataHome("marker-boundary-target-user-");
        const db = createOpenCodeDb(dataHome);
        insertMessage(db, "msg_001_prior_user", "user", 100);
        insertMessage(db, "msg_002_target_user", "user", 200);
        closeQuietly(db);

        expect(findBoundaryUserMessage("ses-1", "msg_002_target_user")?.id).toBe(
            "msg_002_target_user",
        );
    });

    it("is unchanged by deleting rows after the target", () => {
        const dataHome = useTempDataHome("marker-boundary-deleted-after-");
        const db = createOpenCodeDb(dataHome);
        insertMessage(db, "msg_001_prior_user", "user", 100);
        insertMessage(db, "msg_002_target", "assistant", 200);
        insertMessage(db, "msg_003_after_user", "user", 300);
        closeQuietly(db);

        expect(findBoundaryUserMessage("ses-1", "msg_002_target")?.id).toBe("msg_001_prior_user");

        const reopened = new Database(join(dataHome, "opencode", "opencode.db"));
        reopened.prepare("DELETE FROM message WHERE id = 'msg_003_after_user'").run();
        closeQuietly(reopened);
        closeCompactionMarkerDb();

        expect(findBoundaryUserMessage("ses-1", "msg_002_target")?.id).toBe("msg_001_prior_user");
    });

    it("finds a prior user across a long assistant/tool span", () => {
        const dataHome = useTempDataHome("marker-boundary-long-span-");
        const db = createOpenCodeDb(dataHome);
        insertMessage(db, "msg_001_prior_user", "user", 100);
        for (let i = 0; i < 150; i++) {
            insertMessage(
                db,
                `msg_${String(i + 2).padStart(3, "0")}_assistant`,
                "assistant",
                101 + i,
            );
        }
        insertMessage(db, "msg_999_target", "tool", 1_000);
        closeQuietly(db);

        expect(findBoundaryUserMessage("ses-1", "msg_999_target")?.id).toBe("msg_001_prior_user");
    });
});

describe("injectCompactionMarker", () => {
    it("preserves the deterministic boundary in the healthy no-deletion case", () => {
        const dataHome = useTempDataHome("marker-inject-healthy-");
        const db = createOpenCodeDb(dataHome);
        insertMessage(db, "msg_001_user", "user", 100);
        insertMessage(db, "msg_002_assistant", "assistant", 200);
        insertMessage(db, "msg_003_target", "assistant", 300);
        closeQuietly(db);

        const result = injectCompactionMarker({
            sessionId: "ses-1",
            endOrdinal: 3,
            endMessageId: "msg_003_target",
            summaryText: "summary placeholder",
            directory: dataHome,
        });

        // Generated marker row ids include random base62 suffixes; compare only
        // the deterministic boundary field that the old ordinal path intended.
        expect(result?.boundaryMessageId).toBe("msg_001_user");
    });
});
