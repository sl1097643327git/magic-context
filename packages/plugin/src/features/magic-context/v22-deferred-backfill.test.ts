import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { ProjectIdentityError } from "./memory/project-identity";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { getProjectState } from "./storage-project-state";
import {
    BATCH_SIZE,
    computeLegacyRustDirIdentity,
    runDeferredV22Backfill,
} from "./v22-deferred-backfill";

let db: Database | null = null;
const tempDirs: string[] = [];

function makeDb(): Database {
    db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function makeTempDir(prefix = "mc-v22-backfill-"): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function insertMemory(database: Database, projectPath: string, normalizedHash: string): number {
    const result = database
        .prepare(
            `INSERT INTO memories
                (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES (?, 'CONSTRAINTS', ?, ?, 1, 1, 1, 1)`,
        )
        .run(projectPath, `content-${normalizedHash}`, normalizedHash) as {
        lastInsertRowid: number;
    };
    return Number(result.lastInsertRowid);
}

function metaValue(database: Database, key: string): string | null {
    const row = database
        .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
        .get(key) as { value: string } | undefined;
    return row?.value ?? null;
}

afterEach(() => {
    if (db) {
        closeQuietly(db);
        db = null;
    }
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("runDeferredV22Backfill", () => {
    test("empty table completes without error", async () => {
        const database = makeDb();

        const summary = await runDeferredV22Backfill(database, {
            yieldToEventLoop: async () => {},
        });

        expect(summary.status).toBe("completed");
        expect(summary.changedRows).toBe(0);
        expect(metaValue(database, "v22_legacy_memory_backfill")).toBe("completed");
    });

    test("converts 100 legacy rows, records rekey maps, bumps each distinct identity once, and batches at 25", async () => {
        const database = makeDb();
        for (let i = 0; i < 100; i += 1) {
            insertMemory(database, `/legacy/project-${i}`, `hash-${i}`);
        }
        const batchSizes: number[] = [];

        const summary = await runDeferredV22Backfill(database, {
            resolveIdentity: (raw) => `git:${raw.split("-").at(-1)}`,
            yieldToEventLoop: async () => {},
            onBatchResolved: (batch) => batchSizes.push(batch.length),
        });

        expect(summary.changedRows).toBe(100);
        expect(batchSizes).toEqual([BATCH_SIZE, BATCH_SIZE, BATCH_SIZE, BATCH_SIZE]);
        const unresolved = database
            .prepare(
                "SELECT COUNT(*) AS count FROM memories WHERE project_path NOT LIKE 'git:%' AND project_path NOT LIKE 'dir:%'",
            )
            .get() as { count: number };
        expect(unresolved.count).toBe(0);
        const mapCount = database
            .prepare("SELECT COUNT(*) AS count FROM v22_identity_rekey_map")
            .get() as { count: number };
        expect(mapCount.count).toBeGreaterThanOrEqual(100);
        const epochs = database
            .prepare("SELECT project_memory_epoch FROM project_state ORDER BY project_path")
            .all() as Array<{ project_memory_epoch: number }>;
        expect(epochs).toHaveLength(100);
        expect(epochs.every((row) => row.project_memory_epoch === 1)).toBe(true);
    });

    test("falls back to dir identity for accessible non-git rows", async () => {
        const database = makeDb();
        const dir = makeTempDir();
        insertMemory(database, dir, "non-git");

        await runDeferredV22Backfill(database, { yieldToEventLoop: async () => {} });

        const row = database.prepare("SELECT project_path FROM memories").get() as {
            project_path: string;
        };
        expect(row.project_path).toMatch(/^dir:[0-9a-f]{12}$/);
        expect(getProjectState(database, row.project_path)?.projectMemoryEpoch).toBe(1);
    });

    test("records resolver failures and advances the cursor", async () => {
        const database = makeDb();
        const failedId = insertMemory(database, "/denied", "denied");
        const okId = insertMemory(database, "/ok", "ok");

        const summary = await runDeferredV22Backfill(database, {
            resolveIdentity: (raw) => {
                if (raw === "/denied") {
                    throw new ProjectIdentityError("permission_denied", raw, "permission denied");
                }
                return "git:ok";
            },
            yieldToEventLoop: async () => {},
        });

        expect(summary.status).toBe("completed_with_failures");
        expect(metaValue(database, "v22_legacy_memory_backfill_cursor")).toBe(String(okId));
        const failure = database
            .prepare("SELECT row_id, error_class FROM v22_backfill_failures")
            .get() as { row_id: number; error_class: string };
        expect(failure).toEqual({ row_id: failedId, error_class: "permission_denied" });
    });

    test("concurrent project_path mutation is a guarded no-op", async () => {
        const database = makeDb();
        const rowId = insertMemory(database, "/race", "race");

        const summary = await runDeferredV22Backfill(database, {
            resolveIdentity: () => "git:resolved-after-race",
            yieldToEventLoop: async () => {},
            onBatchResolved: () => {
                database
                    .prepare("UPDATE memories SET project_path = 'git:concurrent' WHERE id = ?")
                    .run(rowId);
            },
        });

        expect(summary.changedRows).toBe(0);
        const row = database
            .prepare("SELECT project_path FROM memories WHERE id = ?")
            .get(rowId) as {
            project_path: string;
        };
        expect(row.project_path).toBe("git:concurrent");
        expect(getProjectState(database, "git:resolved-after-race")).toBeNull();
    });

    test("computes legacy Rust dir identities for explicit rekeying", () => {
        const dir = makeTempDir();
        expect(computeLegacyRustDirIdentity(dir)).toMatch(/^dir:[0-9a-f]{64}$/);
    });
});
