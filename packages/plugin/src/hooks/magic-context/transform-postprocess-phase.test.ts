/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import {
    addStaleReduceStrippedIds,
    advanceToolReclaimWatermark,
    getActiveTagsBySession,
    getOrCreateSessionMeta,
    getProcessedImageStrippedIds,
    getTagsBySession,
    insertTag,
    queueM0Mutation,
    queuePendingOp,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { registerActiveCompartmentRun } from "./compartment-runner";
import { injectM0M1, type M0HardSignals } from "./inject-compartments";
import type { MessageLike, TagTarget } from "./tag-messages";
import {
    checkM0MutationDriftAndSignal,
    runPostTransformPhase,
} from "./transform-postprocess-phase";

const SESSION_ID = "ses-postprocess-drift";
let db: Database;

afterEach(() => {
    if (db) db.close();
});

describe("m[0] mutation drift watcher", () => {
    it("schedules next-pass materialization when m0_mutation_log gets a newer id", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const pendingMaterializationSessions = new Set<string>();
        const historyRefreshSessions = new Set<string>();

        queueM0Mutation(db, {
            sessionId: SESSION_ID,
            mutationType: "compartment_merge",
            queuedAt: 1,
        });

        const scheduled = checkM0MutationDriftAndSignal({
            db,
            sessionId: SESSION_ID,
            cachedM0MaxMutationId: 0,
            pendingMaterializationSessions,
            historyRefreshSessions,
        });

        expect(scheduled).toBe(true);
        expect(pendingMaterializationSessions.has(SESSION_ID)).toBe(true);
        expect(historyRefreshSessions.has(SESSION_ID)).toBe(true);
    });

    it("does not schedule when the cached monotonic mutation id is current", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const mutation = queueM0Mutation(db, {
            sessionId: SESSION_ID,
            mutationType: "compartment_merge",
        });
        const pendingMaterializationSessions = new Set<string>();

        const scheduled = checkM0MutationDriftAndSignal({
            db,
            sessionId: SESSION_ID,
            cachedM0MaxMutationId: mutation.id,
            pendingMaterializationSessions,
        });

        expect(scheduled).toBe(false);
        expect(pendingMaterializationSessions.has(SESSION_ID)).toBe(false);
    });
});

function makeToolMessage(id: string): MessageLike {
    return {
        info: { id, role: "assistant" },
        parts: [
            {
                type: "tool",
                tool: "bash",
                state: { output: "x".repeat(4000), status: "completed" },
            },
        ],
    } as unknown as MessageLike;
}

function makeDropTarget(message: MessageLike): TagTarget {
    return {
        message,
        setContent: () => false,
        drop: () => {
            const index = message.parts.findIndex(
                (part) => (part as { type?: string }).type === "tool",
            );
            if (index < 0) return "absent";
            message.parts.splice(index, 1);
            return "removed";
        },
        truncate: () => {
            const part = message.parts.find(
                (candidate) => (candidate as { type?: string }).type === "tool",
            ) as { state?: { output?: string } } | undefined;
            if (!part?.state) return "absent";
            // Skeleton-drop renders the one canonical placeholder (the real
            // target uses `[dropped §N§]`); this mock mirrors the word.
            part.state.output = "[dropped]";
            return "truncated";
        },
        canDrop: () => message.parts.some((part) => (part as { type?: string }).type === "tool"),
    };
}

type PostTransformArgs = Parameters<typeof runPostTransformPhase>[0];

function basePostTransformArgs(
    db: Database,
    sessionId: string,
    messages: MessageLike[],
    overrides: Partial<PostTransformArgs> = {},
): PostTransformArgs {
    return {
        sessionId,
        db,
        messages,
        tags: [],
        targets: new Map(),
        reasoningByMessage: new Map(),
        messageTagNumbers: new Map(),
        batch: null,
        contextUsage: { percentage: 20, inputTokens: 1000 },
        schedulerDecision: "defer",
        fullFeatureMode: true,
        canRunCompartments: false,
        awaitedCompartmentRun: false,
        phaseJustAwaitedPublication: false,
        compartmentInProgress: false,
        historyRefreshExplicitBeforePrepare: false,
        deferredHistoryWasPendingAtPassStart: false,
        compartmentInjectionRebuiltFromDb: false,
        rebuiltHistoryFromInitialPrepare: false,
        historyRebuiltThisPass: false,
        canConsumeDeferredLate: false,
        sessionMeta: getOrCreateSessionMeta(db, sessionId),
        currentTurnId: null,
        pendingMaterializationSessions: new Set(),
        deferredHistoryRefreshSessions: new Set(),
        deferredMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 999,
        protectedTags: 0,
        pendingCompartmentInjection: null,
        didMutateFromFlushedStatuses: false,
        watermark: 0,
        forceMaterializationPercentage: 85,
        hasRecentReduceCall: false,
        ...overrides,
    };
}

describe("postprocess emergency drop accounting", () => {
    it("plans emergency floor from tags that remain active after pending ops", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-postprocess-floor";
        const messages = [1, 2, 3, 4].map((tag) => makeToolMessage(`tool-${tag}`));
        const targets = new Map<number, TagTarget>();

        for (let tag = 1; tag <= 4; tag++) {
            insertTag(db, sessionId, `tool-${tag}`, "tool", 4000, tag, 0, "bash");
            targets.set(tag, makeDropTarget(messages[tag - 1]!));
        }
        queuePendingOp(db, sessionId, 1, "drop", 1);
        queuePendingOp(db, sessionId, 2, "drop", 2);

        // This is the stale pre-pending snapshot the transform caller has at pass
        // start. The postprocess phase must refresh it after applyPendingOperations.
        const staleActiveTags = getActiveTagsBySession(db, sessionId);

        await runPostTransformPhase({
            sessionId,
            db,
            messages,
            tags: staleActiveTags,
            targets,
            reasoningByMessage: new Map(),
            messageTagNumbers: new Map(),
            batch: { finalize: () => {} },
            contextUsage: { percentage: 90, inputTokens: 7000 },
            schedulerDecision: "execute",
            fullFeatureMode: true,
            canRunCompartments: false,
            awaitedCompartmentRun: false,
            phaseJustAwaitedPublication: false,
            compartmentInProgress: false,
            historyRefreshExplicitBeforePrepare: false,
            deferredHistoryWasPendingAtPassStart: false,
            compartmentInjectionRebuiltFromDb: false,
            rebuiltHistoryFromInitialPrepare: false,
            historyRebuiltThisPass: false,
            canConsumeDeferredLate: false,
            sessionMeta: getOrCreateSessionMeta(db, sessionId),
            currentTurnId: "turn-floor",
            pendingMaterializationSessions: new Set(),
            deferredHistoryRefreshSessions: new Set(),
            deferredMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            clearReasoningAge: 999,
            protectedTags: 0,
            emergencyCeilingTokens: 6000,
            pendingCompartmentInjection: null,
            didMutateFromFlushedStatuses: false,
            watermark: 0,
            forceMaterializationPercentage: 85,
            hasRecentReduceCall: false,
        });

        const statuses = getTagsBySession(db, sessionId).map((tag) => [tag.tagNumber, tag.status]);
        expect(statuses).toEqual([
            [1, "dropped"],
            [2, "dropped"],
            [3, "active"],
            [4, "active"],
        ]);
    });
});

describe("two-pass tool reclaim", () => {
    function tagStatuses(sessionId: string): Map<number, string> {
        return new Map(getTagsBySession(db, sessionId).map((tag) => [tag.tagNumber, tag.status]));
    }

    it("does not auto-drop on an execute pass with no confirmed wire mutation", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-reclaim-noop";
        const message = makeToolMessage("tool-1");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");
        advanceToolReclaimWatermark(db, sessionId, 1);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [message], {
                schedulerDecision: "execute",
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([[1, makeDropTarget(message)]]),
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        expect(tagStatuses(sessionId).get(1)).toBe("active");
        expect((message.parts[0] as { state?: { output?: string } }).state?.output).not.toBe(
            "[dropped]",
        );
    });

    it("auto-drops eligible old visible tools only when another confirmed mutation already happened", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-reclaim-mutating";
        const first = makeToolMessage("tool-1");
        const second = makeToolMessage("tool-2");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");
        insertTag(db, sessionId, "tool-2", "tool", 4000, 2, 0, "read");
        queuePendingOp(db, sessionId, 1, "drop", 1);
        advanceToolReclaimWatermark(db, sessionId, 2);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [first, second], {
                schedulerDecision: "execute",
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([
                    [1, makeDropTarget(first)],
                    [2, makeDropTarget(second)],
                ]),
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        const statuses = tagStatuses(sessionId);
        expect(statuses.get(1)).toBe("dropped");
        expect(statuses.get(2)).toBe("dropped");
        expect((second.parts[0] as { state?: { output?: string } }).state?.output).toBe(
            "[dropped]",
        );
    });

    it("does not persist a synthetic drop for an absent old DB tag", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-reclaim-absent";
        const visible = makeToolMessage("tool-2");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");
        insertTag(db, sessionId, "tool-2", "tool", 4000, 2, 0, "bash");
        queuePendingOp(db, sessionId, 2, "drop", 1);
        advanceToolReclaimWatermark(db, sessionId, 1);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [visible], {
                schedulerDecision: "execute",
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([[2, makeDropTarget(visible)]]),
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        const statuses = tagStatuses(sessionId);
        expect(statuses.get(1)).toBe("active");
        expect(statuses.get(2)).toBe("dropped");
    });

    it("suppresses two-pass reclaim in the emergency band but still advances the watermark on execute", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-reclaim-emergency";
        const first = makeToolMessage("tool-1");
        const second = makeToolMessage("tool-2");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");
        insertTag(db, sessionId, "tool-2", "tool", 4000, 2, 0, "read");
        queuePendingOp(db, sessionId, 1, "drop", 1);
        advanceToolReclaimWatermark(db, sessionId, 2);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [first, second], {
                schedulerDecision: "execute",
                contextUsage: { percentage: 90, inputTokens: 9000 },
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([
                    [1, makeDropTarget(first)],
                    [2, makeDropTarget(second)],
                ]),
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        const statuses = tagStatuses(sessionId);
        expect(statuses.get(1)).toBe("dropped");
        expect(statuses.get(2)).toBe("active");
        expect(getOrCreateSessionMeta(db, sessionId).toolReclaimWatermark).toBe(2);
    });

    it("advances the watermark on execute even when the auto-drop gate is closed", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-reclaim-advance";
        const message = makeToolMessage("tool-1");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [message], {
                schedulerDecision: "execute",
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([[1, makeDropTarget(message)]]),
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        expect(getOrCreateSessionMeta(db, sessionId).toolReclaimWatermark).toBe(1);
        expect(tagStatuses(sessionId).get(1)).toBe("active");
    });

    it("does not advance the watermark on a non-execute force-materialization pass", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-reclaim-force-defer";
        const message = makeToolMessage("tool-1");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [message], {
                schedulerDecision: "defer",
                contextUsage: { percentage: 90, inputTokens: 9000 },
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([[1, makeDropTarget(message)]]),
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        expect(getOrCreateSessionMeta(db, sessionId).toolReclaimWatermark).toBe(0);
    });
});

describe("known m[0] hard-fold folds the execute pass in", () => {
    const FOLD_PROJECT = "/tmp/test-hardfold-project";
    const BASE_HARD: M0HardSignals = {
        systemHash: "sys-v1",
        modelKey: "anthropic/opus",
        cacheExpired: false,
        lastResponseTime: 0,
    };

    function materializeBaseline(sessionId: string) {
        // Fold a baseline m[0] so the session is past first_render and markers are
        // captured; subsequent passes only HARD-fold on a real marker change.
        injectM0M1({
            db,
            sessionId,
            state: getOrCreateSessionMeta(db, sessionId),
            projectPath: FOLD_PROJECT,
            projectDirectory: FOLD_PROJECT,
            historyBudgetTokens: 98_000,
            isCacheBustingPass: true,
            hardSignals: BASE_HARD,
        });
    }

    it("drains queued pending ops on a DEFER scheduler pass when m[0] HARD-folds", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-hardfold-drain";
        materializeBaseline(sessionId);

        // A tool tag + a queued drop for it, exactly as a prior execute pass left.
        const message = makeToolMessage("tool-1");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");
        queuePendingOp(db, sessionId, 1, "drop", 1);
        const targets = new Map<number, TagTarget>([[1, makeDropTarget(message)]]);

        // Scheduler says DEFER (below execute threshold), but the model key changed
        // → m[0] will HARD-fold this pass. The fold should pull the queued drop in.
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [message], {
                schedulerDecision: "defer",
                contextUsage: { percentage: 40, inputTokens: 4000 },
                targets,
                currentTurnId: "turn-hardfold",
                m0M1: {
                    projectPath: FOLD_PROJECT,
                    projectDirectory: FOLD_PROJECT,
                    historyBudgetTokens: 98_000,
                    hardSignals: {
                        ...BASE_HARD,
                        modelKey: "anthropic/sonnet", // ← the HARD trigger
                    },
                },
            }),
        );

        // The queued drop materialized on the (otherwise-defer) hard-fold pass.
        expect(getTagsBySession(db, sessionId).find((t) => t.tagNumber === 1)?.status).toBe(
            "dropped",
        );
    });

    it("drains queued pending ops on an m[0] HARD-fold pass EVEN WHILE the historian runs", async () => {
        // The double-bust fix: a HARD fold (e.g. system-prompt change) re-caches
        // m[0] this pass, so the prefix is busting regardless. If the historian is
        // mid-run, the compartmentRunning veto USED to block the drain → it spilled
        // into a second bust ~a turn later. The fold-fold bypass must drain into
        // the one unavoidable bust instead. canRunCompartments=true + a registered
        // active run makes compartmentRunning=true.
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-hardfold-drain-while-historian";
        materializeBaseline(sessionId);

        const message = makeToolMessage("tool-1");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");
        queuePendingOp(db, sessionId, 1, "drop", 1);
        const targets = new Map<number, TagTarget>([[1, makeDropTarget(message)]]);

        // Historian in progress for this session (never resolves during the test).
        registerActiveCompartmentRun(sessionId, new Promise<void>(() => {}));

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [message], {
                schedulerDecision: "defer",
                contextUsage: { percentage: 40, inputTokens: 4000 },
                targets,
                currentTurnId: "turn-hardfold-historian",
                canRunCompartments: true,
                m0M1: {
                    projectPath: FOLD_PROJECT,
                    projectDirectory: FOLD_PROJECT,
                    historyBudgetTokens: 98_000,
                    hardSignals: {
                        ...BASE_HARD,
                        modelKey: "anthropic/sonnet", // ← the HARD trigger
                    },
                },
            }),
        );

        // Despite the historian running, the hard fold drained the queued drop
        // into this pass (no second bust later).
        expect(getTagsBySession(db, sessionId).find((t) => t.tagNumber === 1)?.status).toBe(
            "dropped",
        );
    });

    it("does NOT drain while the historian runs on a NON-busting defer pass", async () => {
        // Counterpart: same historian-running condition, but NO hard fold and NOT
        // an execute pass → the compartmentRunning veto still holds (don't mutate
        // the bytes the historian is reading on a pass that isn't busting anyway).
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-nofold-historian-novdrain";
        materializeBaseline(sessionId);

        const message = makeToolMessage("tool-1");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");
        queuePendingOp(db, sessionId, 1, "drop", 1);
        const targets = new Map<number, TagTarget>([[1, makeDropTarget(message)]]);

        registerActiveCompartmentRun(sessionId, new Promise<void>(() => {}));

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [message], {
                schedulerDecision: "defer",
                contextUsage: { percentage: 40, inputTokens: 4000 },
                targets,
                currentTurnId: "turn-nofold-historian",
                canRunCompartments: true,
                m0M1: {
                    projectPath: FOLD_PROJECT,
                    projectDirectory: FOLD_PROJECT,
                    historyBudgetTokens: 98_000,
                    hardSignals: BASE_HARD,
                },
            }),
        );

        expect(getTagsBySession(db, sessionId).find((t) => t.tagNumber === 1)?.status).toBe(
            "active",
        );
    });

    it("does NOT drain on a plain DEFER pass with no hard fold (baseline behavior)", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-nofold-nodrain";
        materializeBaseline(sessionId);

        const message = makeToolMessage("tool-1");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");
        queuePendingOp(db, sessionId, 1, "drop", 1);
        const targets = new Map<number, TagTarget>([[1, makeDropTarget(message)]]);

        // Same defer pass but markers UNCHANGED → no hard fold → drop stays queued.
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [message], {
                schedulerDecision: "defer",
                contextUsage: { percentage: 40, inputTokens: 4000 },
                targets,
                currentTurnId: "turn-nofold",
                m0M1: {
                    projectPath: FOLD_PROJECT,
                    projectDirectory: FOLD_PROJECT,
                    historyBudgetTokens: 98_000,
                    hardSignals: BASE_HARD,
                },
            }),
        );

        expect(getTagsBySession(db, sessionId).find((t) => t.tagNumber === 1)?.status).toBe(
            "active",
        );
    });
});

describe("postprocess empty-sentinel provider gate", () => {
    it("does not sentinelize cleared reasoning on github-copilot execute passes", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-copilot-cleared-reasoning";
        const messages: MessageLike[] = [
            {
                info: { id: "m-cleared", role: "assistant" },
                parts: [{ type: "thinking", thinking: "[cleared]" }],
            } as unknown as MessageLike,
        ];

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "execute",
                contextUsage: { percentage: 60, inputTokens: 6000 },
                currentTurnId: "turn-cleared",
                resolvedProviderID: "github-copilot",
            }),
        );

        expect(messages[0].parts).toEqual([{ type: "thinking", thinking: "[cleared]" }]);
    });

    it("leaves processed image file parts native for github-copilot", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-copilot-processed-image";
        const userMessage = {
            info: { id: "m-image", role: "user" },
            parts: [
                {
                    type: "file",
                    mime: "image/png",
                    url: `data:image/png;base64,${"a".repeat(220)}`,
                },
            ],
        } as unknown as MessageLike;
        const messages: MessageLike[] = [
            userMessage,
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "text", text: "seen" }],
            },
        ] as unknown as MessageLike[];

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                watermark: 1,
                messageTagNumbers: new Map([[userMessage, 1]]),
                resolvedProviderID: "github-copilot",
            }),
        );

        expect(userMessage.parts[0]).toMatchObject({ type: "file", mime: "image/png" });
        expect(userMessage.parts).not.toContainEqual({ type: "text", text: "" });
    });

    it("still sentinelizes processed image file parts for anthropic", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-anthropic-processed-image";
        const userMessage = {
            info: { id: "m-image", role: "user" },
            parts: [
                {
                    type: "file",
                    mime: "image/png",
                    url: `data:image/png;base64,${"a".repeat(220)}`,
                },
            ],
        } as unknown as MessageLike;
        const messages: MessageLike[] = [
            userMessage,
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "text", text: "seen" }],
            },
        ] as unknown as MessageLike[];

        // First-strip now requires a cache-busting (execute) pass; the id is
        // then frozen so it replays on later defer passes.
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                watermark: 1,
                messageTagNumbers: new Map([[userMessage, 1]]),
                resolvedProviderID: "anthropic",
                schedulerDecision: "execute",
                contextUsage: { percentage: 60, inputTokens: 6000 },
                currentTurnId: "turn-img",
            }),
        );

        expect(userMessage.parts).toEqual([{ type: "text", text: "" }]);
        expect([...getProcessedImageStrippedIds(db, sessionId)]).toEqual(["m-image"]);
    });

    it("does not replay stale ctx_reduce frozen ids as empty sentinels for github-copilot", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-copilot-stale-reduce";
        addStaleReduceStrippedIds(db, sessionId, ["reduce-1"]);
        const messages: MessageLike[] = [
            {
                info: { id: "reduce-1", role: "tool" },
                parts: [
                    {
                        type: "tool",
                        tool: "ctx_reduce",
                        callID: "call-reduce",
                        state: { output: "Queued: drop §1§", status: "completed" },
                    },
                ],
            } as unknown as MessageLike,
        ];

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "defer",
                resolvedProviderID: "github-copilot",
            }),
        );

        expect(messages[0].parts[0]).toMatchObject({ type: "tool", tool: "ctx_reduce" });
    });
});
