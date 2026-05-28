/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceAllCompartmentState } from "../../features/magic-context/compartment-storage";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import {
    bumpSessionFactsVersion,
    getOrCreateSessionMeta,
    queueM0Mutation,
    setProjectState,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import {
    clearInjectionCache,
    injectM0M1,
    MaterializeContentionError,
    materializeM0,
    materializeWithRetry,
    mustMaterialize,
    prepareCompartmentInjection,
    renderCompartmentInjection,
} from "./inject-compartments";
import type { MessageLike } from "./tag-messages";

const SESSION_ID = "ses_test_inject";
const PROJECT_PATH = "/tmp/test-inject-project";

let db: Database;
const tempDirs: string[] = [];

function makeDb(): Database {
    const d = new Database(":memory:");
    initializeDatabase(d);
    // session_meta row must exist for memory_block_cache writes
    getOrCreateSessionMeta(d, SESSION_ID);
    return d;
}

function makeProjectDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-renderer-test-"));
    tempDirs.push(dir);
    return dir;
}

function readStateFromMeta(): ReturnType<typeof getOrCreateSessionMeta> {
    return getOrCreateSessionMeta(db, SESSION_ID);
}

function renderedText(message: MessageLike): string {
    const part = message.parts[0] as { type: string; text?: string } | undefined;
    return part?.type === "text" ? (part.text ?? "") : "";
}

function userMessage(id: string, text: string): MessageLike {
    return {
        info: { id, role: "user", sessionID: SESSION_ID },
        parts: [{ type: "text", text }],
    };
}

afterEach(() => {
    if (db) db.close();
    clearInjectionCache(SESSION_ID);
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

describe("prepareCompartmentInjection — empty compartments fallback", () => {
    it("returns null when compartments, facts, and memories are all empty", () => {
        db = makeDb();
        const messages: MessageLike[] = [userMessage("m1", "hi")];
        const result = prepareCompartmentInjection(db, SESSION_ID, messages, true, PROJECT_PATH);
        expect(result).toBeNull();
        expect(messages.length).toBe(1);
    });

    it("injects memories-only block when no compartments exist", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "USER_DIRECTIVES",
            content: "User prefers concise responses",
        });

        const messages: MessageLike[] = [userMessage("m1", "original")];
        const result = prepareCompartmentInjection(db, SESSION_ID, messages, true, PROJECT_PATH);

        expect(result).not.toBeNull();
        expect(result?.compartmentCount).toBe(0);
        expect(result?.compartmentEndMessage).toBe(0);
        expect(result?.compartmentEndMessageId).toBe("");
        expect(result?.skippedVisibleMessages).toBe(0);
        expect(result?.factCount).toBe(0);
        expect(result?.memoryCount).toBe(1);
        expect(result?.block).toContain("<project-memory>");
        expect(result?.block).toContain("User prefers concise responses");
        // No splicing — original message preserved
        expect(messages.length).toBe(1);
        expect(messages[0].info.id).toBe("m1");
    });

    it("injects facts-only block when compartments empty but facts exist", () => {
        db = makeDb();
        replaceAllCompartmentState(
            db,
            SESSION_ID,
            [],
            [{ category: "DECISIONS", content: "Use SQLite" }],
        );

        const messages: MessageLike[] = [userMessage("m1", "go")];
        const result = prepareCompartmentInjection(db, SESSION_ID, messages, true, PROJECT_PATH);

        expect(result).not.toBeNull();
        expect(result?.compartmentCount).toBe(0);
        expect(result?.factCount).toBe(1);
        expect(result?.memoryCount).toBe(0);
        expect(result?.block).toContain("DECISIONS:");
        expect(result?.block).toContain("Use SQLite");
    });

    it("injects memories + facts combined block when no compartments", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "CONSTRAINTS",
            content: "Never commit without tests",
        });
        replaceAllCompartmentState(
            db,
            SESSION_ID,
            [],
            [{ category: "DECISIONS", content: "Monorepo layout" }],
        );

        const messages: MessageLike[] = [userMessage("m1", "hello")];
        const result = prepareCompartmentInjection(db, SESSION_ID, messages, true, PROJECT_PATH);

        expect(result).not.toBeNull();
        expect(result?.compartmentCount).toBe(0);
        expect(result?.factCount).toBe(1);
        expect(result?.memoryCount).toBe(1);
        expect(result?.block).toContain("<project-memory>");
        expect(result?.block).toContain("Never commit without tests");
        expect(result?.block).toContain("DECISIONS:");
    });

    it("renderCompartmentInjection wraps memory-only block in <session-history>", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "USER_DIRECTIVES",
            content: "test directive",
        });

        const messages: MessageLike[] = [userMessage("m1", "original")];
        const prepared = prepareCompartmentInjection(db, SESSION_ID, messages, true, PROJECT_PATH);
        expect(prepared).not.toBeNull();
        if (!prepared) return;

        const renderResult = renderCompartmentInjection(SESSION_ID, messages, prepared);
        expect(renderResult.injected).toBe(true);
        expect(renderResult.compartmentCount).toBe(0);

        // First message should now contain session-history prefix
        const firstPart = messages[0].parts[0] as { type: string; text: string };
        expect(firstPart.text).toContain("<session-history>");
        expect(firstPart.text).toContain("</session-history>");
        expect(firstPart.text).toContain("test directive");
        expect(firstPart.text).toContain("original");
    });
});

describe("prepareCompartmentInjection — transition from empty to compartment", () => {
    it("switches from memories-only to boundary-based splice after first compartment", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "USER_DIRECTIVES",
            content: "initial directive",
        });

        // Pass 1: no compartments yet — inject memories only
        const pass1Messages: MessageLike[] = [
            userMessage("m1", "hello"),
            userMessage("m2", "follow up"),
        ];
        const pass1 = prepareCompartmentInjection(
            db,
            SESSION_ID,
            pass1Messages,
            true,
            PROJECT_PATH,
        );
        expect(pass1?.compartmentCount).toBe(0);
        expect(pass1?.compartmentEndMessageId).toBe("");
        // No splice happened — both messages still present
        expect(pass1Messages.length).toBe(2);

        // Historian publishes compartment covering m1
        replaceAllCompartmentState(
            db,
            SESSION_ID,
            [
                {
                    sequence: 1,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "m1",
                    endMessageId: "m1",
                    title: "first compartment",
                    content: "Summary of early messages.",
                },
            ],
            [],
        );
        clearInjectionCache(SESSION_ID);

        // Pass 2: compartment exists — boundary-based splice should remove m1
        const pass2Messages: MessageLike[] = [
            userMessage("m1", "hello"),
            userMessage("m2", "follow up"),
        ];
        const pass2 = prepareCompartmentInjection(
            db,
            SESSION_ID,
            pass2Messages,
            true,
            PROJECT_PATH,
        );
        expect(pass2?.compartmentCount).toBe(1);
        expect(pass2?.compartmentEndMessageId).toBe("m1");
        expect(pass2?.skippedVisibleMessages).toBe(1);
        // m1 spliced out — only m2 remains
        expect(pass2Messages.length).toBe(1);
        expect(pass2Messages[0].info.id).toBe("m2");
        expect(pass2?.block).toContain("first compartment");
        expect(pass2?.block).toContain("initial directive");
    });

    it("defer pass replays memories-only cached injection without splicing", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "USER_DIRECTIVES",
            content: "directive",
        });

        // Bust pass: populate cache
        const bustMessages: MessageLike[] = [userMessage("m1", "hi")];
        const busted = prepareCompartmentInjection(
            db,
            SESSION_ID,
            bustMessages,
            true,
            PROJECT_PATH,
        );
        expect(busted?.compartmentCount).toBe(0);

        // Defer pass: should return cached without changing messages
        const deferMessages: MessageLike[] = [userMessage("m1", "hi"), userMessage("m2", "new")];
        const cached = prepareCompartmentInjection(
            db,
            SESSION_ID,
            deferMessages,
            false,
            PROJECT_PATH,
        );
        // Replayed-from-cache output must match the busted output structurally
        // on every field except `rebuiltFromDb` — that flag intentionally
        // differs (true on bust, false on replay) as a per-pass provenance
        // signal consumed by the postprocess drain. Plan v6.
        expect(busted?.rebuiltFromDb).toBe(true);
        expect(cached?.rebuiltFromDb).toBe(false);
        expect(cached?.block).toBe(busted?.block);
        expect(cached?.compartmentEndMessage).toBe(busted?.compartmentEndMessage);
        expect(cached?.compartmentEndMessageId).toBe(busted?.compartmentEndMessageId);
        expect(cached?.compartmentCount).toBe(busted?.compartmentCount);
        expect(cached?.skippedVisibleMessages).toBe(busted?.skippedVisibleMessages);
        expect(cached?.factCount).toBe(busted?.factCount);
        expect(cached?.memoryCount).toBe(busted?.memoryCount);
        // Empty boundary id ⇒ no splice
        expect(deferMessages.length).toBe(2);
    });
});

describe("prepareCompartmentInjection — SQLITE_BUSY handling (issue #23)", () => {
    it("swallows SQLITE_BUSY on memory_block_cache UPDATE and returns computed block anyway", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "USER_DIRECTIVES",
            content: "never run migrations manually",
        });

        // Proxy the db to throw SQLITE_BUSY specifically on the UPDATE statement
        // used by memory_block_cache. Other prepares pass through unchanged so
        // the rest of prepareCompartmentInjection can complete normally.
        const busyProxy: Database = new Proxy(db, {
            get(target, prop, receiver) {
                if (prop === "prepare") {
                    return (sql: string) => {
                        if (sql.includes("UPDATE session_meta SET memory_block_cache")) {
                            return {
                                run: () => {
                                    const err = new Error("database is locked") as Error & {
                                        code: string;
                                        errno: number;
                                    };
                                    err.code = "SQLITE_BUSY";
                                    err.errno = 5;
                                    throw err;
                                },
                                get: () => null,
                                all: () => [],
                            };
                        }
                        return target.prepare(sql);
                    };
                }
                return Reflect.get(target, prop, receiver);
            },
        });

        const messages: MessageLike[] = [userMessage("m1", "hello")];
        // Should not throw — the BUSY on the optional cache write must be swallowed.
        const result = prepareCompartmentInjection(
            busyProxy,
            SESSION_ID,
            messages,
            true,
            PROJECT_PATH,
        );

        expect(result).not.toBeNull();
        expect(result?.memoryCount).toBe(1);
        expect(result?.block).toContain("never run migrations manually");
    });

    it("rethrows non-BUSY errors from memory_block_cache UPDATE", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "USER_DIRECTIVES",
            content: "test directive",
        });

        const errorProxy: Database = new Proxy(db, {
            get(target, prop, receiver) {
                if (prop === "prepare") {
                    return (sql: string) => {
                        if (sql.includes("UPDATE session_meta SET memory_block_cache")) {
                            return {
                                run: () => {
                                    const err = new Error("schema mismatch") as Error & {
                                        code: string;
                                    };
                                    err.code = "SQLITE_CORRUPT";
                                    throw err;
                                },
                                get: () => null,
                                all: () => [],
                            };
                        }
                        return target.prepare(sql);
                    };
                }
                return Reflect.get(target, prop, receiver);
            },
        });

        const messages: MessageLike[] = [userMessage("m1", "hello")];
        expect(() =>
            prepareCompartmentInjection(errorProxy, SESSION_ID, messages, true, PROJECT_PATH),
        ).toThrow("schema mismatch");
    });
});

describe("m[0]/m[1] materialization", () => {
    it("mustMaterialize returns true on first call", () => {
        db = makeDb();
        const decision = mustMaterialize({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory: makeProjectDir(),
        });
        expect(decision).toEqual({ value: true, reason: "first_render" });
    });

    it("mustMaterialize returns false when cached markers match current state", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const state = readStateFromMeta();

        const decision = mustMaterialize({
            db,
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });

        expect(decision).toEqual({ value: false, reason: null });
    });

    it("mustMaterialize detects project_memory_epoch decreases after DB restore", () => {
        db = makeDb();
        setProjectState(db, PROJECT_PATH, { projectMemoryEpoch: 4 });
        const state = {
            ...readStateFromMeta(),
            cachedM0Bytes: Buffer.from("<session-history></session-history>"),
            cachedM0ProjectMemoryEpoch: 5,
            cachedM0ProjectUserProfileVersion: 0,
            cachedM0MaxCompartmentSeq: 0,
            cachedM0MaxMemoryId: 0,
            cachedM0MaxMutationId: 0,
            cachedM0ProjectDocsHash: "",
            cachedM0SessionFactsVersion: 0,
            cachedM0UpgradeState: "ready",
        };

        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory: makeProjectDir(),
            }).reason,
        ).toBe("project_memory_epoch");
    });

    it("mustMaterialize detects a new compartment via max sequence", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const state = readStateFromMeta();
        replaceAllCompartmentState(
            db,
            SESSION_ID,
            [
                {
                    sequence: 2,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "m1",
                    endMessageId: "m1",
                    title: "New",
                    content: "New summary",
                },
            ],
            [],
        );

        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }).reason,
        ).toBe("max_compartment_seq");
    });

    it("mustMaterialize detects a new m0_mutation_log entry by monotonic id", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const state = readStateFromMeta();
        queueM0Mutation(db, {
            sessionId: SESSION_ID,
            mutationType: "compartment_merge",
            queuedAt: 1,
        });

        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }).reason,
        ).toBe("max_mutation_id");
    });

    it("mustMaterialize detects project docs hash changes", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const state = readStateFromMeta();
        writeFileSync(join(projectDirectory, "ARCHITECTURE.md"), "# New architecture\n");

        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }).reason,
        ).toBe("project_docs_hash");
    });

    it("mustMaterialize detects a session facts version bump", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const state = readStateFromMeta();
        db.exec("BEGIN");
        bumpSessionFactsVersion(db, SESSION_ID);
        db.exec("COMMIT");

        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }).reason,
        ).toBe("session_facts_version");
    });

    it("materializeM0 Phase 3 commits all cached_m0 fields", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const result = materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const row = db
            .prepare(
                `SELECT cached_m0_bytes, cached_m0_project_memory_epoch,
                        cached_m0_project_user_profile_version, cached_m0_max_compartment_seq,
                        cached_m0_max_memory_id, cached_m0_max_mutation_id,
                        cached_m0_project_docs_hash, cached_m0_materialized_at,
                        cached_m0_session_facts_version, cached_m0_upgrade_state
                   FROM session_meta WHERE session_id = ?`,
            )
            .get(SESSION_ID) as Record<string, unknown>;

        expect(row.cached_m0_bytes).not.toBeNull();
        expect(Buffer.from(row.cached_m0_bytes as Buffer).toString("utf8")).toBe(result.m0Text);
        expect(row.cached_m0_project_memory_epoch).toBe(0);
        expect(row.cached_m0_project_user_profile_version).toBe(0);
        expect(row.cached_m0_max_compartment_seq).toBe(0);
        expect(row.cached_m0_max_memory_id).toBe(0);
        expect(row.cached_m0_max_mutation_id).toBe(0);
        expect(row.cached_m0_project_docs_hash).toBe("");
        expect(typeof row.cached_m0_materialized_at).toBe("number");
        expect(row.cached_m0_session_facts_version).toBe(0);
        expect(row.cached_m0_upgrade_state).toBe("ready");
    });

    it("materializeM0 throws MaterializeContentionError when epoch changes between snapshot and swap", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();

        expect(() =>
            materializeM0({
                db,
                sessionId: SESSION_ID,
                state: readStateFromMeta(),
                projectPath: PROJECT_PATH,
                projectDirectory,
                beforePhase3ForTest: () => {
                    setProjectState(db, PROJECT_PATH, { projectMemoryEpoch: 1 });
                },
            }),
        ).toThrow(MaterializeContentionError);
    });

    it("materializeWithRetry retries three times then throws", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        let attempts = 0;

        expect(() =>
            materializeWithRetry(
                {
                    db,
                    sessionId: SESSION_ID,
                    state: readStateFromMeta(),
                    projectPath: PROJECT_PATH,
                    projectDirectory,
                    beforePhase3ForTest: () => {
                        attempts += 1;
                        queueM0Mutation(db, {
                            sessionId: SESSION_ID,
                            mutationType: "compartment_merge",
                        });
                    },
                },
                3,
            ),
        ).toThrow(MaterializeContentionError);
        expect(attempts).toBe(3);
    });

    it("injectM0M1 updates root cached state after successful materialization", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        const messages = [userMessage("m1", "hello")];

        const result = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });

        expect(result.injected).toBe(true);
        expect(result.m0RematerializedThisPass).toBe(true);
        expect(state.cachedM0Bytes).toBeInstanceOf(Buffer);
        expect(state.cachedM0ProjectMemoryEpoch).toBe(0);
        expect(state.cachedM0MaxCompartmentSeq).toBe(0);
        expect(state.cachedM0MaxMutationId).toBe(0);
        expect(state.cachedM0ProjectDocsHash).toBe("");
        expect(typeof state.cachedM0MaterializedAt).toBe("number");
        expect(state.cachedM0SessionFactsVersion).toBe(0);
        expect(state.cachedM0UpgradeState).toBe("ready");
        expect(state.snapshotMarkers?.maxMemoryId).toBe(0);
        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }).value,
        ).toBe(false);
    });

    it("defer pass reuses byte-identical m[0] bytes from the prior materialization", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        const firstMessages = [userMessage("m1", "hello")];
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: firstMessages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const firstM0 = renderedText(firstMessages[0]);

        const secondMessages = [userMessage("m2", "hello again")];
        const second = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: secondMessages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });

        expect(second.m0RematerializedThisPass).toBe(false);
        expect(renderedText(secondMessages[0])).toBe(firstM0);
    });
});
