import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import {
    bumpEpochsForWorkspaceMembers,
    computeWorkspaceEpochFingerprint,
    expandWorkspaceIdentitySet,
    resolveWorkspaceIdentitySet,
} from "./workspaces";

function openDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("workspace identity helpers", () => {
    test("resolves members and reverse-expands legacy aliases from the v22 rekey map", () => {
        const db = openDb();
        try {
            db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (1, 'ws', 1, 1);
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, 'git:new-a', 'A', '/a', 1), (1, 'git:new-b', 'B', '/b', 1);
                INSERT INTO v22_identity_rekey_map (old_project_path, new_project_path, rekeyed_at)
                VALUES ('/raw/path/a', 'git:new-a', 2);
            `);

            const set = resolveWorkspaceIdentitySet(db, "git:new-b");
            expect(set.identities).toEqual(["git:new-a", "git:new-b"]);
            expect(set.namesByIdentity.get("git:new-a")).toBe("A");
            expect(expandWorkspaceIdentitySet(db, set.identities).sort()).toEqual([
                "/raw/path/a",
                "git:new-a",
                "git:new-b",
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("workspace fingerprint is stable over sorted identity/epoch pairs", () => {
        const db = openDb();
        try {
            db.prepare(
                "INSERT INTO project_state (project_path, project_memory_epoch, project_user_profile_version, updated_at) VALUES (?, ?, 0, 1)",
            ).run("git:b", 2);
            db.prepare(
                "INSERT INTO project_state (project_path, project_memory_epoch, project_user_profile_version, updated_at) VALUES (?, ?, 0, 1)",
            ).run("git:a", 1);

            expect(computeWorkspaceEpochFingerprint(db, ["git:b", "git:a"])).toHaveLength(64);
            expect(computeWorkspaceEpochFingerprint(db, ["git:b", "git:a"])).toBe(
                computeWorkspaceEpochFingerprint(db, ["git:a", "git:b"]),
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("epoch fan-out bumps every member of the target workspace", () => {
        const db = openDb();
        try {
            db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (1, 'ws', 1, 1);
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, 'git:a', 'A', '/a', 1), (1, 'git:b', 'B', '/b', 1);
            `);

            bumpEpochsForWorkspaceMembers(db, "git:a", 10);

            expect(
                db
                    .prepare(
                        "SELECT project_memory_epoch FROM project_state WHERE project_path = 'git:a'",
                    )
                    .get(),
            ).toEqual({ project_memory_epoch: 1 });
            expect(
                db
                    .prepare(
                        "SELECT project_memory_epoch FROM project_state WHERE project_path = 'git:b'",
                    )
                    .get(),
            ).toEqual({ project_memory_epoch: 1 });
        } finally {
            closeQuietly(db);
        }
    });
});
