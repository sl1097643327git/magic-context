import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "@magic-context/core/shared/sqlite";
import {
    applyMigrateSession,
    type MigrateSessionDeps,
    planMigrateSession,
} from "./migrate-session";

const databases: Array<{ close(): void }> = [];

afterEach(() => {
    for (const db of databases) {
        try {
            db.close();
        } catch {
            /* ignore */
        }
    }
    databases.length = 0;
});

function makeOpencodeDb(): Database {
    const db = new Database(":memory:");
    databases.push(db);
    db.exec(`
        CREATE TABLE session (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            directory TEXT,
            path TEXT,
            workspace_id TEXT,
            title TEXT
        );
        CREATE TABLE project (
            id TEXT PRIMARY KEY,
            worktree TEXT NOT NULL
        );
    `);
    db.prepare("INSERT INTO project (id, worktree) VALUES ('global', '/')").run();
    return db;
}

function makeContextDb(): Database {
    const db = new Database(":memory:");
    databases.push(db);
    db.exec(`
        CREATE TABLE memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            category TEXT NOT NULL,
            content TEXT NOT NULL,
            normalized_hash TEXT NOT NULL,
            importance INTEGER,
            source_session_id TEXT,
            source_type TEXT DEFAULT 'historian',
            seen_count INTEGER DEFAULT 1,
            status TEXT DEFAULT 'active',
            created_at INTEGER NOT NULL DEFAULT 0,
            UNIQUE(project_path, category, normalized_hash)
        );
        CREATE TABLE memory_embeddings (
            memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
            embedding BLOB NOT NULL,
            model_id TEXT
        );
        CREATE TABLE session_projects (
            session_id TEXT NOT NULL,
            harness TEXT NOT NULL DEFAULT 'opencode',
            project_path TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(session_id, harness)
        );
        CREATE TABLE compartment_chunk_embeddings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            project_path TEXT NOT NULL
        );
        CREATE TABLE session_meta (
            session_id TEXT PRIMARY KEY,
            cached_m0_bytes BLOB,
            cached_m1_bytes BLOB
        );
        CREATE TABLE project_state (
            project_path TEXT PRIMARY KEY,
            project_memory_epoch INTEGER NOT NULL DEFAULT 0,
            project_user_profile_version INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        );
    `);
    return db;
}

let hashCounter = 0;
function insertMemory(
    db: Database,
    projectPath: string,
    sourceSessionId: string | null,
    opts: { status?: string; category?: string; content?: string; withEmbedding?: boolean } = {},
): number {
    const content = opts.content ?? `memory-${++hashCounter}`;
    const hash = `hash-${hashCounter}`;
    const res = db
        .prepare(
            `INSERT INTO memories (project_path, category, content, normalized_hash, importance, source_session_id, source_type, seen_count, status, created_at)
             VALUES (?, ?, ?, ?, 50, ?, 'historian', 1, ?, 0)`,
        )
        .run(
            projectPath,
            opts.category ?? "ARCHITECTURE",
            content,
            hash,
            sourceSessionId,
            opts.status ?? "active",
        ) as { lastInsertRowid: number | bigint };
    const id = Number(res.lastInsertRowid);
    if (opts.withEmbedding) {
        db.prepare(
            "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?, ?, 'm')",
        ).run(id, new Uint8Array([1, 2, 3]));
    }
    return id;
}

const FROM = "git:from";
const TO = "git:to";
const SID = "ses_test";
const OTHER_SID = "ses_other";

function seedSession(oc: Database, ctx: Database): void {
    oc.prepare(
        "INSERT INTO session (id, project_id, directory, path) VALUES (?, 'global', '/old/dir', 'old/dir')",
    ).run(SID);
    ctx.prepare(
        "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, 'opencode', ?, 0)",
    ).run(SID, FROM);
    ctx.prepare(
        "INSERT INTO compartment_chunk_embeddings (session_id, project_path) VALUES (?, ?)",
    ).run(SID, FROM);
    ctx.prepare(
        "INSERT INTO compartment_chunk_embeddings (session_id, project_path) VALUES (?, ?)",
    ).run(SID, FROM);
    ctx.prepare("INSERT INTO session_meta (session_id, cached_m0_bytes) VALUES (?, ?)").run(
        SID,
        new Uint8Array([9]),
    );
}

function makeDeps(oc: Database, ctx: Database, targetIsGit = true): MigrateSessionDeps {
    return {
        opencodeDb: oc,
        contextDb: ctx,
        resolveIdentity: (dir) => (dir.includes("benchmarks") ? TO : FROM),
        hasGitDir: () => targetIsGit,
        realpath: (p) => p,
        now: 1000,
    };
}

describe("planMigrateSession", () => {
    it("resolves a git target to its existing project row", () => {
        const oc = makeOpencodeDb();
        const ctx = makeContextDb();
        oc.prepare("INSERT INTO project (id, worktree) VALUES ('proj_bench', ?)").run(
            "/home/u/benchmarks",
        );
        seedSession(oc, ctx);
        insertMemory(ctx, FROM, SID);
        insertMemory(ctx, FROM, OTHER_SID);

        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx, true));
        expect(plan.ocProjectId).toBe("proj_bench");
        expect(plan.ocWorktree).toBe("/home/u/benchmarks");
        expect(plan.ocProjectResolvedFromRow).toBe(true);
        expect(plan.sessionPath).toBe(""); // relative(worktree, dir) when equal
        expect(plan.fromMcIdentity).toBe(FROM);
        expect(plan.toMcIdentity).toBe(TO);
        expect(plan.injectableMemoryCount).toBe(2);
        expect(plan.originatedMemoryCount).toBe(1);
    });

    it("falls back to global (with flag) when a git target has no registered project (empty repo)", () => {
        const oc = makeOpencodeDb();
        const ctx = makeContextDb();
        seedSession(oc, ctx);
        // hasGitDir=true but no per-worktree project row → OpenCode would use
        // global (empty repo, no commit/remote). Must NOT dead-end.
        const plan = planMigrateSession(SID, "/home/u/unregistered", makeDeps(oc, ctx, true));
        expect(plan.ocProjectId).toBe("global");
        expect(plan.targetIsGit).toBe(true);
        expect(plan.ocProjectResolvedFromRow).toBe(false);
    });

    it("resolves a non-git target to the global project", () => {
        const oc = makeOpencodeDb();
        const ctx = makeContextDb();
        seedSession(oc, ctx);
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx, false));
        expect(plan.ocProjectId).toBe("global");
        expect(plan.ocWorktree).toBe("/");
        expect(plan.sessionPath).toBe("home/u/benchmarks");
        expect(plan.targetIsGit).toBe(false);
    });

    it("throws for an unknown session", () => {
        const oc = makeOpencodeDb();
        const ctx = makeContextDb();
        expect(() => planMigrateSession("ses_nope", "/x", makeDeps(oc, ctx))).toThrow(/not found/);
    });
});

describe("applyMigrateSession — OpenCode + context re-stamp", () => {
    it("updates the session row and re-stamps context.db, clearing cached m0/m1", () => {
        const oc = makeOpencodeDb();
        const ctx = makeContextDb();
        oc.prepare("INSERT INTO project (id, worktree) VALUES ('proj_bench', ?)").run(
            "/home/u/benchmarks",
        );
        seedSession(oc, ctx);
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx, true));
        const res = applyMigrateSession(plan, "leave", makeDeps(oc, ctx, true));

        const session = oc.prepare("SELECT * FROM session WHERE id = ?").get(SID) as {
            project_id: string;
            directory: string;
            path: string;
            workspace_id: string | null;
        };
        expect(session.project_id).toBe("proj_bench");
        expect(session.directory).toBe("/home/u/benchmarks");
        expect(session.workspace_id).toBeNull();

        const ownership = ctx
            .prepare("SELECT project_path FROM session_projects WHERE session_id = ?")
            .get(SID) as { project_path: string };
        expect(ownership.project_path).toBe(TO);
        expect(res.chunkEmbeddingsRestamped).toBe(2);
        const remainingOldChunks = (
            ctx
                .prepare(
                    "SELECT COUNT(*) AS c FROM compartment_chunk_embeddings WHERE session_id = ? AND project_path = ?",
                )
                .get(SID, FROM) as { c: number }
        ).c;
        expect(remainingOldChunks).toBe(0);
        const meta = ctx
            .prepare("SELECT cached_m0_bytes FROM session_meta WHERE session_id = ?")
            .get(SID) as { cached_m0_bytes: unknown };
        expect(meta.cached_m0_bytes).toBeNull();
        // "leave" → no memory movement, no epoch bump.
        expect(res.epochsBumped).toEqual([]);
    });

    it("only updates session columns that exist (schema-resilient)", () => {
        const oc = new Database(":memory:");
        databases.push(oc);
        oc.exec(
            "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT); CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);",
        );
        oc.prepare("INSERT INTO project (id, worktree) VALUES ('global', '/')").run();
        oc.prepare("INSERT INTO session (id, directory) VALUES (?, '/old')").run(SID);
        const ctx = makeContextDb();
        ctx.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, 'opencode', ?, 0)",
        ).run(SID, FROM);
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx, false));
        // Must not throw even though project_id/path/workspace_id columns are absent.
        applyMigrateSession(plan, "leave", makeDeps(oc, ctx, false));
        const row = oc.prepare("SELECT directory FROM session WHERE id = ?").get(SID) as {
            directory: string;
        };
        expect(row.directory).toBe("/home/u/benchmarks");
    });
});

describe("applyMigrateSession — memory actions", () => {
    function setup(): { oc: Database; ctx: Database } {
        const oc = makeOpencodeDb();
        const ctx = makeContextDb();
        oc.prepare("INSERT INTO project (id, worktree) VALUES ('proj_bench', ?)").run(
            "/home/u/benchmarks",
        );
        seedSession(oc, ctx);
        return { oc, ctx };
    }

    it("move-originated: only this session's memories move; source loses them; both epochs bump", () => {
        const { oc, ctx } = setup();
        insertMemory(ctx, FROM, SID, { withEmbedding: true });
        insertMemory(ctx, FROM, SID);
        insertMemory(ctx, FROM, OTHER_SID); // not this session
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx));
        const res = applyMigrateSession(plan, "move-originated", makeDeps(oc, ctx));

        expect(res.memoriesRelocated).toBe(2);
        expect(
            (
                ctx
                    .prepare("SELECT COUNT(*) AS c FROM memories WHERE project_path = ?")
                    .get(TO) as { c: number }
            ).c,
        ).toBe(2);
        expect(
            (
                ctx
                    .prepare("SELECT COUNT(*) AS c FROM memories WHERE project_path = ?")
                    .get(FROM) as { c: number }
            ).c,
        ).toBe(1);
        // embedding followed the moved row (memory_id unchanged on rekey)
        expect(
            (ctx.prepare("SELECT COUNT(*) AS c FROM memory_embeddings").get() as { c: number }).c,
        ).toBe(1);
        expect(res.epochsBumped.sort()).toEqual([FROM, TO].sort());
    });

    it("move-all: every injectable memory moves regardless of origin", () => {
        const { oc, ctx } = setup();
        insertMemory(ctx, FROM, SID);
        insertMemory(ctx, FROM, OTHER_SID);
        insertMemory(ctx, FROM, null, { status: "archived" }); // archived excluded
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx));
        const res = applyMigrateSession(plan, "move-all", makeDeps(oc, ctx));
        expect(res.memoriesRelocated).toBe(2);
        // archived stays under source
        expect(
            (
                ctx
                    .prepare(
                        "SELECT COUNT(*) AS c FROM memories WHERE project_path = ? AND status='archived'",
                    )
                    .get(FROM) as { c: number }
            ).c,
        ).toBe(1);
    });

    it("copy-originated: rows duplicated under target, source intact, embeddings duplicated", () => {
        const { oc, ctx } = setup();
        insertMemory(ctx, FROM, SID, { withEmbedding: true });
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx));
        const res = applyMigrateSession(plan, "copy-originated", makeDeps(oc, ctx));
        expect(res.memoriesRelocated).toBe(1);
        expect(
            (
                ctx
                    .prepare("SELECT COUNT(*) AS c FROM memories WHERE project_path = ?")
                    .get(FROM) as { c: number }
            ).c,
        ).toBe(1);
        expect(
            (
                ctx
                    .prepare("SELECT COUNT(*) AS c FROM memories WHERE project_path = ?")
                    .get(TO) as { c: number }
            ).c,
        ).toBe(1);
        expect(
            (ctx.prepare("SELECT COUNT(*) AS c FROM memory_embeddings").get() as { c: number }).c,
        ).toBe(2);
        // copy bumps only the target epoch
        expect(res.epochsBumped).toEqual([TO]);
    });

    it("move collision: an equivalent memory already at target merges instead of aborting", () => {
        const { oc, ctx } = setup();
        // same category+hash exists at BOTH from and to
        insertMemory(ctx, FROM, SID, { category: "NAMING", content: "dup", withEmbedding: false });
        ctx.prepare(
            `INSERT INTO memories (project_path, category, content, normalized_hash, importance, source_session_id, seen_count, status, created_at)
             VALUES (?, 'NAMING', 'dup', ?, 50, NULL, 5, 'active', 0)`,
        ).run(TO, `hash-${hashCounter}`); // same hash as the FROM row just inserted
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx));
        const res = applyMigrateSession(plan, "move-originated", makeDeps(oc, ctx));
        expect(res.memoriesMerged).toBe(1);
        // source row deleted, target keeps the larger seen_count
        expect(
            (
                ctx
                    .prepare("SELECT COUNT(*) AS c FROM memories WHERE project_path = ?")
                    .get(FROM) as { c: number }
            ).c,
        ).toBe(0);
        expect(
            (
                ctx
                    .prepare(
                        "SELECT seen_count FROM memories WHERE project_path = ? AND normalized_hash = ?",
                    )
                    .get(TO, `hash-${hashCounter}`) as { seen_count: number }
            ).seen_count,
        ).toBe(5);
    });

    it("copy collision: equivalent already at target is skipped (no duplicate)", () => {
        const { oc, ctx } = setup();
        insertMemory(ctx, FROM, SID, { category: "NAMING", content: "dup" });
        ctx.prepare(
            `INSERT INTO memories (project_path, category, content, normalized_hash, importance, source_session_id, seen_count, status, created_at)
             VALUES (?, 'NAMING', 'dup', ?, 50, NULL, 1, 'active', 0)`,
        ).run(TO, `hash-${hashCounter}`);
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx));
        const res = applyMigrateSession(plan, "copy-originated", makeDeps(oc, ctx));
        expect(res.memoriesSkipped).toBe(1);
        expect(res.memoriesRelocated).toBe(0);
        expect(
            (
                ctx
                    .prepare("SELECT COUNT(*) AS c FROM memories WHERE project_path = ?")
                    .get(TO) as { c: number }
            ).c,
        ).toBe(1);
    });
});
