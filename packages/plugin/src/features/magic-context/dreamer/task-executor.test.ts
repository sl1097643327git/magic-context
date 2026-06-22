/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { appendCompartments } from "../compartment-storage";
import { getMemoriesByProject, insertMemory, recordMemoryVerifications } from "../memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { getUserMemoryCandidates, insertUserMemory } from "../user-memory/storage-user-memory";
import { createDreamTaskExecutor } from "./task-executor";
import { leaseKeyFor } from "./task-registry";
import type { DreamTaskRuntimeConfig } from "./task-scheduler";

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

function assistantMessages(text: string) {
    return [
        {
            info: { role: "assistant", time: { created: Date.now() } },
            parts: [{ type: "text", text }],
        },
    ];
}

describe("createDreamTaskExecutor — curate", () => {
    test("runs whole-pool curation without verification gate or watermark patch", async () => {
        db = freshDb();
        const project = "/repo/project";
        const first = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "First memory uses src/first.ts because it is load-bearing.",
        });
        const second = insertMemory(db, {
            projectPath: project,
            category: "PROJECT_RULES",
            content: "Second memory is a project workflow rule.",
        });
        recordMemoryVerifications(db, first.id, ["src/first.ts"], Date.now());
        insertUserMemory(db, "Prefer concise answers globally.", []);

        let capturedPrompt = "";
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "dream-child" } })),
                prompt: mock(async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                    capturedPrompt = args.body?.parts?.[0]?.text ?? "";
                    return {};
                }),
                messages: mock(async () => ({ data: assistantMessages("curation complete") })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const config: DreamTaskRuntimeConfig = {
            task: "curate",
            schedule: "0 4 * * 0",
            timeoutMinutes: 20,
        };

        const result = await executor(config, {
            db,
            projectIdentity: project,
            holderId: "holder-curate",
            leaseKey: leaseKeyFor("curate", project),
        });

        expect(result).toEqual({ status: "completed", schedulePatch: undefined });
        expect(capturedPrompt).toContain("## Task: Curate Project Memory Pool (hygiene)");
        expect(capturedPrompt).toContain(first.content);
        expect(capturedPrompt).toContain(second.content);
        expect(capturedPrompt).toContain("Mapped files: src/first.ts");
        expect(capturedPrompt).toContain("### Global user profile (for the redundancy check)");
        expect(capturedPrompt).toContain("Prefer concise answers globally.");
        expect(capturedPrompt).not.toContain('ctx_memory(action="verified"');
        expect(capturedPrompt).not.toContain("verified_files");
    });
});

describe("createDreamTaskExecutor — classify-memories", () => {
    test("loads active pool and last 30 trajectory compartments without verification gate", async () => {
        db = freshDb();
        const project = "/repo/project";
        const memory = insertMemory(db, {
            projectPath: project,
            category: "CONSTRAINTS",
            content: "External API requests must include x-trace-id for auditability.",
        });
        recordMemoryVerifications(db, memory.id, ["src/api.ts"], Date.now());
        db.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, 'opencode', ?, ?)",
        ).run("session-a", project, Date.now());
        appendCompartments(
            db,
            "session-a",
            Array.from({ length: 35 }, (_, i) => ({
                sequence: i + 1,
                startMessage: i * 2,
                endMessage: i * 2 + 1,
                startMessageId: `m${i}-a`,
                endMessageId: `m${i}-b`,
                title: `compartment ${i + 1}`,
                content: `trajectory content ${i + 1}`,
                p1: `trajectory p1 ${i + 1}`,
            })),
        );

        let capturedPrompt = "";
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "dream-child" } })),
                prompt: mock(async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                    capturedPrompt = args.body?.parts?.[0]?.text ?? "";
                    return {};
                }),
                messages: mock(async () => ({
                    data: assistantMessages("classification complete"),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });

        const result = await executor(
            { task: "classify-memories", schedule: "0 6 * * *", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-classify",
                leaseKey: leaseKeyFor("classify-memories", project),
            },
        );

        expect(result).toEqual({ status: "completed", schedulePatch: undefined });
        expect(capturedPrompt).toContain("## Task: Classify Project Memories");
        expect(capturedPrompt).toContain(memory.content);
        expect(capturedPrompt).toContain("importance=50 scope=project shareable=false");
        expect(capturedPrompt).toContain('ctx_memory(action="classify"');
        expect(capturedPrompt).not.toContain("Mapped files: src/api.ts");
        expect(capturedPrompt).not.toContain("git log");
        expect(capturedPrompt).toContain("compartment 35");
        expect(capturedPrompt).toContain("trajectory p1 35");
        expect(capturedPrompt).toContain("compartment 6");
        expect(capturedPrompt).not.toContain("compartment 5");
    });
});

describe("createDreamTaskExecutor — retrospective", () => {
    test("gate returns 'n' → one gate turn, child created+deleted, watermark advances, no deepen", async () => {
        db = freshDb();
        const project = "/repo/project";
        const provider = {
            listProjectSessions: mock(() => [{ sessionId: "s1" }]),
            readUserMessagesSince: mock(() => ({
                messages: [
                    {
                        sessionId: "s1",
                        ordinal: 1,
                        role: "user" as const,
                        text: "Please add a focused migration test for the new config key.",
                        ts: 200,
                    },
                ],
                truncated: false,
            })),
            readUserMessagesBefore: mock(() => []),
        };
        let prompts = 0;
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "retro-child" } })),
                prompt: mock(async () => {
                    prompts += 1;
                    return {};
                }),
                // Gate turn → verdict "n" (no friction). The deepen turn never runs.
                messages: mock(async () => ({ data: assistantMessages("n") })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            retrospectiveRawProvider: provider,
            userMemoryCollectionEnabled: true,
        });

        const result = await executor(
            { task: "retrospective", schedule: "0 5 * * *", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-retro-clean",
                leaseKey: leaseKeyFor("retrospective", project),
            },
        );

        // Completed with the content watermark advanced to the max ts scanned.
        expect(result).toEqual({
            status: "completed",
            schedulePatch: { retrospectiveWatermarkMs: 200 },
        });
        expect(client.session.create).toHaveBeenCalled();
        expect(prompts).toBe(1); // gate only — no deepen turn
        expect(client.session.delete).toHaveBeenCalled(); // child always cleaned up
        expect(getMemoriesByProject(db, project)).toHaveLength(0);
    });

    test("signal deepens, parses XML, host-applies memory and gated observation", async () => {
        db = freshDb();
        const project = "/repo/project";
        const provider = {
            listProjectSessions: mock(() => [{ sessionId: "s1" }]),
            readUserMessagesSince: mock(() => ({
                messages: [
                    {
                        sessionId: "s1",
                        ordinal: 1,
                        role: "user" as const,
                        text: "Please verify provider-executed tools on the wire before saying they work.",
                        ts: 200,
                    },
                    {
                        sessionId: "s1",
                        ordinal: 2,
                        role: "assistant" as const,
                        text: "It should work.",
                        ts: 210,
                    },
                    {
                        sessionId: "s1",
                        ordinal: 3,
                        role: "user" as const,
                        text: "Please verify provider executed tools on wire before saying they work.",
                        ts: 220,
                    },
                ],
                truncated: false,
            })),
        };
        provider.readUserMessagesBefore = mock(() => []);
        // The two turns share one `messages` mock — drive the response off the
        // per-prompt system string the runner sets: gate system → "y: <ord>",
        // deepen system → the learnings XML.
        const captured: Array<{ agent: string; system: string; prompt: string }> = [];
        let lastSystem = "";
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "retro-child" } })),
                prompt: mock(
                    async (args: {
                        body?: {
                            agent?: string;
                            system?: string;
                            parts?: Array<{ text?: string }>;
                        };
                    }) => {
                        lastSystem = args.body?.system ?? "";
                        captured.push({
                            agent: args.body?.agent ?? "",
                            system: lastSystem,
                            prompt: args.body?.parts?.[0]?.text ?? "",
                        });
                        return {};
                    },
                ),
                messages: mock(async () => {
                    const isGate = lastSystem.includes("friction detector");
                    return {
                        data: assistantMessages(
                            isGate
                                ? "y: 3"
                                : `<learnings>
  <learning route="memory" category="PROJECT_RULES">Verify provider-executed tool availability on wire before describing it as supported.</learning>
  <learning route="observation">Prefers concise root-cause summaries before implementation details.</learning>
  <learning route="memory" category="PROJECT_RULES">On 2026-06-01 the user said &quot;wrong again&quot;.</learning>
</learnings>`,
                        ),
                    };
                }),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            retrospectiveRawProvider: provider,
            userMemoryCollectionEnabled: true,
        });

        const result = await executor(
            { task: "retrospective", schedule: "0 5 * * *", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-retro-hit",
                leaseKey: leaseKeyFor("retrospective", project),
            },
        );

        expect(result).toEqual({
            status: "completed",
            schedulePatch: { retrospectiveWatermarkMs: 220 },
        });
        // Two turns: gate (friction-detector system) then deepen (learning system).
        expect(captured).toHaveLength(2);
        expect(captured[0]?.system).toContain("friction detector");
        expect(captured[1]?.agent).toBe("dreamer-retrospective");
        expect(captured[1]?.system).toContain("retrospective learning agent");
        expect(captured[1]?.prompt).toContain("### Friction window");
        expect(captured[1]?.prompt).not.toContain("ctx_memory");
        const memories = getMemoriesByProject(db, project);
        expect(memories.map((memory) => memory.content)).toEqual([
            "Verify provider-executed tool availability on wire before describing it as supported.",
        ]);
        expect(memories[0]?.sourceType).toBe("dreamer");
        expect(getUserMemoryCandidates(db).map((candidate) => candidate.content)).toEqual([
            "Prefers concise root-cause summaries before implementation details.",
        ]);
    });

    test("drops observation learnings when user-memory collection is disabled", async () => {
        db = freshDb();
        const project = "/repo/project";
        const provider = {
            listProjectSessions: mock(() => [{ sessionId: "s1" }]),
            readUserMessagesSince: mock(() => ({
                messages: [
                    {
                        sessionId: "s1",
                        ordinal: 1,
                        role: "user" as const,
                        text: "Please stop assuming CLI commands work without checking the actual output.",
                        ts: 200,
                    },
                    {
                        sessionId: "s1",
                        ordinal: 2,
                        role: "user" as const,
                        text: "Please stop assuming CLI commands work without checking actual output.",
                        ts: 220,
                    },
                ],
                truncated: false,
            })),
            readUserMessagesBefore: mock(() => []),
        };
        let lastSystem = "";
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "retro-child" } })),
                prompt: mock(async (args: { body?: { system?: string } }) => {
                    lastSystem = args.body?.system ?? "";
                    return {};
                }),
                messages: mock(async () => ({
                    data: assistantMessages(
                        lastSystem.includes("friction detector")
                            ? "y: 2"
                            : `<learnings>
  <learning route="observation">Prefers tool claims backed by observed command output.</learning>
</learnings>`,
                    ),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            retrospectiveRawProvider: provider,
            userMemoryCollectionEnabled: false,
        });

        await executor(
            { task: "retrospective", schedule: "0 5 * * *", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-retro-observation-off",
                leaseKey: leaseKeyFor("retrospective", project),
            },
        );

        expect(getUserMemoryCandidates(db)).toEqual([]);
    });
});
