import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	__resetMessageIndexAsyncForTests,
	isSessionReconciled,
} from "@magic-context/core/features/magic-context/message-index-async";
import * as searchModule from "@magic-context/core/features/magic-context/search";
import {
	addNote,
	appendNoteNudgeAnchor,
	getHistorianFailureState,
	getNoteNudgeAnchors,
	getOrCreateSessionMeta,
	getPendingOps,
	getPendingPiCompactionMarkerState,
	getTagsBySession,
	incrementHistorianFailure,
	insertTag,
	queuePendingOp,
	setPendingPiCompactionMarkerState,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { checkCompartmentTrigger } from "@magic-context/core/hooks/magic-context/compartment-trigger";
import { deriveTriggerBudget } from "@magic-context/core/hooks/magic-context/derive-budgets";
import { resolveExecuteThreshold } from "@magic-context/core/hooks/magic-context/event-resolvers";
import { onNoteTrigger } from "@magic-context/core/hooks/magic-context/note-nudger";
import { withRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { clearModelsDevCache } from "@magic-context/core/shared/models-dev-cache";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import { clearAutoSearchForPiSession } from "./auto-search-pi";
import {
	awaitInFlightHistorians,
	clearContextHandlerSession,
	collectMessageEntryIdsByRef,
	collectMessageEntryIdsStrict,
	consumeDeferredHistoryRefresh,
	consumeDeferredMaterialization,
	recordPiLiveModel,
	registerPiContextHandler,
	resolvePiHistorianTriggerInputs,
	signalPiDeferredHistoryRefresh,
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
	trackSessionForProject,
} from "./context-handler";
import {
	getPiChannel1Baseline,
	setPiChannel1Baseline,
} from "./ctx-reduce-nudge-pi";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	textOf,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

describe("registerPiContextHandler", () => {
	afterEach(() => {
		__resetMessageIndexAsyncForTests();
		clearModelsDevCache();
		clearContextHandlerSession("ses-context");
		clearContextHandlerSession("ses-sticky-context");
		clearAutoSearchForPiSession("ses-context");
		clearAutoSearchForPiSession("ses-sticky-context");
	});

	it("evicts the least-recently-tracked session's per-session caches past the cap", () => {
		// Register a victim session with observable per-session state, then track
		// >100 newer sessions so the victim is evicted via clearContextHandlerSession.
		const victim = "ses-evict-victim";
		setPiChannel1Baseline(victim, {
			tailToolTokens: 1,
			historyBudgetTokens: 0,
			contextLimit: 0,
			executeThresholdPercentage: 65,
			lastInputTokens: 0,
			turnToolTokens: 0,
			reducedSinceRefresh: false,
		});
		trackSessionForProject("proj-evict", victim);
		expect(getPiChannel1Baseline(victim)).toBeDefined();

		// 100 newer sessions push the victim past the cap (it was tracked first).
		for (let i = 0; i < 100; i++) {
			trackSessionForProject("proj-evict", `ses-evict-${i}`);
		}

		// Victim's per-session Channel 1 baseline was cleared by eviction
		// (clearContextHandlerSession → clearPiChannel1State).
		expect(getPiChannel1Baseline(victim)).toBeUndefined();

		// Cleanup the survivors.
		clearContextHandlerSession(victim);
		for (let i = 0; i < 100; i++) clearContextHandlerSession(`ses-evict-${i}`);
	});

	it("schedules first-touch message index reconciliation", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = [userMessage("hello", 1)] as never[];

			await handler({ messages }, fakeContext("ses-context") as never);
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(isSessionReconciled("ses-context")).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	it("resolves per-project options via resolveForProject using the pass cwd", async () => {
		// Council #4 (project-config bleed on /cd): a Pi process can switch
		// projects mid-session; the context handler must resolve options from the
		// CURRENT pass cwd, not the launch-cwd base options. We assert the
		// resolver is consulted with ctx.cwd and that its returned options win
		// (here: a switched project disables ctx_reduce, so no §N§ prefix).
		const db = createTestDb();
		try {
			const fake = createFakePi();
			const seenDirs: string[] = [];
			const switchedDir = "/tmp/switched-project-abc";
			registerPiContextHandler(fake.pi as never, {
				db,
				// Base (launch) options: ctx_reduce ON.
				ctxReduceEnabled: true,
				resolveForProject: (dir: string) => {
					seenDirs.push(dir);
					// Switched checkout turns ctx_reduce OFF.
					return { db, ctxReduceEnabled: false };
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] } | undefined>;
			const messages = [userMessage("hello", 1)] as never[];

			await handler(
				{ messages },
				fakeContext("ses-switch", switchedDir) as never,
			);

			// The resolver was consulted with the pass's cwd.
			expect(seenDirs).toContain(switchedDir);
		} finally {
			closeQuietly(db);
		}
	});

	it("clears stale compartmentInProgress on first context pass after restart", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-zombie-historian";
			clearContextHandlerSession(sessionId);
			updateSessionMeta(db, sessionId, { compartmentInProgress: true });
			expect(getOrCreateSessionMeta(db, sessionId).compartmentInProgress).toBe(
				true,
			);

			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: false,
				historian: {
					runner: {} as SubagentRunner,
					model: "test/historian",
					historianChunkTokens: 8000,
					executeThresholdPercentage: 65,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = [userMessage("hello", 1)] as never[];
			const ctx = {
				...fakeContext(sessionId),
				getContextUsage: () => ({
					tokens: 1000,
					percent: 1,
					contextWindow: 100_000,
				}),
			};

			await handler({ messages }, ctx as never);

			expect(getOrCreateSessionMeta(db, sessionId).compartmentInProgress).toBe(
				false,
			);
		} finally {
			clearContextHandlerSession("ses-pi-zombie-historian");
			closeQuietly(db);
		}
	});

	it("resets stale persisted pressure on first context pass after restart", async () => {
		const db = createTestDb();
		const sessionId = "ses-pi-stale-pressure-restart";
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				protectedTags: 0,
				scheduler: { executeThresholdPercentage: 65 },
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = [
				userMessage("keep", 1),
				assistantMessage("do not drop on live low pressure", 2),
			] as never[];

			await handler({ messages }, fakeContext(sessionId) as never);
			queuePendingOp(db, sessionId, 2, "drop");
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 92,
				lastInputTokens: 92_000,
			});
			clearContextHandlerSession(sessionId);

			const ctx = {
				...fakeContext(sessionId),
				getContextUsage: () => ({
					tokens: 1_000,
					percent: 1,
					contextWindow: 100_000,
				}),
			};
			const result = await handler({ messages }, ctx as never);

			expect(textOf(result.messages[1] as never)).toContain(
				"do not drop on live low pressure",
			);
			const meta = getOrCreateSessionMeta(db, sessionId);
			expect(meta.lastContextPercentage).toBe(0);
			expect(meta.lastInputTokens).toBe(0);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("resets stale persisted pressure when Pi switches models", async () => {
		const db = createTestDb();
		const sessionId = "ses-pi-stale-pressure-model-switch";
		try {
			const fake = createFakePi();
			recordPiLiveModel(sessionId, "anthropic/old-model");
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				protectedTags: 0,
				scheduler: { executeThresholdPercentage: 65 },
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = [
				userMessage("keep", 1),
				assistantMessage("do not drop after model switch", 2),
			] as never[];

			await handler({ messages }, fakeContext(sessionId) as never);
			queuePendingOp(db, sessionId, 2, "drop");
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 88,
				lastInputTokens: 88_000,
				observedSafeInputTokens: 88_000,
				cacheAlertSent: true,
			});
			recordPiLiveModel(sessionId, "anthropic/old-model");

			const ctx = {
				...fakeContext(sessionId),
				model: { provider: "anthropic", id: "new-model" },
				getContextUsage: () => ({
					tokens: 2_000,
					percent: 2,
					contextWindow: 200_000,
				}),
			};
			const result = await handler({ messages }, ctx as never);

			expect(textOf(result.messages[1] as never)).toContain(
				"do not drop after model switch",
			);
			const meta = getOrCreateSessionMeta(db, sessionId);
			expect(meta.lastContextPercentage).toBe(0);
			expect(meta.lastInputTokens).toBe(0);
			expect(meta.observedSafeInputTokens).toBe(0);
			expect(meta.cacheAlertSent).toBe(false);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("tags user, assistant, and toolResult messages through the Pi adapter", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;

			const result = await handler(
				{
					messages: [
						userMessage("hello", 1),
						assistantMessage("answer", 2),
						toolResultMessage("call-1", "tool output", 3),
						userMessage("next", 4),
					] as never[],
				},
				fakeContext("ses-context") as never,
			);

			expect(textOf(result.messages[0] as never)).toMatch(/^§1§ hello/);
			expect(textOf(result.messages[1] as never)).toMatch(/^§2§ answer/);
			expect(textOf(result.messages[2] as never)).toMatch(/^§3§ tool output/);
			expect(
				getTagsBySession(db, "ses-context").map((tag) => tag.type),
			).toEqual(["message", "message", "tool", "message"]);
		} finally {
			closeQuietly(db);
		}
	});

	it("applies and drains pending drops for the session", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				// Disable protection so the immediate drop on tag #2 actually
				// materializes; otherwise the schema default (20) defers the
				// drop because tag #2 is in the protected window.
				protectedTags: 0,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;

			// Force scheduler to "execute" by pushing usage above the
			// default 65% threshold. Pi pending-ops materialization is
			// gated on schedulerDecision === "execute" || forceMaterialization
			// (mirrors OpenCode); without an over-threshold context, the
			// scheduler returns "defer" and drops correctly stay queued.
			const overThresholdCtx = {
				...fakeContext("ses-context"),
				getContextUsage: () => ({
					tokens: 70_000,
					percent: 70,
					contextWindow: 100_000,
				}),
			};
			await handler(
				{
					messages: [
						userMessage("keep user", 1),
						assistantMessage("drop assistant", 2),
					] as never[],
				},
				overThresholdCtx as never,
			);
			queuePendingOp(db, "ses-context", 2, "drop");
			const result = await handler(
				{
					messages: [
						userMessage("keep user", 1),
						assistantMessage("drop assistant", 2),
					] as never[],
				},
				overThresholdCtx as never,
			);

			expect(textOf(result.messages[1] as never)).toBe("[dropped §2§]");
			expect(getPendingOps(db, "ses-context")).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});

	it("injects deferred-note text into the latest new user message", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			addNote(db, "session", {
				sessionId: "ses-context",
				content: "Remember to update docs.",
			});
			onNoteTrigger(db, "ses-context", "historian_complete");

			const triggerMsg = userMessage("trigger turn", 1);
			const newMsg = userMessage("new turn", 2);
			await handler(
				{ messages: [triggerMsg] as never[] },
				fakeContext(
					"ses-context",
					process.cwd(),
					["entry-trigger"],
					[triggerMsg],
				) as never,
			);
			const result = await handler(
				{ messages: [newMsg] as never[] },
				fakeContext(
					"ses-context",
					process.cwd(),
					["entry-new"],
					[newMsg],
				) as never,
			);

			expect(textOf(result.messages[0] as never)).toContain(
				'<instruction name="deferred_notes">',
			);
			expect(textOf(result.messages[0] as never)).toContain("1 deferred note");
		} finally {
			closeQuietly(db);
		}
	});

	it("replays sticky note nudges idempotently across passes", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-sticky-context";
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			addNote(db, "session", {
				sessionId,
				content: "Sticky reminder.",
			});
			onNoteTrigger(db, sessionId, "historian_complete");
			const triggerMsg = userMessage("trigger turn", 1);
			const newMsg = userMessage("new turn", 2);
			await handler(
				{ messages: [triggerMsg] as never[] },
				fakeContext(
					sessionId,
					process.cwd(),
					["entry-trigger"],
					[triggerMsg],
				) as never,
			);
			await handler(
				{ messages: [newMsg] as never[] },
				fakeContext(sessionId, process.cwd(), ["entry-new"], [newMsg]) as never,
			);

			const result = await handler(
				{ messages: [newMsg] as never[] },
				fakeContext(sessionId, process.cwd(), ["entry-new"], [newMsg]) as never,
			);
			const onceMore = await handler(
				{ messages: result.messages },
				fakeContext(
					sessionId,
					process.cwd(),
					["entry-new"],
					[result.messages[0] as never],
				) as never,
			);

			expect(
				textOf(result.messages[0] as never).match(/deferred_notes/g),
			).toHaveLength(1);
			expect(
				textOf(onceMore.messages[0] as never).match(/deferred_notes/g),
			).toHaveLength(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("appends an auto-search hint to the latest user message when the threshold is met", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () =>
				[
					{
						source: "memory",
						content: "Relevant Pi search wiring",
						score: 0.9,
						memoryId: 1,
						category: "WORKFLOW_RULES",
						matchType: "fts",
					},
				] as never,
		);
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				autoSearch: {
					enabled: true,
					scoreThreshold: 0.6,
					minPromptChars: 10,
					memoryEnabled: true,
					embeddingEnabled: false,
					gitCommitsEnabled: false,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;

			const msg = userMessage("explain pi search wiring", 1);
			const result = await handler(
				{ messages: [msg] as never[] },
				fakeContext("ses-context", process.cwd(), ["entry-1"], [msg]) as never,
			);

			expect(spy).toHaveBeenCalledTimes(1);
			expect(textOf(result.messages[0] as never)).toContain(
				"<ctx-search-hint>",
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("clearContextHandlerSession preserves persisted auto-search decisions", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [],
		);
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				autoSearch: {
					enabled: true,
					scoreThreshold: 0.6,
					minPromptChars: 10,
					memoryEnabled: true,
					embeddingEnabled: false,
					gitCommitsEnabled: false,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;

			const msg = userMessage("explain pi search wiring", 1);
			await handler(
				{ messages: [msg] as never[] },
				fakeContext("ses-context", process.cwd(), ["entry-1"], [msg]) as never,
			);
			await handler(
				{ messages: [msg] as never[] },
				fakeContext("ses-context", process.cwd(), ["entry-1"], [msg]) as never,
			);
			clearContextHandlerSession("ses-context");
			await handler(
				{ messages: [msg] as never[] },
				fakeContext("ses-context", process.cwd(), ["entry-1"], [msg]) as never,
			);

			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("replays note anchors by message id but skips new note persistence on ref failure", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-note-ref-fail";
			clearContextHandlerSession(sessionId);
			appendNoteNudgeAnchor(
				db,
				sessionId,
				"entry-existing",
				'\n\n<instruction name="deferred_notes">existing</instruction>',
			);
			addNote(db, "session", { sessionId, content: "Fresh note should wait." });
			onNoteTrigger(db, sessionId, "historian_complete");
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const msg = { ...userMessage("new turn", 1), id: "entry-existing" };
			const result = await handler({ messages: [msg] as never[] }, {
				...fakeContext(sessionId),
				sessionManager: { getSessionId: () => sessionId },
			} as never);

			expect(textOf(result.messages[0] as never)).toContain("existing");
			expect(getNoteNudgeAnchors(db, sessionId)).toHaveLength(1);
		} finally {
			clearContextHandlerSession("ses-note-ref-fail");
			closeQuietly(db);
		}
	});

	it("persists model-resolved cache_ttl from Pi message_end assistant metadata", async () => {
		const db = createTestDb();
		try {
			const { persistPiMessageEndModelMeta } = await import("./index");

			persistPiMessageEndModelMeta({
				db,
				sessionId: "ses-context",
				message: assistantMessage("done", 1, {
					provider: "anthropic",
					model: "claude-sonnet-4-5",
				}),
				cacheTtlConfig: {
					default: "5m",
					"anthropic/claude-sonnet-4-5": "1h",
				},
			});

			expect(getOrCreateSessionMeta(db, "ses-context").cacheTtl).toBe("1h");
		} finally {
			clearContextHandlerSession("ses-context");
			closeQuietly(db);
		}
	});

	it("tracks Pi observed safe input token high-water mark", async () => {
		const db = createTestDb();
		try {
			const { persistPiPressureFromMessageEnd } = await import("./index");

			await persistPiPressureFromMessageEnd({
				db,
				sessionId: "ses-pi-pressure-safe",
				message: assistantMessage("done", 1, {
					usage: { input: 80_000, cacheRead: 10_000, cacheWrite: 0 },
				}),
				piContextWindow: 200_000,
			});
			await persistPiPressureFromMessageEnd({
				db,
				sessionId: "ses-pi-pressure-safe",
				message: assistantMessage("smaller", 2, {
					usage: { input: 50_000, cacheRead: 0, cacheWrite: 0 },
				}),
				piContextWindow: 200_000,
			});

			const meta = getOrCreateSessionMeta(db, "ses-pi-pressure-safe");
			expect(meta.observedSafeInputTokens).toBe(90_000);
			expect(meta.lastInputTokens).toBe(50_000);
		} finally {
			closeQuietly(db);
		}
	});

	it("alerts once when Pi's reported context window is below observed safe tokens", async () => {
		const db = createTestDb();
		try {
			const { persistPiPressureFromMessageEnd } = await import("./index");
			// Pi resolves the window from its own runtime (piContextWindow), not
			// models.dev. Use a wrong-but-still-SANE window (30k): sub-20k values
			// are rejected by the sanity floor, so the "reported window is wrong"
			// scenario must use a value inside [20k, 3M] that is still smaller than
			// the tokens the model successfully accepted.
			updateSessionMeta(db, "ses-pi-pressure-alert", {
				observedSafeInputTokens: 80_000,
			});
			const notify = mock(async () => undefined);

			for (const inputTokens of [90_000, 120_000]) {
				await persistPiPressureFromMessageEnd({
					db,
					sessionId: "ses-pi-pressure-alert",
					message: assistantMessage("done", 1, {
						provider: "test-provider",
						model: "test-model",
						usage: { input: inputTokens, cacheRead: 0, cacheWrite: 0 },
					}),
					piContextWindow: 30_000,
					notifyIssue: notify,
				});
			}

			const meta = getOrCreateSessionMeta(db, "ses-pi-pressure-alert");
			expect(meta.cacheAlertSent).toBe(true);
			expect(meta.lastContextPercentage).toBe(400);
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0]?.[0]).toContain(
				"context limit of 30,000 tokens",
			);
			expect(notify.mock.calls[0]?.[0]).toContain(
				"successfully sent 90,000 tokens",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("uses the live model key for scheduler execute_threshold_percentage resolution", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			recordPiLiveModel("ses-context", "anthropic/claude-sonnet-4-5");
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				protectedTags: 0,
				scheduler: {
					executeThresholdPercentage: {
						default: 90,
						"anthropic/claude-sonnet-4-5": 40,
					},
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const ctx = {
				...fakeContext("ses-context"),
				getContextUsage: () => ({
					tokens: 45_000,
					percent: 45,
					contextWindow: 100_000,
				}),
			};

			await handler(
				{
					messages: [
						userMessage("keep", 1),
						assistantMessage("drop", 2),
					] as never[],
				},
				ctx as never,
			);
			queuePendingOp(db, "ses-context", 2, "drop");
			const result = await handler(
				{
					messages: [
						userMessage("keep", 1),
						assistantMessage("drop", 2),
					] as never[],
				},
				ctx as never,
			);

			expect(textOf(result.messages[1] as never)).toBe("[dropped §2§]");
		} finally {
			clearContextHandlerSession("ses-context");
			closeQuietly(db);
		}
	});

	it("derives historian triggerBudget from the same live-session inputs as OpenCode", () => {
		const db = createTestDb();
		try {
			const modelKey = "test/model";
			const contextLimit = 200_000;
			const executeThresholdPercentage = { default: 90, [modelKey]: 70 };
			const executeThresholdTokens = { [modelKey]: 80_000 };
			const opencodeThreshold = resolveExecuteThreshold(
				executeThresholdPercentage,
				modelKey,
				65,
				{
					tokensConfig: executeThresholdTokens,
					contextLimit,
					sessionId: "ses-parity-budget",
				},
			);
			const opencodeBudget = deriveTriggerBudget(
				contextLimit,
				opencodeThreshold,
			);

			const piInputs = resolvePiHistorianTriggerInputs({
				db,
				sessionId: "ses-parity-budget",
				modelKey: undefined,
				usageContextLimit: contextLimit,
				historian: {
					runner: {} as SubagentRunner,
					model: "test/historian",
					historianChunkTokens: 8000,
					executeThresholdPercentage,
					executeThresholdTokens: { default: 80_000 },
				},
			});

			expect(piInputs.executeThresholdPercentage).toBe(opencodeThreshold);
			expect(piInputs.triggerBudget).toBe(opencodeBudget);
		} finally {
			closeQuietly(db);
		}
	});

	it("resolves the full checkCompartmentTrigger argument set per evaluation", () => {
		const db = createTestDb();
		try {
			const historian = {
				runner: {} as SubagentRunner,
				model: "test/historian",
				historianChunkTokens: 8000,
				executeThresholdPercentage: 65,
				executeThresholdTokens: { default: 40_000 },
				commitClusterTrigger: { enabled: false, min_clusters: 9 },
				protectedTags: 3,
				clearReasoningAge: 11,
			};

			const small = resolvePiHistorianTriggerInputs({
				db,
				sessionId: "ses-full-fields",
				historian,
				modelKey: undefined,
				usageContextLimit: 100_000,
			});
			const large = resolvePiHistorianTriggerInputs({
				db,
				sessionId: "ses-full-fields",
				historian: { ...historian, executeThresholdTokens: undefined },
				modelKey: undefined,
				usageContextLimit: 1_000_000,
			});

			expect(small).toMatchObject({
				executeThresholdPercentage: 40,
				triggerBudget: 5000,
				protectedTags: 3,
				clearReasoningAge: 11,
				commitClusterTrigger: { enabled: false, min_clusters: 9 },
				// ceiling = contextLimit(100k) × execThreshold(40%) = 40000
				emergencyCeilingTokens: 40_000,
			});
			expect(large.triggerBudget).toBe(32_500);
		} finally {
			closeQuietly(db);
		}
	});

	it("matches OpenCode compartment trigger decisions for identical resolved inputs", () => {
		const db = createTestDb();
		const sessionId = "ses-trigger-parity";
		try {
			const rawMessages = Array.from({ length: 20 }, (_, index) => ({
				ordinal: index + 1,
				id: `msg-${index + 1}`,
				role: "user",
				parts: [{ type: "text", text: `meaningful turn ${index + 1}` }],
			}));
			for (let i = 1; i <= 20; i++) {
				insertTag(db, sessionId, `msg-${i}`, "message", 1000, i);
			}
			const usage = { percentage: 64, inputTokens: 64_000 };
			const contextLimit = 200_000;
			const executeThresholdPercentage = 65;
			const triggerBudget = deriveTriggerBudget(
				contextLimit,
				executeThresholdPercentage,
			);
			const historian = {
				runner: {} as SubagentRunner,
				model: "test/historian",
				historianChunkTokens: 8000,
				executeThresholdPercentage,
				commitClusterTrigger: { enabled: true, min_clusters: 3 },
				protectedTags: 20,
				clearReasoningAge: 50,
			};
			const piInputs = resolvePiHistorianTriggerInputs({
				db,
				sessionId,
				historian,
				modelKey: undefined,
				usageContextLimit: contextLimit,
			});

			withRawMessageProvider(
				sessionId,
				{ readMessages: () => rawMessages },
				() => {
					const sessionMeta = getOrCreateSessionMeta(db, sessionId);
					const opencodeDecision = checkCompartmentTrigger(
						db,
						sessionId,
						sessionMeta,
						usage,
						0,
						executeThresholdPercentage,
						triggerBudget,
						50,
						{ enabled: true, min_clusters: 3 },
					);
					const piDecision = checkCompartmentTrigger(
						db,
						sessionId,
						sessionMeta,
						usage,
						0,
						piInputs.executeThresholdPercentage,
						piInputs.triggerBudget,
						piInputs.clearReasoningAge,
						piInputs.commitClusterTrigger,
					);

					expect(piInputs.triggerBudget).toBe(triggerBudget);
					expect(piDecision).toEqual(opencodeDecision);
					expect(piDecision).toEqual({
						shouldFire: true,
						reason: "projected_headroom",
					});
				},
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("persists and clears top-level transform errors", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] } | undefined>;
			const throwingEvent = {} as { messages: never[] };
			Object.defineProperty(throwingEvent, "messages", {
				get: () => {
					throw new Error("boom messages");
				},
			});

			await handler(throwingEvent, fakeContext("ses-context") as never);
			expect(getOrCreateSessionMeta(db, "ses-context").lastTransformError).toBe(
				"boom messages",
			);

			await handler(
				{ messages: [userMessage("ok", 2)] as never[] },
				fakeContext("ses-context") as never,
			);
			expect(getOrCreateSessionMeta(db, "ses-context").lastTransformError).toBe(
				null,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("walks the Pi branch only once per context event with historian enabled", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-branch-once";
			clearContextHandlerSession(sessionId);
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				historian: {
					runner: {} as SubagentRunner,
					model: "test/historian",
					historianChunkTokens: 8000,
					executeThresholdPercentage: 65,
					triggerBudget: 8000,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = [userMessage("hello", 1), assistantMessage("answer", 2)];
			let getBranchCalls = 0;
			await handler({ messages: messages as never[] }, {
				...fakeContext(sessionId),
				sessionManager: {
					getSessionId: () => sessionId,
					getBranch: () => {
						getBranchCalls += 1;
						return messages.map((message, index) => ({
							type: "message",
							id: `entry-${index + 1}`,
							message,
						}));
					},
				},
				getContextUsage: () => ({
					tokens: 100,
					percent: 1,
					contextWindow: 100_000,
				}),
			} as never);

			expect(getBranchCalls).toBe(1);
		} finally {
			clearContextHandlerSession("ses-pi-branch-once");
			closeQuietly(db);
		}
	});

	it("fires a recovery historian on the first pass after persisted failure", async () => {
		const db = createTestDb();
		try {
			incrementHistorianFailure(db, "ses-context", "previous failure");
			const runner = {
				harness: "pi",
				run: mock(async () => ({
					ok: true as const,
					assistantText:
						'<compartment start="1" end="2" title="Recovered">Recovered prior Pi history.</compartment>',
					durationMs: 1,
				})),
			} as unknown as SubagentRunner;
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				historian: {
					runner,
					model: "test/model",
					historianChunkTokens: 20_000,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = Array.from({ length: 12 }, (_, index) =>
				index % 2 === 0
					? userMessage(`user ${index}`, index + 1)
					: assistantMessage(`assistant ${index}`, index + 1),
			) as never[];
			const notify = mock(() => undefined);
			const ctx = {
				...fakeContext("ses-context"),
				ui: { notify },
				sessionManager: {
					getSessionId: () => "ses-context",
					getBranch: () =>
						messages.map((message, index) => ({
							type: "message",
							id: `entry-${index + 1}`,
							message,
						})),
				},
				getContextUsage: () => ({
					tokens: 100,
					percent: 10,
					contextWindow: 10_000,
				}),
			};

			await handler({ messages }, ctx as never);
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(runner.run).toHaveBeenCalledTimes(1);
			expect(notify).toHaveBeenCalledWith(
				expect.stringContaining("Historian recovery"),
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("first pass after restart PRESERVES historian-failure + reasoning watermark while clearing usage", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-firstpass-preserve";
			// Simulate pre-restart state: persisted pressure (so the reset block
			// fires), a persisted historian failure (restart recovery needs it),
			// and a reasoning watermark (clearing it would resurface reasoning).
			incrementHistorianFailure(db, sessionId, "previous failure");
			updateSessionMeta(db, sessionId, {
				lastContextPercentage: 62,
				lastInputTokens: 120_000,
				clearedReasoningThroughTag: 7,
			});
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const msg = userMessage("after restart", 1);
			await handler({ messages: [msg] as never[] }, {
				...fakeContext(sessionId),
				sessionManager: { getSessionId: () => sessionId },
				// Same model as before (no model change) → first-pass path only.
				getContextUsage: () => ({
					tokens: 120_000,
					percent: 62,
					contextWindow: 200_000,
				}),
			} as never);

			const meta = getOrCreateSessionMeta(db, sessionId);
			// Usage fields cleared (stale pressure must not drive thresholds).
			expect(meta.lastContextPercentage).toBe(0);
			expect(meta.lastInputTokens).toBe(0);
			// PRESERVED — restart recovery + reasoning replay depend on these.
			expect(meta.clearedReasoningThroughTag).toBe(7);
			expect(
				getHistorianFailureState(db, sessionId).failureCount,
			).toBeGreaterThan(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps durable deferred publication signals when an in-flight historian publishes after session clear", async () => {
		const db = createTestDb();
		const sessionId = "ses-pi-cleared-historian-publish";
		let release!: () => void;
		try {
			incrementHistorianFailure(db, sessionId, "previous failure");
			const runner = {
				harness: "pi",
				run: mock(async () => {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return {
						ok: true as const,
						assistantText:
							'<compartment start="1" end="2" title="Cleared">Cleared session publication.</compartment>',
						durationMs: 1,
					};
				}),
			} as unknown as SubagentRunner;
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				historian: {
					runner,
					model: "test/model",
					historianChunkTokens: 20_000,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = Array.from({ length: 12 }, (_, index) =>
				index % 2 === 0
					? userMessage(`user ${index}`, index + 1)
					: assistantMessage(`assistant ${index}`, index + 1),
			) as never[];

			await handler(
				{ messages },
				fakeContext(
					sessionId,
					process.cwd(),
					messages.map((_, index) => `entry-${index + 1}`),
					messages as never,
				) as never,
			);
			expect(runner.run).toHaveBeenCalledTimes(1);

			clearContextHandlerSession(sessionId);
			release();
			await awaitInFlightHistorians();

			expect(consumeDeferredHistoryRefresh(sessionId)).toBe(true);
			expect(consumeDeferredMaterialization(sessionId)).toBe(true);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("keeps deferred publication signals when an in-flight historian publishes for an active session", async () => {
		const db = createTestDb();
		const sessionId = "ses-pi-active-historian-publish";
		let release!: () => void;
		try {
			incrementHistorianFailure(db, sessionId, "previous failure");
			const runner = {
				harness: "pi",
				run: mock(async () => {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return {
						ok: true as const,
						assistantText:
							'<compartment start="1" end="2" title="Active">Active session publication.</compartment>',
						durationMs: 1,
					};
				}),
			} as unknown as SubagentRunner;
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				historian: {
					runner,
					model: "test/model",
					historianChunkTokens: 20_000,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = Array.from({ length: 12 }, (_, index) =>
				index % 2 === 0
					? userMessage(`user ${index}`, index + 1)
					: assistantMessage(`assistant ${index}`, index + 1),
			) as never[];

			await handler(
				{ messages },
				fakeContext(
					sessionId,
					process.cwd(),
					messages.map((_, index) => `entry-${index + 1}`),
					messages as never,
				) as never,
			);
			release();
			await awaitInFlightHistorians();

			expect(consumeDeferredHistoryRefresh(sessionId)).toBe(true);
			expect(consumeDeferredMaterialization(sessionId)).toBe(true);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("isolates deferred publication signals across multiple in-flight sessions when one is cleared", async () => {
		const db = createTestDb();
		const clearedSessionId = "ses-pi-cleared-multi-historian";
		const activeSessionId = "ses-pi-active-multi-historian";
		const releases: Array<() => void> = [];
		try {
			incrementHistorianFailure(db, clearedSessionId, "previous failure");
			incrementHistorianFailure(db, activeSessionId, "previous failure");
			const runner = {
				harness: "pi",
				run: mock(async () => {
					const callIndex = releases.length;
					await new Promise<void>((resolve) => {
						releases.push(resolve);
					});
					return {
						ok: true as const,
						assistantText: `<compartment start="1" end="2" title="Multi ${callIndex}">Multi-session publication.</compartment>`,
						durationMs: 1,
					};
				}),
			} as unknown as SubagentRunner;
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				historian: {
					runner,
					model: "test/model",
					historianChunkTokens: 20_000,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const buildMessages = () =>
				Array.from({ length: 12 }, (_, index) =>
					index % 2 === 0
						? userMessage(`user ${index}`, index + 1)
						: assistantMessage(`assistant ${index}`, index + 1),
				) as never[];
			const clearedMessages = buildMessages();
			const activeMessages = buildMessages();

			await handler(
				{ messages: clearedMessages },
				fakeContext(
					clearedSessionId,
					process.cwd(),
					clearedMessages.map((_, index) => `cleared-entry-${index + 1}`),
					clearedMessages as never,
				) as never,
			);
			await handler(
				{ messages: activeMessages },
				fakeContext(
					activeSessionId,
					process.cwd(),
					activeMessages.map((_, index) => `active-entry-${index + 1}`),
					activeMessages as never,
				) as never,
			);
			expect(runner.run).toHaveBeenCalledTimes(2);

			clearContextHandlerSession(clearedSessionId);
			for (const release of releases) release();
			await awaitInFlightHistorians();

			expect(consumeDeferredHistoryRefresh(clearedSessionId)).toBe(true);
			expect(consumeDeferredMaterialization(clearedSessionId)).toBe(true);
			expect(consumeDeferredHistoryRefresh(activeSessionId)).toBe(true);
			expect(consumeDeferredMaterialization(activeSessionId)).toBe(true);
		} finally {
			clearContextHandlerSession(clearedSessionId);
			clearContextHandlerSession(activeSessionId);
			closeQuietly(db);
		}
	});
	describe("Pi deferred compaction marker drain", () => {
		function seedCompartment(
			db: ReturnType<typeof createTestDb>,
			sessionId: string,
		): void {
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "entry-1",
					endMessageId: "entry-2",
					title: "Compacted",
					content: "Older history.",
				},
			]);
		}

		async function runDrainPass(args: {
			db: ReturnType<typeof createTestDb>;
			sessionId: string;
			appendCompaction?: (...args: unknown[]) => string | undefined;
		}): Promise<void> {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db: args.db,
				ctxReduceEnabled: true,
				injection: { injectionBudgetTokens: 10_000 },
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = [
				userMessage("first", 1),
				assistantMessage("second", 2),
				userMessage("third", 3),
			] as never[];
			const ctx = fakeContext(
				args.sessionId,
				process.cwd(),
				["entry-1", "entry-2", "entry-3"],
				messages as never,
			) as never as {
				sessionManager: {
					appendCompaction?: (...args: unknown[]) => string | undefined;
				};
			};
			if (args.appendCompaction) {
				ctx.sessionManager.appendCompaction = args.appendCompaction;
			}
			await handler({ messages }, ctx as never);
		}

		it("drains a deferred Pi marker only on a materializing pass", async () => {
			const db = createTestDb();
			const sessionId = "ses-pi-marker-drain";
			try {
				seedCompartment(db, sessionId);
				setPendingPiCompactionMarkerState(db, sessionId, {
					firstKeptEntryId: "entry-3",
					endMessageId: "entry-2",
					ordinal: 2,
					tokensBefore: 10,
					summary: "summary",
					publishedAt: 1,
				});
				signalPiDeferredHistoryRefresh(sessionId);
				signalPiPendingMaterialization(sessionId);
				const appendCompaction = mock(() => "compact-1");

				await runDrainPass({ db, sessionId, appendCompaction });

				expect(appendCompaction).toHaveBeenCalledTimes(1);
				expect(getPendingPiCompactionMarkerState(db, sessionId)).toBeNull();
				expect(consumeDeferredHistoryRefresh(sessionId)).toBe(false);
			} finally {
				clearContextHandlerSession(sessionId);
				closeQuietly(db);
			}
		});

		it("preserves blob_Y and deferred signal when CAS clear loses to a newer blob", async () => {
			const db = createTestDb();
			const sessionId = "ses-pi-marker-cas-loss";
			const blobY = {
				firstKeptEntryId: "entry-3",
				endMessageId: "entry-2",
				ordinal: 2,
				tokensBefore: 20,
				summary: "newer",
				publishedAt: 2,
			};
			try {
				seedCompartment(db, sessionId);
				setPendingPiCompactionMarkerState(db, sessionId, {
					firstKeptEntryId: "entry-3",
					endMessageId: "entry-2",
					ordinal: 2,
					tokensBefore: 10,
					summary: "older",
					publishedAt: 1,
				});
				signalPiDeferredHistoryRefresh(sessionId);
				signalPiPendingMaterialization(sessionId);
				const appendCompaction = mock(() => {
					setPendingPiCompactionMarkerState(db, sessionId, blobY);
					return "compact-1";
				});

				await runDrainPass({ db, sessionId, appendCompaction });

				expect(getPendingPiCompactionMarkerState(db, sessionId)).toEqual(blobY);
				expect(consumeDeferredHistoryRefresh(sessionId)).toBe(true);
			} finally {
				clearContextHandlerSession(sessionId);
				closeQuietly(db);
			}
		});

		it("drains a manually seeded blob on an explicit flush/materialization pass", async () => {
			const db = createTestDb();
			const sessionId = "ses-pi-marker-flush-no-drain";
			const blob = {
				firstKeptEntryId: "entry-3",
				endMessageId: "entry-2",
				ordinal: 2,
				tokensBefore: 10,
				summary: "summary",
				publishedAt: 1,
			};
			try {
				seedCompartment(db, sessionId);
				setPendingPiCompactionMarkerState(db, sessionId, blob);
				signalPiHistoryRefresh(sessionId);
				signalPiPendingMaterialization(sessionId);
				const appendCompaction = mock(() => "compact-1");

				await runDrainPass({ db, sessionId, appendCompaction });

				expect(appendCompaction).toHaveBeenCalledTimes(1);
				expect(getPendingPiCompactionMarkerState(db, sessionId)).toBeNull();
			} finally {
				clearContextHandlerSession(sessionId);
				closeQuietly(db);
			}
		});
	});
});

describe("collectMessageEntryIdsStrict", () => {
	it("returns null on API unavailable or length mismatch", () => {
		expect(
			collectMessageEntryIdsStrict(
				{ sessionManager: {} } as never,
				1,
				"ses-strict",
			),
		).toBeNull();

		expect(
			collectMessageEntryIdsStrict(
				{
					sessionManager: {
						getBranch: () => [{ type: "message", id: "entry-1" }],
					},
				} as never,
				2,
				"ses-strict",
			),
		).toBeNull();
	});

	it("returns real entry ids and preserves synthetic undefined entries", () => {
		expect(
			collectMessageEntryIdsStrict(
				{
					sessionManager: {
						getBranch: () => [
							{ type: "message", id: "entry-1" },
							{ type: "compaction", firstKeptEntryId: "entry-2" },
							{ type: "message", id: "entry-2" },
						],
					},
				} as never,
				2,
				"ses-strict",
			),
		).toEqual([undefined, "entry-2"]);
	});
});

describe("collectMessageEntryIdsByRef", () => {
	it("returns null when SessionManager API is unavailable", () => {
		expect(
			collectMessageEntryIdsByRef(
				{ sessionManager: {} } as never,
				[userMessage("hi", 1)],
				"ses-ref",
			),
		).toBeNull();
	});

	it("resolves entry ids by reference identity, not by position", () => {
		// Same scenario as production: Pi's `agent.state.messages` and
		// `sessionManager.getBranch()` are in sync. Each event message has
		// a corresponding `type: "message"` branch entry whose `.message`
		// field is the SAME object reference.
		const m1 = userMessage("first", 1);
		const m2 = userMessage("second", 2);
		const m3 = userMessage("third", 3);
		const result = collectMessageEntryIdsByRef(
			{
				sessionManager: {
					getBranch: () => [
						{ type: "message", id: "entry-a", message: m1 },
						{ type: "message", id: "entry-b", message: m2 },
						{ type: "message", id: "entry-c", message: m3 },
					],
				},
			} as never,
			[m1, m2, m3],
			"ses-ref",
		);
		expect(result).toEqual(["entry-a", "entry-b", "entry-c"]);
	});

	it("survives off-by-one length divergence (regression for log-observed bug)", () => {
		// Production bug: Pi's `state.messages.length = N` while
		// `getBranch()` emit-eligible count = N ± 1. The position-based
		// walk in `collectMessageEntryIds` returned a slice with wrong
		// alignment. Reference-based resolution returns the correct
		// id for matched refs and undefined for unmatched, regardless
		// of length divergence.
		const m1 = userMessage("turn-1", 1);
		const m2 = userMessage("turn-2", 2);
		const m3 = userMessage("turn-3", 3);
		// `event.messages` has 3 entries but `getBranch()` only has 2
		// emit-eligible entries — Pi runtime hasn't appended turn-3
		// yet at the moment the context event fires (race window).
		const result = collectMessageEntryIdsByRef(
			{
				sessionManager: {
					getBranch: () => [
						{ type: "message", id: "entry-1", message: m1 },
						{ type: "message", id: "entry-2", message: m2 },
					],
				},
			} as never,
			[m1, m2, m3],
			"ses-ref",
		);
		expect(result).toEqual(["entry-1", "entry-2", undefined]);
	});

	it("survives catastrophic length divergence (issue #81 scenario)", () => {
		// Production bug: another Pi extension (e.g. condensed-milk-pi)
		// mutates `event.messages` in its own context handler, so the
		// messages we see have ZERO ref-identity overlap with the
		// branch entries. Position-based walk would map every index
		// to the wrong id; reference-based walk returns undefined for
		// every slot, leaving the caller's synthesized fallback to
		// handle them.
		const mutated = [
			userMessage("mutated-1", 1),
			userMessage("mutated-2", 2),
			userMessage("mutated-3", 3),
		];
		const branchOriginals = [
			userMessage("original-1", 1),
			userMessage("original-2", 2),
		];
		const result = collectMessageEntryIdsByRef(
			{
				sessionManager: {
					getBranch: () => [
						{ type: "message", id: "entry-a", message: branchOriginals[0] },
						{ type: "message", id: "entry-b", message: branchOriginals[1] },
					],
				},
			} as never,
			mutated,
			"ses-ref",
		);
		// All slots unmapped because no ref identity overlaps.
		expect(result).toEqual([undefined, undefined, undefined]);
	});

	it("resolves cloned message wrappers with fingerprint fallback", () => {
		const original = {
			...userMessage("same text", 10),
			responseId: "resp-1",
		};
		const clone = {
			...userMessage("same text", 10),
			responseId: "resp-1",
		};

		const result = collectMessageEntryIdsByRef(
			{
				sessionManager: {
					getBranch: () => [
						{ type: "message", id: "entry-clone", message: original },
					],
				},
			} as never,
			[clone as never],
			"ses-ref",
		);

		expect(result).toEqual(["entry-clone"]);
	});

	it("does not fingerprint-resolve ambiguous cloned repeated messages", () => {
		const originalA = userMessage("same text", 10);
		const originalB = userMessage("same text", 10);
		const clone = userMessage("same text", 10);

		const result = collectMessageEntryIdsByRef(
			{
				sessionManager: {
					getBranch: () => [
						{ type: "message", id: "entry-a", message: originalA },
						{ type: "message", id: "entry-b", message: originalB },
					],
				},
			} as never,
			[clone],
			"ses-ref",
		);

		expect(result).toEqual([undefined]);
	});

	it("skips non-message entry types and entries with missing fields", () => {
		// `compaction` and `branch_summary` entries are NOT used for
		// ref-mapping (Pi's `buildSessionContext` wraps them in fresh
		// objects per call, so reference matching would fail anyway).
		const m1 = userMessage("user-msg", 1);
		const result = collectMessageEntryIdsByRef(
			{
				sessionManager: {
					getBranch: () => [
						{ type: "model_change", id: "entry-mc" },
						{ type: "thinking_level_change", id: "entry-tlc" },
						{ type: "compaction", id: "entry-comp", firstKeptEntryId: "x" },
						{ type: "branch_summary", id: "entry-bs", summary: "x" },
						{ type: "message", id: "entry-msg", message: m1 },
					],
				},
			} as never,
			[m1],
			"ses-ref",
		);
		expect(result).toEqual(["entry-msg"]);
	});
});

describe("maybeFireHistorian raw provider cleanup", () => {
	it("unregisters the raw-message provider in finally when no historian is spawned", () => {
		const src = readFileSync(
			join(import.meta.dir, "context-handler.ts"),
			"utf8",
		);
		const start = src.indexOf("function maybeFireHistorian");
		const end = src.indexOf("interface RunPipelineArgs", start);
		const body = src.slice(start, end);

		expect(body).toContain("let triggered = false");
		expect(body).toContain("if (!trigger.shouldFire)");
		expect(body).toContain("} finally {");
		expect(body).toContain("if (!triggered) unregister();");
	});
});
