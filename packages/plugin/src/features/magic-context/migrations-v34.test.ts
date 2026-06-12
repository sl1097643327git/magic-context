import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

function tableColumns(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

function indexNames(db: Database): string[] {
    return (
        db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
            name: string;
        }>
    ).map((row) => row.name);
}

const CLEARED_NULL_COLUMNS = [
    "cached_m0_bytes",
    "cached_m1_bytes",
    "cached_m0_project_memory_epoch",
    "cached_m0_workspace_fingerprint",
    "cached_m0_project_user_profile_version",
    "cached_m0_max_compartment_seq",
    "cached_m0_max_memory_id",
    "cached_m0_max_mutation_id",
    "cached_m0_max_memory_mutation_id",
    "cached_m0_project_docs_hash",
    "cached_m0_materialized_at",
    "cached_m0_session_facts_version",
    "cached_m0_upgrade_state",
    "cached_m0_system_hash",
    "cached_m0_tool_set_hash",
    "cached_m0_model_key",
    "cached_m0_last_baseline_end_message_id",
] as const;

const CLEARED_EMPTY_COLUMNS = ["memory_block_cache", "memory_block_ids"] as const;

describe("migration v34 — workspaces", () => {
    test("fresh DB schema includes workspace tables and schema fence version", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(tableColumns(db, "workspaces")).toEqual(
                expect.arrayContaining(["id", "name", "created_at", "updated_at"]),
            );
            expect(tableColumns(db, "workspace_members")).toEqual(
                expect.arrayContaining([
                    "workspace_id",
                    "project_path",
                    "display_name",
                    "display_path",
                    "added_at",
                ]),
            );
            expect(tableColumns(db, "session_meta")).toContain("cached_m0_workspace_fingerprint");
            expect(indexNames(db)).toEqual(
                expect.arrayContaining([
                    "idx_workspace_member_unique",
                    "idx_workspace_member_name",
                ]),
            );
            expect(LATEST_SUPPORTED_VERSION).toBe(34);
            expect(LATEST_MIGRATION_VERSION).toBe(34);
            expect(
                db
                    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
                    .get(),
            ).toEqual({ version: 34 });
        } finally {
            closeQuietly(db);
        }
    });

    test("up clears every cached m0/m1 column with explicit reset values", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
                INSERT INTO schema_migrations (version, description, applied_at) VALUES (33, 'pre-v34 fixture', 1);
                CREATE TABLE session_meta (
                    session_id TEXT PRIMARY KEY,
                    cached_m0_bytes BLOB,
                    cached_m1_bytes BLOB,
                    cached_m0_project_memory_epoch INTEGER,
                    cached_m0_project_user_profile_version INTEGER,
                    cached_m0_max_compartment_seq INTEGER,
                    cached_m0_max_memory_id INTEGER,
                    cached_m0_max_mutation_id INTEGER,
                    cached_m0_max_memory_mutation_id INTEGER,
                    cached_m0_project_docs_hash TEXT,
                    cached_m0_materialized_at INTEGER,
                    cached_m0_session_facts_version INTEGER,
                    cached_m0_upgrade_state TEXT,
                    cached_m0_system_hash TEXT,
                    cached_m0_tool_set_hash TEXT,
                    cached_m0_model_key TEXT,
                    cached_m0_last_baseline_end_message_id TEXT,
                    memory_block_cache TEXT,
                    memory_block_ids TEXT,
                    memory_block_count INTEGER
                );
                INSERT INTO session_meta (
                    session_id,
                    cached_m0_bytes,
                    cached_m1_bytes,
                    cached_m0_project_memory_epoch,
                    cached_m0_project_user_profile_version,
                    cached_m0_max_compartment_seq,
                    cached_m0_max_memory_id,
                    cached_m0_max_mutation_id,
                    cached_m0_max_memory_mutation_id,
                    cached_m0_project_docs_hash,
                    cached_m0_materialized_at,
                    cached_m0_session_facts_version,
                    cached_m0_upgrade_state,
                    cached_m0_system_hash,
                    cached_m0_tool_set_hash,
                    cached_m0_model_key,
                    cached_m0_last_baseline_end_message_id,
                    memory_block_cache,
                    memory_block_ids,
                    memory_block_count
                ) VALUES (
                    's1', X'0102', X'0304', 1, 2, 3, 4, 5, 6, 'docs', 7, 8, 'ready', 'sys', 'tools', 'model', 'msg-1', 'cache', '[1,2]', 2
                );
            `);

            runMigrations(db);

            const row = db
                .prepare("SELECT * FROM session_meta WHERE session_id = 's1'")
                .get() as Record<string, unknown>;
            for (const column of CLEARED_NULL_COLUMNS) {
                expect(row[column], column).toBeNull();
            }
            for (const column of CLEARED_EMPTY_COLUMNS) {
                expect(row[column], column).toBe("");
            }
            expect(row.memory_block_count).toBe(0);
            expect(tableColumns(db, "session_meta")).toContain("cached_m0_workspace_fingerprint");
        } finally {
            closeQuietly(db);
        }
    });
});
