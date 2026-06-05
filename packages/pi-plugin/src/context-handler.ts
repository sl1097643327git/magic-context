/**
 * Pi `context` event handler — the per-LLM-call transform pipeline.
 *
 * Pi fires `pi.on("context", ...)` immediately before each LLM
 * invocation, with the full `AgentMessage[]` that's about to be sent.
 * The handler can return `{ messages }` to replace the array.
 *
 * Step 4b.2 wires the smallest meaningful pipeline:
 *   1. Wrap the AgentMessage[] in a Transcript via `createPiTranscript`.
 *   2. Tag eligible parts with the shared `Tagger` and inject `§N§ `
 *      prefixes (unless `ctx_reduce_enabled: false`).
 *   3. Apply queued drops from `pending_ops` via the shared
 *      `applyPendingOperations` flow.
 *   4. Apply persistent dropped/truncated states from the `tags` table
 *      via `applyFlushedStatuses` so cross-session drops survive.
 *   5. Return the rebuilt messages so Pi sees the mutations.
 *
 * What's deliberately NOT in 4b.2:
 *
 * - Historian invocation. Compartment trigger logic and historian
 *   subprocess spawn live in 4b.3.
 * - Nudges (rolling, note-nudge, ctx_reduce reminders). 4b.4.
 * - Auto-search hint injection. 4b.4.
 * - Sentinel stripping for cache stability. Pi's transform model is
 *   single-pass-per-LLM-call, so OpenCode-style cache-bust avoidance
 *   doesn't apply. If a Pi provider exposes prompt cache later we'd
 *   add the relevant subset.
 * - Compaction marker injection. OpenCode-only — Pi doesn't have a
 *   compaction-event surface to inject into.
 *
 * Error handling: any thrown error is caught and logged, then the
 * original messages pass through unmodified. Pi's LLM call should
 * never fail because of a transform bug — same fail-open philosophy
 * as the OpenCode `messages-transform` wrapper.
 */

import * as crypto from "node:crypto";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	acquireCompartmentLease,
	COMPARTMENT_LEASE_RENEWAL_MS,
	releaseCompartmentLease,
	renewCompartmentLease,
} from "@magic-context/core/features/magic-context/compartment-lease";
import { getLastCompartmentEndMessage } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	clearSessionTracking,
	scheduleIncrementalIndex,
	scheduleReconciliation,
} from "@magic-context/core/features/magic-context/message-index-async";
import {
	createScheduler,
	parseCacheTtl,
} from "@magic-context/core/features/magic-context/scheduler";
import {
	adoptFallbackTagMessageId,
	type ContextDatabase,
	clearPendingPiCompactionMarkerStateIf,
	findAdoptableFallbackTags,
	getActiveTagsBySession,
	getHistorianFailureState,
	getPendingOps,
	getPendingPiCompactionMarkerState,
	getTagsByNumbers,
	getTopNBySize,
	setSessionWorkMetrics,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import {
	clearDeferredExecutePendingIfMatches,
	clearDetectedContextLimit,
	clearEmergencyRecovery,
	clearHistorianFailureState,
	clearPersistedReasoningWatermark,
	clearPersistedStickyTurnReminder,
	getAutoSearchHintDecisions,
	getNoteNudgeAnchors,
	getOverflowState,
	getPersistedStickyTurnReminder,
	peekDeferredExecutePending,
	pruneAutoSearchHintDecisions,
	pruneNoteNudgeAnchors,
	setDeferredExecutePendingIfAbsent,
	setPersistedStickyTurnReminder,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import {
	createTagger,
	type Tagger,
} from "@magic-context/core/features/magic-context/tagger";
import { computePiWorkMetrics } from "@magic-context/core/features/magic-context/work-metrics";
import {
	applyFlushedStatuses,
	applyPendingOperations,
} from "@magic-context/core/hooks/magic-context/apply-operations";
import {
	applyMidTurnDeferral,
	detectMidTurnBypassReason,
} from "@magic-context/core/hooks/magic-context/boundary-execution";
import { replayCavemanCompression } from "@magic-context/core/hooks/magic-context/caveman-cleanup";
import { checkCompartmentTrigger } from "@magic-context/core/hooks/magic-context/compartment-trigger";
import { deriveTriggerBudget } from "@magic-context/core/hooks/magic-context/derive-budgets";
import {
	DEFAULT_CONTEXT_LIMIT,
	resolveExecuteThreshold,
} from "@magic-context/core/hooks/magic-context/event-resolvers";
import { getVisibleMemoryIds } from "@magic-context/core/hooks/magic-context/inject-compartments";
import {
	markNoteNudgeDelivered,
	onNoteTrigger,
	peekNoteNudgeText,
} from "@magic-context/core/hooks/magic-context/note-nudger";
import { createNudger } from "@magic-context/core/hooks/magic-context/nudger";
import {
	getProtectedTailStartOrdinal,
	getRawSessionMessageCount,
	readRawSessionMessages,
	setRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { log, sessionLog } from "@magic-context/core/shared/logger";
import { isSaneLimit } from "@magic-context/core/shared/models-dev-cache";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import {
	clearAutoSearchForPiSession,
	runAutoSearchHintForPi,
} from "./auto-search-pi";
import {
	type ApplyDeferredPiCompactionMarkerDeps,
	applyDeferredPiCompactionMarker,
} from "./compaction-marker-manager-pi";
import { detectRecentCommit } from "./detect-recent-commit";
import { ensureProjectRegisteredFromPiDirectory } from "./embedding-bootstrap";
import {
	applyPiHeuristicCleanup,
	type PiHeuristicCleanupResult,
} from "./heuristic-cleanup-pi";
import {
	clearM0M1PiCache,
	injectM0M1Pi,
	type PiM0M1InjectionResult as PiInjectionResult,
} from "./inject-compartments-pi";
import { hasVisibleNoteReadCallPi } from "./note-visibility-pi";
import { injectPiNudge } from "./nudge-injector";
import { type PiHistorianDeps, runPiHistorian } from "./pi-historian-runner";
import { injectSyntheticTodowriteForPi } from "./pi-todo-inject";
import {
	convertEntriesToRawMessages,
	findLastModelKeyFromBranch,
	isMidTurnPi,
	readPiSessionMessages,
	resolvePiStableId,
} from "./read-session-pi";
import {
	buildMessageIdToMaxTag,
	clearOldReasoningPi,
	replayClearedReasoningPi,
	replayStrippedInlineThinkingPi,
	stripInlineThinkingPi,
} from "./reasoning-replay-pi";
import { stripPiDroppedPlaceholderMessages } from "./strip-placeholders-pi";
import { clearPiSystemPromptSession } from "./system-prompt";
import { injectPiTemporalMarkers } from "./temporal-awareness-pi";
/** Force-materialization threshold — mirrors OpenCode's FORCE_MATERIALIZE_PERCENTAGE (85%). */
import { withTimeout } from "./timeout";
import { tokenizePiMessages } from "./tokenize-pi-messages";
import { createPiTranscript } from "./transcript-pi";

const FORCE_MATERIALIZATION_PERCENTAGE = 85;

/** Emergency-block threshold — mirrors OpenCode's >=95% emergency path. */
const EMERGENCY_BLOCK_PERCENTAGE = 95;
const TOOL_HEAVY_TURN_REMINDER_THRESHOLD = 5;
const TOOL_HEAVY_TURN_REMINDER_TEXT =
	'\n\n<instruction name="ctx_reduce_turn_cleanup">Also drop via `ctx_reduce` things you don\'t need anymore from the last turn before continuing.</instruction>';

/**
 * Default `clear_reasoning_age` when neither the Pi caller nor the user
 * config specifies one. Matches OpenCode's schema default
 * (`packages/plugin/src/config/schema/magic-context.ts:303` → `.default(50)`).
 */
const DEFAULT_CLEAR_REASONING_AGE = 50;

/**
 * Current Pi message stable-id scheme version. Bump when the durable message
 * stable-id format changes in a way that re-keys persisted tag/source_contents/
 * caveman/placeholder state. A session whose persisted `pi_stable_id_scheme` is
 * below this triggers a one-time forced execute+materialize cutover.
 *   0 (NULL) = legacy index-based `pi-msg-${index}-...` ids.
 *   1        = real-SessionEntry-id scheme (resolvePiStableId).
 */
const PI_STABLE_ID_SCHEME = 1;

/**
 * Per-session emergency-notification dedup. Mirrors OpenCode's
 * `lastEmergencyNotificationCount` map — we only re-notify when the
 * historian failure count grows OR after a long quiet period, so a
 * stuck 95%+ session doesn't spam notifications on every defer pass.
 */
const lastEmergencyNotificationAtMs = new Map<string, number>();
const EMERGENCY_NOTIFICATION_COOLDOWN_MS = 60_000;

/**
 * Per-session "saw a commit on the previous pass" tracker for the
 * note-nudge `commit_detected` trigger. Mirrors OpenCode's
 * `commitSeenLastPass` map in `transform.ts`. The trigger only fires
 * on the rising edge: when this pass detects a recent commit AND the
 * previous pass did NOT (and we have a baseline at all — first-pass
 * detection silently sets the baseline without firing, so a fresh
 * restart over an old session that just committed doesn't surface a
 * stale trigger).
 *
 * Cleared in `clearContextHandlerSession()` so leaving a session
 * doesn't leave dead state behind.
 */
const commitSeenLastPass = new Map<string, boolean>();

/**
 * Three independent per-session refresh signals — mirrors OpenCode's
 * three-set split (transform.ts:444 + system-prompt-hash.ts:206 +
 * transform-postprocess-phase.ts:172). Each lifetime is consumed by a
 * different consumer so they cannot share state:
 *
 *  - `historyRefreshSessions`: invalidate the `<session-history>`
 *    injection cache. Set by `/ctx-flush`, historian publish,
 *    compressor publish. Drained inside runPipeline after the rebuild
 *    completes.
 *
 *  - `systemPromptRefreshSessions`: refresh disk/DB-derived adjuncts
 *    in the system prompt (`<project-docs>`, `<user-profile>`,
 *    `<key-files>`, sticky date). Set by `/ctx-flush`, system-prompt
 *    hash change, dreamer publish, user-memory promotion. Drained
 *    inside the `before_agent_start` handler after adjuncts have been
 *    refreshed (or kept cached).
 *
 *  - `pendingMaterializationSessions`: pending ops should materialize
 *    on the next execute pass. Set by `/ctx-flush`. Drained inside
 *    runPipeline once materialization runs.
 *
 * They get signaled together when a system-prompt hash change is
 * detected (the prefix cache is already busted, so all three caches
 * should rebuild on the same cycle).
 *
 * Module-scoped so command handlers, historian, and compressor can
 * write to them without holding a reference to the registerPiContextHandler
 * closure.
 */
const historyRefreshSessions = new Set<string>();
const systemPromptRefreshSessions = new Set<string>();
const pendingMaterializationSessions = new Set<string>();
const deferredHistoryRefreshSessions = new Set<string>();
const deferredMaterializationSessions = new Set<string>();
const sessionsByProject = new Map<string, Set<string>>();
const lastSeenProjectIdentityBySession = new Map<string, string>();
const rawMessageProviderUnregistersBySession = new Map<string, () => void>();
const activeContextHandlerSessions = new Set<string>();
const lastHeuristicsTurnIdBySession = new Map<string, string>();
const firstContextPassSeenBySession = new Set<string>();
const recentReduceBySession = new Map<string, number>();
const liveModelBySession = new Map<string, string>();
const toolUsageSinceUserTurn = new Map<string, number>();
const latestUserMessageBySession = new Map<string, string>();
const RECENT_REDUCE_TTL_MS = 5 * 60 * 1000;

function hasRecentPiCtxReduceExecution(sessionId: string): boolean {
	const recordedAt = recentReduceBySession.get(sessionId);
	if (recordedAt === undefined) return false;
	if (Date.now() - recordedAt <= RECENT_REDUCE_TTL_MS) return true;
	recentReduceBySession.delete(sessionId);
	return false;
}

function logTransformTiming(
	sessionId: string,
	stage: string,
	start: number,
	extra?: string,
): void {
	const elapsed = (performance.now() - start).toFixed(1);
	const suffix = extra ? ` ${extra}` : "";
	sessionLog(
		sessionId,
		`transform stage: stage=${stage} elapsed=${elapsed}ms${suffix}`,
	);
}

function resolvePiContextModelKey(ctx: ExtensionContext): string | undefined {
	const model = (ctx as { model?: { provider?: unknown; id?: unknown } }).model;
	if (!model) return undefined;
	if (typeof model.provider !== "string" || model.provider.length === 0) {
		return undefined;
	}
	if (typeof model.id !== "string" || model.id.length === 0) return undefined;
	return `${model.provider}/${model.id}`;
}

function readPiSessionMessageById(
	ctx: ExtensionContext,
	messageId: string,
): ReturnType<typeof readPiSessionMessages>[number] | null {
	return (
		readPiSessionMessages(ctx).find((message) => message.id === messageId) ??
		null
	);
}

/**
 * Mark a Pi session as needing an injection-cache rebuild on its next
 * transform pass. Cheap idempotent set add — multiple callers can
 * signal in the same window and only the next pass will see the
 * combined effect.
 */
export function signalPiHistoryRefresh(sessionId: string): void {
	historyRefreshSessions.add(sessionId);
}

/**
 * Mark a Pi session as needing system-prompt adjunct refresh on its
 * next `before_agent_start` event. Used by /ctx-flush, dreamer doc
 * publication, and user-memory promotion.
 */
export function signalPiSystemPromptRefresh(sessionId: string): void {
	systemPromptRefreshSessions.add(sessionId);
}

/**
 * Mark a Pi session as needing pending-op materialization on the next
 * execute pass. Used by /ctx-flush.
 */
export function signalPiPendingMaterialization(sessionId: string): void {
	pendingMaterializationSessions.add(sessionId);
}

export function clearPiM0Cache(
	db: ContextDatabase,
	sessionId: string,
	reason: string,
): void {
	clearM0M1PiCache(db, sessionId, reason);
}

export function signalPiDeferredHistoryRefresh(sessionId: string): void {
	deferredHistoryRefreshSessions.add(sessionId);
}

export function signalPiDeferredMaterialization(sessionId: string): void {
	deferredMaterializationSessions.add(sessionId);
}

export function consumeDeferredHistoryRefresh(sessionId: string): boolean {
	const wasSet = deferredHistoryRefreshSessions.has(sessionId);
	deferredHistoryRefreshSessions.delete(sessionId);
	return wasSet;
}

export function consumeDeferredMaterialization(sessionId: string): boolean {
	const wasSet = deferredMaterializationSessions.has(sessionId);
	deferredMaterializationSessions.delete(sessionId);
	return wasSet;
}

export function trackSessionForProject(
	projectIdentity: string,
	sessionId: string,
): void {
	activeContextHandlerSessions.add(sessionId);
	let sessions = sessionsByProject.get(projectIdentity);
	if (!sessions) {
		sessions = new Set();
		sessionsByProject.set(projectIdentity, sessions);
	}
	sessions.add(sessionId);
}

function isContextHandlerSessionActive(sessionId: string): boolean {
	return activeContextHandlerSessions.has(sessionId);
}

function updateSessionProjectTracking(
	sessionId: string,
	projectIdentity: string,
): void {
	const prev = lastSeenProjectIdentityBySession.get(sessionId);
	if (prev && prev !== projectIdentity) {
		const prevSessions = sessionsByProject.get(prev);
		prevSessions?.delete(sessionId);
		if (prevSessions?.size === 0) sessionsByProject.delete(prev);
		clearPiSystemPromptSession(sessionId);
	}
	trackSessionForProject(projectIdentity, sessionId);
	lastSeenProjectIdentityBySession.set(sessionId, projectIdentity);
}

export function signalPiSystemPromptRefreshForProject(
	projectIdentity: string,
): void {
	const sessions = sessionsByProject.get(projectIdentity);
	if (!sessions) return;
	for (const sessionId of sessions) {
		systemPromptRefreshSessions.add(sessionId);
	}
}

export function recordPiLiveModel(sessionId: string, modelKey: string): void {
	liveModelBySession.set(sessionId, modelKey);
}

export function recordPiCtxReduceExecution(sessionId: string): void {
	recentReduceBySession.set(sessionId, Date.now());
}

export function recordPiToolExecution(sessionId: string): void {
	const current = toolUsageSinceUserTurn.get(sessionId) ?? 0;
	toolUsageSinceUserTurn.set(sessionId, current + 1);
}

export function getPiToolUsageSinceUserTurnForTest(
	sessionId: string,
): number | undefined {
	return toolUsageSinceUserTurn.get(sessionId);
}

function onPiNewUserMessage(args: {
	db: ContextDatabase;
	sessionId: string;
}): void {
	const sessionMeta = getOrCreateSessionMeta(args.db, args.sessionId);
	const turnUsage = toolUsageSinceUserTurn.get(args.sessionId);
	const agentAlreadyReduced = hasRecentPiCtxReduceExecution(args.sessionId);
	if (
		!sessionMeta.isSubagent &&
		!agentAlreadyReduced &&
		getPersistedStickyTurnReminder(args.db, args.sessionId) === null &&
		turnUsage !== undefined &&
		turnUsage >= TOOL_HEAVY_TURN_REMINDER_THRESHOLD
	) {
		setPersistedStickyTurnReminder(
			args.db,
			args.sessionId,
			TOOL_HEAVY_TURN_REMINDER_TEXT,
		);
	}
	toolUsageSinceUserTurn.set(args.sessionId, 0);
}

function summarizeTransformError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const normalized = raw.replace(/\s+/g, " ").trim();
	return normalized.length > 180
		? `${normalized.slice(0, 177).trimEnd()}...`
		: normalized || "Unknown transform error";
}

function persistLastTransformErrorIfChanged(
	db: ContextDatabase,
	sessionId: string,
	summary: string,
): void {
	try {
		const current = getOrCreateSessionMeta(db, sessionId).lastTransformError;
		if (current !== summary) {
			updateSessionMeta(db, sessionId, { lastTransformError: summary });
		}
	} catch (err) {
		sessionLog(
			sessionId,
			`transform error persistence failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function clearLastTransformErrorIfSet(
	db: ContextDatabase,
	sessionId: string,
): void {
	try {
		const current = getOrCreateSessionMeta(db, sessionId).lastTransformError;
		if (current !== null) {
			updateSessionMeta(db, sessionId, { lastTransformError: null });
		}
	} catch (err) {
		sessionLog(
			sessionId,
			`transform error clear failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Read (without draining) the system-prompt refresh signal for a session.
 * The `before_agent_start` handler in `index.ts` calls this at the start
 * of each turn to decide whether adjuncts should refresh, then calls
 * `clearSystemPromptRefresh(...)` only after the rebuild work succeeds.
 */
export function hasSystemPromptRefresh(sessionId: string): boolean {
	return systemPromptRefreshSessions.has(sessionId);
}

/** Drain the system-prompt refresh signal. Called from
 *  `before_agent_start` after `processSystemPromptForCache(...)` succeeds. */
export function clearSystemPromptRefresh(sessionId: string): boolean {
	const wasSet = systemPromptRefreshSessions.has(sessionId);
	systemPromptRefreshSessions.delete(sessionId);
	return wasSet;
}

/** Read (without draining) the pending-materialization signal. The
 *  runPipeline call drains it. */
export function hasPendingMaterialization(sessionId: string): boolean {
	return pendingMaterializationSessions.has(sessionId);
}

/** Drain the pending-materialization signal. Called from runPipeline
 *  after pending-op materialization completes (or is skipped because
 *  this pass is `defer`). */
export function consumePendingMaterialization(sessionId: string): boolean {
	const wasSet = pendingMaterializationSessions.has(sessionId);
	pendingMaterializationSessions.delete(sessionId);
	return wasSet;
}

/**
 * Pi's full AgentMessage union (user | assistant | toolResult | custom).
 * Sourced from the live ContextEvent payload so the type stays in sync
 * with @earendil-works/pi-coding-agent without us re-declaring it.
 *
 * The nudge / note-nudge / auto-search helpers below operate on this
 * union but only inspect/mutate user and (rarely) assistant messages —
 * `toolResult` and `custom` flow through unchanged. Each helper guards
 * its mutations with role checks so the wider union is safe.
 */
type PiAgentMessage = ContextEvent["messages"][number];

/**
 * Optional historian config. When provided, the context handler checks
 * the compartment trigger after tagging and fires `runPiHistorian`
 * asynchronously (fire-and-forget) when the trigger says shouldFire.
 * When omitted, no historian invocation happens — useful for testing
 * the transform pipeline in isolation or running Pi without a
 * configured historian model.
 */
export interface PiHistorianOptions {
	/** SubagentRunner instance (PiSubagentRunner). */
	runner: SubagentRunner;
	/** Historian provider/model id (e.g. `anthropic/claude-haiku-4-5`). */
	model: string;
	/** Optional ordered fallback chain. */
	fallbackModels?: readonly string[];
	/** Historian context window — used to derive chunk token budget. */
	historianChunkTokens: number;
	/** Optional per-call timeout (default 120s). */
	timeoutMs?: number;
	/** When true, run a second editor pass after a successful first pass to
	 *  clean low-signal U: lines and cross-compartment duplicates. Mirrors
	 *  OpenCode's `historian.two_pass` config. */
	twoPass?: boolean;
	/** Pi only: explicit thinking level for historian/compressor subagent
	 *  invocations (passed as --thinking <level>). When unset, Pi's own
	 *  default resolution applies. See `historian.thinking_level` in config. */
	thinkingLevel?: string;
	/** Cross-session memory feature gate (`memory.enabled`). */
	memoryEnabled?: boolean;
	/** Automatic-promotion gate (`memory.auto_promote`). */
	autoPromote?: boolean;
	/** User-memory feature gate (`dreamer.user_memories.enabled`). Gates whether
	 *  historian user observations are persisted as candidates. */
	userMemoriesEnabled?: boolean;
	/** Notify UI/status surfaces after historian state changes. */
	onStatusChange?: (ctx: ExtensionContext, sessionId: string) => void;
	/**
	 * Execute-threshold percentage used by the trigger logic to compute
	 * pressure-driven trigger points. Mirrors OpenCode's
	 * `execute_threshold_percentage` config; defaults to 65 when omitted.
	 */
	executeThresholdPercentage?:
		| number
		| { default: number; [modelKey: string]: number };
	/** Token-based execute-threshold overrides. Mirrors OpenCode `execute_threshold_tokens`. */
	executeThresholdTokens?: {
		default?: number;
		[modelKey: string]: number | undefined;
	};
	/** Commit-cluster trigger config. Mirrors OpenCode `commit_cluster_trigger`. */
	commitClusterTrigger?: { enabled: boolean; min_clusters: number };
	/** Projected-drop math knobs threaded into `checkCompartmentTrigger`. */
	autoDropToolAge?: number;
	protectedTags?: number;
	clearReasoningAge?: number;
	dropToolStructure?: boolean;
	/** Fraction of executable context reserved for rendered <session-history>. */
	historyBudgetPercentage?: number;
}

/**
 * Optional rolling/iteration nudge config (Step 4b.4). When omitted,
 * Pi runs without any rolling reminder text appended to the LLM input —
 * existing tagging + drop behavior is unchanged. When provided, the
 * shared `createNudger` is used to evaluate band-based reminders after
 * each tagging pass and injects them as a synthetic assistant message
 * via `injectPiNudge`.
 */
export interface PiNudgeOptions {
	/** Number of most-recent tags treated as protected (mirrors OpenCode `protected_tags`). */
	protectedTags: number;
	/** Base interval between rolling reminders, in tokens (mirrors OpenCode `nudge_interval_tokens`). */
	nudgeIntervalTokens: number;
	/** Tool-iteration threshold — N+ tool calls without user input fires the iteration nudge. */
	iterationNudgeThreshold: number;
	/** Same execute threshold the historian trigger uses (default 65). */
	executeThresholdPercentage:
		| number
		| { default: number; [modelKey: string]: number };
}

/**
 * Optional auto-search hint config (Step 4b.4). When enabled, runs
 * `unifiedSearch` against new user prompts and appends a compact
 * vague-recall hint to the user message. Cross-harness coherent: hints
 * are computed against the same shared cortexkit DB OpenCode uses.
 */
export interface PiAutoSearchHandlerOptions {
	enabled: boolean;
	scoreThreshold: number;
	minPromptChars: number;
}

/** Heuristic-cleanup config — drops aged tools, dedups, strips system injections. */
export interface PiHeuristicsOptions {
	autoDropToolAge: number;
	dropToolStructure: boolean;
	caveman?: { enabled: boolean; minChars: number };
	/**
	 * Number of tags before the most recent tag whose typed reasoning is
	 * cleared on cache-busting passes. Mirrors OpenCode's
	 * `clear_reasoning_age` config (`packages/plugin/src/config/schema/magic-context.ts:303`).
	 * Default `50` matches OpenCode. Pi previously hardcoded `30`, which
	 * cleared reasoning more aggressively than the user configured.
	 */
	clearReasoningAge?: number;
}

/** <session-history> injection config — writes compartments+facts+memories into message[0]. */
export interface PiInjectionOptions {
	injectionBudgetTokens: number;
	temporalAwareness?: boolean;
	keyFilesEnabled?: boolean;
	keyFilesTokenBudget?: number;
}

/** Scheduler config — gates cache-busting stages on TTL + threshold. */
export interface PiSchedulerOptions {
	executeThresholdPercentage:
		| number
		| { default: number; [modelKey: string]: number };
	executeThresholdTokens?: {
		default?: number;
		[modelKey: string]: number | undefined;
	};
}

export interface PiContextHandlerOptions {
	db: ContextDatabase;
	/**
	 * Whether the agent-facing `ctx_reduce` tool is exposed. When false,
	 * tag prefixes are still assigned in the DB (so drops still work
	 * via /ctx-flush or future automatic triggers) but the visible
	 * `§N§ ` markers are NOT injected — agents shouldn't see markers
	 * they can't act on. Mirrors OpenCode behavior.
	 */
	ctxReduceEnabled: boolean;
	/**
	 * Heuristic-cleanup config (auto_drop_tool_age, drop_tool_structure,
	 * caveman). When omitted, heuristic cleanup is disabled — tagging
	 * and queued-drop application still run, but the transform won't
	 * proactively shrink context. Use this only for tests; production
	 * always passes this.
	 */
	heuristics?: PiHeuristicsOptions;
	/**
	 * `<session-history>` injection config. When omitted, the prepared
	 * compartment/fact/memory block is NOT written into message[0].
	 * Production always passes this; tests can omit.
	 */
	injection?: PiInjectionOptions;
	/**
	 * Scheduler config — gates heuristic cleanup on TTL/threshold.
	 * When omitted, defaults to 65% threshold + 5m TTL behavior.
	 */
	scheduler?: PiSchedulerOptions;
	/**
	 * Number of most-recent tags treated as protected (mirrors OpenCode
	 * `protected_tags`). Drops with tag IDs in the protected window are
	 * deferred — `applyPendingOperations` requeues them as deferred so
	 * they re-evaluate next pass instead of being lost. Critical for
	 * keeping the agent's recent working context intact.
	 *
	 * Defaults from the schema to 20; can be 1-100. Optional so existing
	 * test fixtures don't need updating; callers in production (`index.ts`)
	 * always thread the loaded config value. A previous bug used a
	 * hardcoded `0` here — the council audit caught that recent turns
	 * were getting dropped mid-task.
	 */
	protectedTags?: number;
	/**
	 * Optional historian wiring (Step 4b.3b). When omitted, the trigger
	 * check is skipped — context events still tag + drop normally, and
	 * historian state stays untouched. When provided, the trigger fires
	 * async after each tagging pass.
	 */
	historian?: PiHistorianOptions;
	/**
	 * Optional rolling/iteration nudge wiring (Step 4b.4). When omitted,
	 * no nudges are injected. When provided, evaluated AFTER each tagging
	 * pass and injected via `injectPiNudge`.
	 */
	nudge?: PiNudgeOptions;
	/**
	 * Optional auto-search hint wiring (Step 4b.4). When omitted or
	 * disabled, no hint computation runs. Notes that auto-search shares
	 * the cortexkit DB with OpenCode, so memories ARE cross-harness.
	 */
	autoSearch?: PiAutoSearchHandlerOptions;
}

/**
 * Resolve the active Pi session id for the given context. Pi's
 * ReadonlySessionManager exposes `getSessionId()` (the UUID written
 * into the session file's `SessionHeader`); that's stable across the
 * session's lifetime even when branches are navigated, and matches
 * what Pi itself uses internally to address the session. We prefer
 * the UUID over the file path because:
 *
 *   - It's invariant under file moves (forks create new files but
 *     keep the original session id semantics intact).
 *   - It's the same id Pi uses in its `session_switch` event, so
 *     downstream code can correlate events to magic-context state
 *     without re-deriving from paths.
 *
 * Returns undefined when no session is active — context events should
 * never fire in that state, but defending against it keeps the
 * transform fail-open if Pi's lifecycle changes in future versions.
 */
function resolveSessionId(ctx: ExtensionContext): string | undefined {
	const sm = ctx.sessionManager;
	if (sm === undefined) return undefined;
	const getSessionId = (sm as { getSessionId?: () => string | undefined })
		.getSessionId;
	if (typeof getSessionId !== "function") return undefined;
	try {
		const id = getSessionId.call(sm);
		if (typeof id !== "string" || id.length === 0) return undefined;
		return id;
	} catch {
		return undefined;
	}
}

/**
 * Resolve the SessionEntry id for each AgentMessage in `event.messages`.
 *
 * Pi's runtime builds `event.messages` from `sessionManager.getBranch()`
 * by filtering to message-type entries (`type === "message"`) plus
 * synthetic compaction-summary / branch-summary messages. Magic Context
 * needs the underlying SessionEntry id for compartment boundary lookup
 * (historian writes `start_message_id`/`end_message_id` from
 * `read-session-pi.ts` → `RawMessage.id = entry.id`).
 *
 * We replicate the same filter here. Indexes that don't have a real
 * SessionEntry behind them (synthetic compaction summary at index 0
 * when Pi compaction has run; nothing else today) get `undefined` —
 * boundary lookup falls back to a synthesized id which is harmless
 * because no real boundary will ever match it.
 *
 * `expectedLength` is `event.messages.length`. If the resolved entry
 * count diverges from that (e.g. Pi inserted compaction summaries that
 * don't appear as `type==="message"` entries), we return `undefined`
 * — boundary lookup falls through to the synthesized fallback for
 * the whole pass. Better to skip the trim than trim the wrong slice.
 */
/**
 * Collect SessionEntry ids that align 1:1 with `event.messages` —
 * the same `AgentMessage[]` Pi's `buildSessionContext()` produces.
 *
 * Critical: `getBranch()` returns the entire path from leaf to root,
 * INCLUDING entries that pre-date the latest compaction. Filtering
 * `getBranch()` for `type === "message"` would yield a much larger
 * array than `event.messages`, breaking the index alignment that
 * `<session-history>` boundary trim relies on. We must replicate
 * `buildSessionContext`'s compaction-aware emission order so the
 * resulting `entryIds[]` lines up with `event.messages` exactly.
 *
 * Algorithm — mirrors @earendil-works/pi-coding-agent's
 * `buildSessionContext` implementation (see node_modules/.../core/
 * session-manager.js:108 and our copy of the algorithm in this repo's
 * earlier debug session for `ses_21cba3abaffenqSinaCFbAFF3E`):
 *
 *   1. Find the LATEST compaction entry on the branch (if any).
 *   2. If a compaction exists:
 *      - Emit `undefined` at index 0 for the synthetic compaction
 *        summary message (which has no SessionEntry id).
 *      - Skip every entry before `compaction.firstKeptEntryId`.
 *      - Then emit one id per entry from `firstKeptEntryId` up to
 *        (but not including) the compaction entry itself, plus every
 *        entry AFTER the compaction.
 *      - Each emitted id is the SessionEntry's id for `message` /
 *        `custom_message` / `branch_summary` (the three types that
 *        produce an AgentMessage); other types produce no message
 *        and are simply skipped.
 *   3. If no compaction exists: emit one id per emit-eligible entry
 *      across the full branch path, in path order.
 *
 * Returns `undefined` only when the SessionManager API is unavailable
 * or throws — those are real "we cannot determine alignment" cases.
 * When we successfully traverse the path, we ALWAYS return an array;
 * if the result length doesn't match `expectedLength` we log the
 * divergence (with diagnostics) and still return our best-effort
 * mapping rather than silently disabling the trim.
 */
function collectMessageEntryIds(
	ctx: ExtensionContext,
	expectedLength: number,
	sessionId?: string,
	strict = false,
): readonly (string | undefined)[] | undefined {
	const sm = ctx.sessionManager as
		| {
				getBranch?: (fromId?: string) => unknown[];
				getLeafId?: () => string | undefined;
		  }
		| undefined;
	if (typeof sm?.getBranch !== "function") return undefined;

	let entries: unknown[];
	try {
		entries = sm.getBranch.call(sm);
	} catch {
		return undefined;
	}
	if (!Array.isArray(entries)) return undefined;

	// Find the latest compaction entry (walk from end → start; same
	// algorithm Pi's getLatestCompactionEntry uses).
	let compactionIndex = -1;
	let firstKeptEntryId: string | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as {
			type?: unknown;
			firstKeptEntryId?: unknown;
		} | null;
		if (e && typeof e === "object" && e.type === "compaction") {
			compactionIndex = i;
			if (typeof e.firstKeptEntryId === "string") {
				firstKeptEntryId = e.firstKeptEntryId;
			}
			break;
		}
	}

	const ids: (string | undefined)[] = [];

	// Helper: is this entry type one that produces an AgentMessage in
	// buildSessionContext? Same three types: message, custom_message,
	// branch_summary (the latter only when summary is set). Note that
	// branch_summary entries with `summary === undefined` are skipped
	// by buildSessionContext but we accept all branch_summary entries
	// here for robustness — the worst case is we emit an extra id that
	// never matches a compartment boundary, which is harmless.
	const isEmitEligible = (entry: unknown): entry is { id: string } => {
		if (!entry || typeof entry !== "object") return false;
		const t = (entry as { type?: unknown }).type;
		const id = (entry as { id?: unknown }).id;
		if (typeof id !== "string") return false;
		if (t === "message") return true;
		if (t === "custom_message") return true;
		if (t === "branch_summary") {
			const summary = (entry as { summary?: unknown }).summary;
			return typeof summary === "string" && summary.length > 0;
		}
		return false;
	};

	if (compactionIndex >= 0) {
		// Index 0 = synthetic compaction summary — no SessionEntry id.
		ids.push(undefined);

		// Pre-compaction: emit ids from firstKeptEntryId (inclusive) up to
		// compactionIndex (exclusive). If firstKeptEntryId is undefined or
		// not found, emit nothing for the pre-compaction window (that's
		// what buildSessionContext does).
		if (firstKeptEntryId !== undefined) {
			let foundFirstKept = false;
			for (let i = 0; i < compactionIndex; i++) {
				const entry = entries[i];
				const entryId = (entry as { id?: unknown } | null)?.id;
				if (typeof entryId === "string" && entryId === firstKeptEntryId) {
					foundFirstKept = true;
				}
				if (!foundFirstKept) continue;
				if (isEmitEligible(entry)) {
					ids.push(entry.id);
				}
			}
		}

		// Post-compaction: emit ids for every emit-eligible entry after
		// the compaction marker.
		for (let i = compactionIndex + 1; i < entries.length; i++) {
			const entry = entries[i];
			if (isEmitEligible(entry)) {
				ids.push(entry.id);
			}
		}
	} else {
		// No compaction — emit one id per emit-eligible entry across the
		// full path.
		for (const entry of entries) {
			if (isEmitEligible(entry)) {
				ids.push(entry.id);
			}
		}
	}

	// Length mismatch is a real bug somewhere (probably a SessionEntry
	// type we're not handling correctly), but we still return our best
	// guess so the trim is robust. Log so future divergence shows up.
	if (ids.length !== expectedLength) {
		const sm2 = sm as {
			getBranch?: (fromId?: string) => unknown[];
		};
		const totalEntries = entries.length;
		log(
			`[magic-context][pi]${sessionId ? `[${sessionId}]` : ""} collectMessageEntryIds length mismatch: ` +
				`expected=${expectedLength} got=${ids.length} (compactionIndex=${compactionIndex} ` +
				`firstKeptEntryId=${firstKeptEntryId ?? "<none>"} totalBranchEntries=${totalEntries})` +
				` — best-effort mapping returned; boundary trim may not match exactly`,
		);
		if (strict) return undefined;
		// Defensively fall back: if we have FEWER ids than expected, pad
		// with undefined at the front (covers historical compaction-summary
		// cases where Pi prepended a synthetic message we missed). If we
		// have MORE ids than expected, slice from the END (post-compaction
		// matters most for boundary lookup).
		const _unused = sm2; // satisfy lint about unused alias above
		void _unused;
		if (ids.length < expectedLength) {
			const padded: (string | undefined)[] = [];
			for (let i = 0; i < expectedLength - ids.length; i++) {
				padded.push(undefined);
			}
			padded.push(...ids);
			return padded;
		}
		// ids.length > expectedLength — slice from the end (the most
		// recent entries are the ones we need for boundary lookup).
		return ids.slice(ids.length - expectedLength);
	}

	return ids;
}

export function collectMessageEntryIdsStrict(
	ctx: ExtensionContext,
	expectedLength: number,
	sessionId?: string,
): readonly (string | undefined)[] | null {
	try {
		return collectMessageEntryIds(ctx, expectedLength, sessionId, true) ?? null;
	} catch (error) {
		sessionLog(
			sessionId ?? "pi",
			`collectMessageEntryIdsStrict failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

/**
 * Resolve the SessionEntry id for each `event.messages[i]` by reference
 * identity against `sessionManager.getBranch()` entries.
 *
 * Why this exists alongside `collectMessageEntryIds`: the position-based
 * walk in `collectMessageEntryIds` assumes that filtering `getBranch()`
 * to message/custom_message/branch_summary entries produces an array
 * 1:1 with `event.messages` in length. That assumption breaks when Pi's
 * runtime `agent.state.messages` and SessionManager's branch desync by
 * even one entry — and we've observed off-by-one (around the agent_end
 * boundary, likely a bash flush race) and much larger (288-entry) gaps
 * in production. When that happens, every index past the divergence
 * gets the wrong entry id, breaking compartment boundary lookup.
 *
 * Reference-based mapping is immune to count divergence. Pi's
 * `appendMessage` (session-manager.js:580) stores `entry.message =
 * sourceAgentMessage` by reference, and `buildSessionContext` emits
 * those same references back as the message array. So `event.messages[i]
 * === branchEntries[j].message` holds for every emit-eligible entry.
 *
 * Algorithm:
 *   1. Walk `getBranch()` once, building `entryByMsgRef: Map<object, string>`
 *      keyed by `entry.message` reference (for `type === "message"`),
 *      `entry` itself for `custom_message` (Pi calls `createCustomMessage`
 *      which returns a fresh object, so we key by the message we emit
 *      using a synthesized reference table — see below), and similar for
 *      `branch_summary`.
 *   2. For each `event.messages[i]`, look up by reference. Hit → real
 *      SessionEntry id. Miss → undefined (caller falls back to
 *      synthesized id via `buildPiMessageIdByIndex`).
 *
 * For `custom_message` and `branch_summary` entries, Pi's
 * `buildSessionContext` calls `createCustomMessage(...)` /
 * `createBranchSummaryMessage(...)` which return NEW objects per
 * `context` event. Reference matching cannot work for those — Pi makes
 * fresh wrappers every call. Those entries fall through to undefined
 * here, and the caller's `buildPiMessageIdByIndex` falls back to a
 * synthesized `pi-msg-${index}-${ts}-${role}` id. That synthesized id
 * has zero cross-pass stability, but compartment boundaries never
 * target custom-message / branch-summary entries (historian only writes
 * boundaries on plain `message` entries via `read-session-pi.ts`), so
 * the fallback is harmless.
 *
 * Returns `null` only when the SessionManager API is unavailable. When
 * we successfully traverse the branch, we always return an array of
 * the same length as `messages` (with `undefined` slots for unmapped
 * positions). Length mismatch is NEVER returned — that's the whole
 * point of switching to reference-based matching.
 */
export function collectMessageEntryIdsByRef(
	ctx: ExtensionContext,
	messages: readonly PiAgentMessage[],
	sessionId?: string,
	preloadedBranchEntries?: readonly unknown[],
): readonly (string | undefined)[] | null {
	let entries: readonly unknown[];
	if (preloadedBranchEntries !== undefined) {
		entries = preloadedBranchEntries;
	} else {
		const sm = ctx.sessionManager as
			| {
					getBranch?: (fromId?: string) => unknown[];
			  }
			| undefined;
		if (typeof sm?.getBranch !== "function") return null;

		try {
			const branch = sm.getBranch.call(sm);
			if (!Array.isArray(branch)) return null;
			entries = branch;
		} catch (error) {
			sessionLog(
				sessionId ?? "pi",
				`collectMessageEntryIdsByRef getBranch failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
	}

	// Build lookup tables keyed first by AgentMessage reference and then by
	// a content fingerprint. Reference identity is the fast, lossless path for
	// native Pi messages. The fingerprint fallback covers full message-clone
	// paths introduced by other Pi extensions that re-wrap ordinary messages
	// while preserving stable fields and first text content.
	const entryIdByMsgRef = new Map<object, string>();
	const entryIdsByFingerprint = new Map<string, string[]>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as {
			type?: unknown;
			id?: unknown;
			message?: unknown;
		};
		if (e.type !== "message") continue;
		if (typeof e.id !== "string") continue;
		if (!e.message || typeof e.message !== "object") continue;
		const message = e.message as object;
		entryIdByMsgRef.set(message, e.id);
		const fingerprint = piMessageEntryFingerprint(e.message);
		if (fingerprint) {
			const bucket = entryIdsByFingerprint.get(fingerprint);
			if (bucket) bucket.push(e.id);
			else entryIdsByFingerprint.set(fingerprint, [e.id]);
		}
	}

	const result: (string | undefined)[] = new Array(messages.length);
	let resolved = 0;
	let fingerprintResolved = 0;
	const consumedFingerprintIds = new Set<string>();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg || typeof msg !== "object") {
			result[i] = undefined;
			continue;
		}
		const id = entryIdByMsgRef.get(msg as object);
		if (typeof id === "string") {
			result[i] = id;
			resolved += 1;
			continue;
		}
		const fingerprint = piMessageEntryFingerprint(msg);
		const fingerprintBucket = fingerprint
			? entryIdsByFingerprint.get(fingerprint)
			: undefined;
		// A fingerprint is only a safe fallback when it uniquely identifies a
		// branch entry. Repeated/cloned messages can share timestamp/role/text;
		// consuming the "next" bucket item would silently anchor to the wrong
		// SessionEntry after one clone is dropped or reordered.
		const fingerprintId =
			fingerprintBucket?.length === 1 &&
			!consumedFingerprintIds.has(fingerprintBucket[0] as string)
				? fingerprintBucket[0]
				: undefined;
		if (typeof fingerprintId === "string") {
			consumedFingerprintIds.add(fingerprintId);
			result[i] = fingerprintId;
			resolved += 1;
			fingerprintResolved += 1;
		} else {
			result[i] = undefined;
		}
	}

	// One-shot diagnostic: log a coverage summary so we can see how often
	// the new resolver finds real ids vs. falls back. This replaces the
	// "length mismatch" log line that `collectMessageEntryIds` used to
	// emit — that log was misleading because the position-based walk
	// reported divergence even when the underlying refs were fine.
	if (resolved < messages.length) {
		log(
			`[magic-context][pi]${sessionId ? `[${sessionId}]` : ""} ` +
				`collectMessageEntryIdsByRef: resolved=${resolved}/${messages.length} ` +
				`(fingerprint=${fingerprintResolved}, branchEntries=${entries.length}, messageEntries=${entryIdByMsgRef.size}) — ` +
				`unmapped slots fall through to synthesized ids; boundary lookup still works ` +
				`for any compartment whose start/end message is among the resolved set`,
		);
	}

	return result;
}

/**
 * Build a `Map<AgentMessage-ref, SessionEntry.id>` from branch entries.
 *
 * Same source-of-truth as `collectMessageEntryIdsByRef` (the message-typed
 * branch entries), but keyed by object identity instead of collapsed to a
 * positional array. This is the splice-safe map threaded to post-mutation
 * consumers (sticky reminders, note nudges, auto-search) so they resolve the
 * CURRENT message's entry id by reference rather than by a stale index. Only the
 * lossless reference path is included — the fingerprint fallback in
 * `collectMessageEntryIdsByRef` is position/consumption-ordered and not safe to
 * reuse out of order, so unmapped messages simply fall through (anchor defers).
 */
function buildEntryIdByRefMap(
	branchEntries: readonly unknown[] | null,
): Map<object, string> {
	const map = new Map<object, string>();
	if (!branchEntries) return map;
	for (const entry of branchEntries) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as { type?: unknown; id?: unknown; message?: unknown };
		if (e.type !== "message") continue;
		if (typeof e.id !== "string") continue;
		if (!e.message || typeof e.message !== "object") continue;
		map.set(e.message as object, e.id);
	}
	return map;
}

function readPiBranchEntriesForContext(
	ctx: ExtensionContext,
	sessionId: string,
): readonly unknown[] | null {
	const sm = ctx.sessionManager as
		| { getBranch?: (fromId?: string) => unknown[] }
		| undefined;
	if (typeof sm?.getBranch !== "function") return null;
	try {
		const entries = sm.getBranch.call(sm);
		return Array.isArray(entries) ? entries : null;
	} catch (error) {
		sessionLog(
			sessionId,
			`Pi branch pre-read failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

function piMessageEntryFingerprint(message: unknown): string | null {
	if (!message || typeof message !== "object") return null;
	const record = message as {
		responseId?: unknown;
		timestamp?: unknown;
		role?: unknown;
		toolCallId?: unknown;
		content?: unknown;
	};
	if (typeof record.role !== "string") return null;
	const firstText = firstPiTextContent(record.content);
	const firstTextHash = crypto
		.createHash("sha256")
		.update(firstText ?? "")
		.digest("hex")
		.slice(0, 16);
	return JSON.stringify([
		typeof record.responseId === "string" ? record.responseId : null,
		typeof record.timestamp === "number" || typeof record.timestamp === "string"
			? record.timestamp
			: null,
		record.role,
		typeof record.toolCallId === "string" ? record.toolCallId : null,
		firstTextHash,
	]);
}

function firstPiTextContent(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const record = part as { type?: unknown; text?: unknown };
		if (record.type === "text" && typeof record.text === "string") {
			return record.text;
		}
	}
	return null;
}

/**
 * Build a `messageId → fingerprint` map from the RAW pre-transform messages,
 * keyed by the stable id each message resolves to this pass. Captured before
 * `runPipeline` mutates text (temporal markers, §N§ prefix, caveman) so the
 * fingerprint is byte-stable across the fallback-pass (in-flight) and the
 * real-id-pass (settled) — the invariant tag adoption depends on. The
 * fingerprint is persisted on the tag row at creation; only message-typed
 * entries get one (tool tags are out of scope).
 */
function buildEntryFingerprintMap(
	messages: readonly PiAgentMessage[],
	resolveStableId: (msg: unknown, index: number) => string | undefined,
): Map<string, string> {
	const map = new Map<string, string>();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const id = resolveStableId(msg, i);
		if (!id) continue;
		const fp = piMessageEntryFingerprint(msg);
		if (fp) map.set(id, fp);
	}
	return map;
}

/**
 * Pi fallback-tag adoption pre-pass. Runs BEFORE tagging. For each message that
 * now resolves to a REAL SessionEntry id this pass, find the tag(s) created for
 * the same message under its earlier `pi-msg-*` fallback id (matched by raw
 * fingerprint) and migrate them onto the real id — so the message keeps its
 * tag_number (hence §N§ and all per-tag state) instead of getting a fresh tag
 * and drifting. Per-part, uniqueness-guarded, race-safe; any miss degrades to a
 * fresh allocation in `tagTranscript`. No-op for messages that are already on a
 * real id or have no fallback predecessor.
 */
function adoptPiFallbackTags(
	db: ContextDatabase,
	sessionId: string,
	tagger: Tagger,
	fingerprintById: ReadonlyMap<string, string>,
): void {
	for (const [realMessageId, fingerprint] of fingerprintById) {
		// Only real ids can be adoption targets; a pi-msg-* id has no fallback
		// predecessor to migrate from.
		if (realMessageId.startsWith("pi-msg-")) continue;
		const candidates = findAdoptableFallbackTags(db, sessionId, fingerprint);
		if (candidates.length === 0) continue;
		// Group candidates by their fallback message base id (strip the :pN
		// suffix). A unique base means exactly one fallback message carried this
		// fingerprint → safe to adopt; duplicates (same fingerprint on >1
		// fallback message) are ambiguous → skip, let tagTranscript allocate
		// fresh.
		const baseIds = new Set<string>();
		for (const c of candidates) {
			const m = /^(.*):p\d+$/.exec(c.messageId);
			baseIds.add(m ? m[1] : c.messageId);
		}
		if (baseIds.size !== 1) continue;
		for (const c of candidates) {
			const ordinalMatch = /:p(\d+)$/.exec(c.messageId);
			if (!ordinalMatch) continue;
			const realContentId = `${realMessageId}:p${ordinalMatch[1]}`;
			const migrated = adoptFallbackTagMessageId(
				db,
				sessionId,
				c.tagNumber,
				c.messageId,
				realContentId,
			);
			if (migrated) {
				// Drop the stale fallback alias, bind the real key — so the
				// subsequent tagTranscript exact-key lookup hits the migrated
				// tag and does NOT allocate a fresh one.
				tagger.unbindTag(sessionId, c.messageId);
				tagger.bindTag(sessionId, realContentId, c.tagNumber);
			}
		}
	}
}

/**
 * Register the Pi `context` event handler.
 *
 * The Tagger is created once per session boot — same lifecycle as the
 * OpenCode plugin's tagger. It maintains in-memory state (the
 * monotonic counter, assignment map) across `context` events so tag
 * numbers stay stable for the duration of the Pi session.
 */
export function registerPiContextHandler(
	pi: ExtensionAPI,
	options: PiContextHandlerOptions,
): void {
	const tagger = createTagger();

	// Build a real shared scheduler so cache-busting stages (heuristic
	// cleanup, compartment injection rebuild) only run on execute passes.
	// On defer passes the cache-stable replay path runs and the provider
	// prompt cache stays warm. Mirrors OpenCode's createTransform deps.
	const schedulerConfig = options.scheduler ?? {
		executeThresholdPercentage: 65,
	};
	const scheduler = createScheduler({
		executeThresholdPercentage: schedulerConfig.executeThresholdPercentage,
		executeThresholdTokens: schedulerConfig.executeThresholdTokens,
	});

	// Build the rolling/iteration nudger lazily — it's stateless across
	// invocations apart from the `recentReduceBySession` map and the per-
	// session meta it reads from the DB. Skipped when no `options.nudge` is
	// configured (returns null below at the call site).
	const nudgerFn = options.nudge
		? createNudger({
				protected_tags: options.nudge.protectedTags,
				nudge_interval_tokens: options.nudge.nudgeIntervalTokens,
				iteration_nudge_threshold: options.nudge.iterationNudgeThreshold,
				execute_threshold_percentage: options.nudge.executeThresholdPercentage,
				recentReduceBySession,
			})
		: null;

	pi.on("context", async (event, ctx) => {
		const transformStartTime = performance.now();
		let sessionIdForError: string | undefined;
		try {
			const tFindSession = performance.now();
			const sessionId = resolveSessionId(ctx);
			if (sessionId === undefined) {
				// No active session — fall through with no mutation.
				log(
					"[magic-context][pi] context event fired with no session id (falling through unmodified)",
				);
				return;
			}
			sessionIdForError = sessionId;
			const projectDirectory = ctx.cwd;
			const projectIdentity = resolveProjectIdentity(projectDirectory);
			updateSessionProjectTracking(sessionId, projectIdentity);
			logTransformTiming(
				sessionId,
				"findSessionId",
				tFindSession,
				`messages=${event.messages.length}`,
			);

			const branchEntries = readPiBranchEntriesForContext(ctx, sessionId);
			const rawMessageProvider = {
				readMessages: () =>
					branchEntries !== null
						? convertEntriesToRawMessages([...branchEntries])
						: readPiSessionMessages(ctx),
				readMessageById: (messageId: string) =>
					readPiSessionMessageById(ctx, messageId),
			};
			rawMessageProviderUnregistersBySession.get(sessionId)?.();
			const unregisterRaw = setRawMessageProvider(
				sessionId,
				rawMessageProvider,
			);
			rawMessageProviderUnregistersBySession.set(sessionId, unregisterRaw);
			scheduleReconciliation(options.db, sessionId, readRawSessionMessages);
			// Reference-based entry-id resolution. Immune to the
			// position-based count divergence that broke
			// `collectMessageEntryIdsStrict` when Pi's `agent.state.messages`
			// and `sessionManager.getBranch()` were out of sync (off-by-one
			// near agent_end, or much larger gaps when condensed-milk-pi
			// is active). Returns `null` only when getBranch is unavailable;
			// otherwise returns an array indexed 1:1 with event.messages
			// (with undefined for any message whose AgentMessage reference
			// doesn't match a branch entry — typically synthetic compaction
			// summaries and custom_message wrappers, which never carry
			// compartment boundaries).
			const strictEntryIds =
				branchEntries === null
					? null
					: collectMessageEntryIdsByRef(
							ctx,
							event.messages as readonly PiAgentMessage[],
							sessionId,
							branchEntries,
						);
			// Splice-safe message→entryId map keyed by reference. runPipeline
			// mutates the message array in place (compartment trim + placeholder
			// strip), so post-mutation consumers must resolve by identity, not by
			// the stale positional strictEntryIds.
			const entryIdByRef = buildEntryIdByRefMap(branchEntries);

			const tLastUser = performance.now();
			const latestUser = findLatestUserMessageIdPi(
				event.messages as PiAgentMessage[],
				buildPiMessageIdByIndex(
					event.messages as PiAgentMessage[],
					strictEntryIds,
				),
			);
			logTransformTiming(sessionId, "findLastUserMessageId", tLastUser);
			if (latestUser) {
				scheduleIncrementalIndex(
					options.db,
					sessionId,
					latestUser.messageId,
					(_sessionId, messageId) => readPiSessionMessageById(ctx, messageId),
				);
				const previousUserId = latestUserMessageBySession.get(sessionId);
				if (previousUserId !== latestUser.messageId) {
					onPiNewUserMessage({ db: options.db, sessionId });
					latestUserMessageBySession.set(sessionId, latestUser.messageId);
				}
			}

			// Lazy-initialize tagger state from DB. Idempotent: re-init
			// during the same session is a no-op because the in-memory
			// counter is already populated. Required because the tag
			// counter persists across plugin restarts via the
			// `session_meta.counter` column.
			tagger.initFromDb(sessionId, options.db);
			const isFirstContextPassForSession =
				!firstContextPassSeenBySession.has(sessionId);
			firstContextPassSeenBySession.add(sessionId);
			const piUsage = ctx.getContextUsage?.();
			const tModelDetect = performance.now();
			// Seed the in-memory model key from the JSONL on the first pass after a
			// (re)start. liveModelBySession is volatile, so without this a model
			// switch that happened while the process was DOWN would go undetected
			// (previousModelKey undefined → modelChanged false), leaking the prior
			// model's detected-context-limit / reasoning-watermark / historian-
			// failure state into the new model. The last model_change entry in the
			// branch is the session's last-used model; seeding it lets the
			// comparison below fire. No-op when the branch has no model_change
			// (older sessions) — previousModelKey stays undefined (today's behavior).
			if (
				isFirstContextPassForSession &&
				liveModelBySession.get(sessionId) === undefined
			) {
				// Reuse the branch entries already read above (readPiBranchEntries
				// ForContext) — getBranch() must be walked only once per event.
				const seeded = findLastModelKeyFromBranch(branchEntries);
				if (seeded !== undefined) {
					liveModelBySession.set(sessionId, seeded);
				}
			}
			const previousModelKey = liveModelBySession.get(sessionId);
			const currentModelKey = resolvePiContextModelKey(ctx);
			const modelChanged =
				previousModelKey !== undefined &&
				currentModelKey !== undefined &&
				previousModelKey !== currentModelKey;
			if (modelChanged) {
				clearPiM0Cache(
					options.db,
					sessionId,
					`model switch ${previousModelKey} -> ${currentModelKey}`,
				);
			}
			if (currentModelKey !== undefined) {
				liveModelBySession.set(sessionId, currentModelKey);
			}

			// Resolve scheduler decision: execute-vs-defer based on TTL
			// + threshold. Drives whether heuristic cleanup runs on this
			// pass. Read live context usage from Pi (tokens/percent) and
			// the persisted session-meta record (last_response_time,
			// cache_ttl).
			// Prefer the OpenCode-equivalent pressure persisted by
			// `message_end` in `index.ts`. `session_meta.lastContextPercentage`
			// is computed from the assistant message's `usage` with the
			// same formula OpenCode uses (input + cacheRead + cacheWrite,
			// divided by `effectiveContextLimit` which already factors in
			// `detected_context_limit`). Pi's built-in `getContextUsage()`
			// `percent` field includes output tokens, which causes a
			// small but real drift in tests and a much larger drift after
			// a provider overflow recovery sets a lower detected limit.
			// Fall back to `piUsage` on the first pass before message_end
			// has had a chance to run.
			const tMeta = performance.now();
			const sessionMetaForUsage = getOrCreateSessionMeta(options.db, sessionId);
			logTransformTiming(sessionId, "getOrCreateSessionMeta", tMeta);
			// Model change invalidates the safe-token baseline + alert state too
			// (new model, new limits), so it clears all four pressure fields.
			const usageReset = {
				lastContextPercentage: 0,
				lastInputTokens: 0,
				observedSafeInputTokens: 0,
				cacheAlertSent: false,
			};
			if (modelChanged) {
				// Model change: clear UNCONDITIONALLY (not gated on stale usage).
				// The reasoning watermark, historian failure/recovery state, and
				// detected context limit were specific to the previous model and
				// must be discarded so the new model gets a clean slate — even when
				// the prior usage counters happen to read zero (e.g. a switch right
				// after a reset). Mirrors OpenCode transform.ts model-change reset,
				// which runs with no usage>0 guard.
				sessionLog(
					sessionId,
					`transform: model switch ${previousModelKey} -> ${currentModelKey} reset — percentage=${sessionMetaForUsage.lastContextPercentage.toFixed(1)}% tokens=${sessionMetaForUsage.lastInputTokens} — clearing stale model-specific state`,
				);
				updateSessionMeta(options.db, sessionId, {
					...usageReset,
					clearedReasoningThroughTag: 0,
				});
				clearHistorianFailureState(options.db, sessionId);
				clearPersistedReasoningWatermark(options.db, sessionId);
				clearDetectedContextLimit(options.db, sessionId);
				clearEmergencyRecovery(options.db, sessionId);
				sessionMetaForUsage.clearedReasoningThroughTag = 0;
				sessionMetaForUsage.lastContextPercentage = 0;
				sessionMetaForUsage.lastInputTokens = 0;
				sessionMetaForUsage.observedSafeInputTokens = 0;
				sessionMetaForUsage.cacheAlertSent = false;
			} else if (
				isFirstContextPassForSession &&
				sessionMetaForUsage.lastContextPercentage > 0
			) {
				// First pass after restart (same model): clear ONLY the two stale
				// pressure fields. Gate on lastContextPercentage>0 (matches OpenCode
				// transform.ts first-pass). historian-failure state and the
				// reasoning watermark MUST be preserved — restart recovery uses the
				// failure backoff, and clearing the reasoning watermark would
				// resurface previously cleared reasoning (a cache bust + larger
				// prompt). observedSafeInputTokens and cacheAlertSent are ALSO
				// preserved: the model is unchanged, so the learned safe-input
				// baseline still holds across the restart (OpenCode preserves it
				// too — only lastContextPercentage/lastInputTokens are cleared).
				sessionLog(
					sessionId,
					`transform: first pass reset — percentage=${sessionMetaForUsage.lastContextPercentage.toFixed(1)}% tokens=${sessionMetaForUsage.lastInputTokens} — clearing stale usage state`,
				);
				updateSessionMeta(options.db, sessionId, {
					lastContextPercentage: 0,
					lastInputTokens: 0,
				});
				sessionMetaForUsage.lastContextPercentage = 0;
				sessionMetaForUsage.lastInputTokens = 0;
			}
			let usagePercentage = 0;
			let usageInputTokens = 0;
			if (
				sessionMetaForUsage.lastContextPercentage > 0 &&
				sessionMetaForUsage.lastInputTokens > 0
			) {
				usagePercentage = sessionMetaForUsage.lastContextPercentage;
				usageInputTokens = sessionMetaForUsage.lastInputTokens;
			} else {
				usagePercentage =
					typeof piUsage?.percent === "number" ? piUsage.percent : 0;
				usageInputTokens =
					typeof piUsage?.tokens === "number" ? piUsage.tokens : 0;
			}
			let usageContextLimit =
				typeof piUsage?.contextWindow === "number" && piUsage.contextWindow > 0
					? piUsage.contextWindow
					: undefined;

			// Overflow recovery: a previous LLM call ended with a
			// provider context-overflow error AND the pi.on("message_end")
			// handler persisted needs_emergency_recovery=1. On THIS pass:
			//
			//   1. Bump effective percentage to 95% so the existing
			//      emergency path (await historian + drop-all-tools)
			//      fires regardless of pressure math.
			//   2. If the error reported a real context limit, prefer
			//      that limit over Pi's reported contextWindow (which
			//      was clearly wrong if we just overflowed).
			//
			// Mirrors OpenCode's transform.ts:401 wiring exactly. The
			// recovery flag is cleared by the historian publication
			// path on success (see signalPiHistoryRefresh), so we won't
			// keep bumping forever.
			const tEmergencyRecovery = performance.now();
			try {
				const overflowState = getOverflowState(options.db, sessionId);
				if (overflowState.detectedContextLimit > 0) {
					// Always prefer detected limit over reported window
					// when one exists — the reported window came from
					// metadata that produced a wrong answer last time.
					usageContextLimit = Math.min(
						usageContextLimit ?? overflowState.detectedContextLimit,
						overflowState.detectedContextLimit,
					);
				}
				if (overflowState.needsEmergencyRecovery && usagePercentage < 95) {
					sessionLog(
						sessionId,
						`transform: overflow recovery flag set — bumping percentage from ${usagePercentage.toFixed(1)}% to 95% (detectedLimit=${overflowState.detectedContextLimit || "unknown"})`,
					);
					usagePercentage = 95;
				}
			} catch (err) {
				sessionLog(
					sessionId,
					`transform: overflow state read failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			const sessionMeta = sessionMetaForUsage;
			const modelKey = liveModelBySession.get(sessionId);
			// Cold-start stable-limit fallback: if `getContextUsage()` hasn't
			// reported a window yet (first pass after restart, before any
			// response), read the model's window directly from `ctx.model`
			// — Pi exposes it at model-select, independent of any message. This
			// is Pi's authoritative source (replacing the old models.dev lookup);
			// sane-bounded so a transient bad value can't shrink the budget to the
			// 60K default and over-archive. An unknown/insane window yields
			// undefined and we keep the live back-derivation path.
			if (usageContextLimit === undefined) {
				const modelWindow = ctx.model?.contextWindow;
				if (isSaneLimit(modelWindow)) {
					usageContextLimit = modelWindow;
				}
			}
			let schedulerDecision: "execute" | "defer";
			const tScheduler = performance.now();
			try {
				schedulerDecision = scheduler.shouldExecute(
					sessionMeta,
					{ percentage: usagePercentage, inputTokens: usageInputTokens },
					Date.now(),
					sessionId,
					modelKey,
					usageContextLimit,
				);
			} catch (err) {
				sessionLog(
					sessionId,
					`scheduler failed (defaulting to defer): ${err instanceof Error ? err.message : String(err)}`,
				);
				schedulerDecision = "defer";
			}
			logTransformTiming(sessionId, "schedulerAndUsage", tScheduler);

			// Migrated/imported sessions: a Pi session loaded with a large
			// existing JSONL has no usage data yet (pre-LLM-call) and no
			// `last_response_time` baseline, so the scheduler returns
			// "defer" on the brand-new-session branch — but the message
			// array IS already enormous and WILL overflow the model on
			// this turn. Force "execute" when the AgentMessage[] arriving
			// for transform is much larger than any healthy fresh session
			// would produce.
			//
			// Threshold: 50 messages. A normal first turn carries 1
			// system message + 1 user message; even a complex multi-step
			// first turn with tool calls would only reach ~10. 50 is
			// firmly in "this came from migration or session import"
			// territory and below it we keep the cache-friendly defer.
			const piMessageCount = Array.isArray(event.messages)
				? event.messages.length
				: 0;
			const looksLikeImportedSession =
				schedulerDecision === "defer" &&
				usagePercentage === 0 &&
				sessionMeta.lastResponseTime === 0 &&
				piMessageCount >= 50;
			if (looksLikeImportedSession) {
				schedulerDecision = "execute";
				sessionLog(
					sessionId,
					`transform: large imported session detected (${piMessageCount} messages, no usage baseline) — forcing execute on first pass`,
				);
			}
			logTransformTiming(sessionId, "modelChangeDetection", tModelDetect);

			// Pi stable-id scheme cutover (one-time, per session). When this
			// session's persisted tags/source_contents/caveman/placeholder state
			// were keyed under the OLD index-based pi-msg-* scheme (stored scheme <
			// PI_STABLE_ID_SCHEME, NULL = 0 = legacy), switching to real-entry-id
			// ids re-keys every row → the tagger re-tags and prior drops orphan.
			// Force ONE controlled execute+materialize pass so heuristic cleanup
			// re-drops by tag content and the prefix rebuilds in a single bust
			// (rather than an uncontrolled defer-pass bust that could leak
			// full-size content). Also clear stripped_placeholder_ids so the
			// forced pass rediscovers placeholders under the new scheme. The new
			// scheme is stamped only AFTER the pass succeeds (end of runPipeline),
			// so a mid-pass failure retries instead of skipping the cutover.
			const storedStableIdScheme = sessionMeta.piStableIdScheme ?? 0;
			// Only activate the cutover when REAL SessionEntry ids are available this
			// pass. The cutover re-keys persisted state from pi-msg-* index ids to
			// real entry ids; if branch resolution failed (strictEntryIds null →
			// pi-msg-* fallback), forcing an execute+materialize would burn a cache
			// bust without re-keying anything, then either false-complete (if we
			// stamped) or churn the placeholder set under pi-msg-* ids. Defer the
			// whole cutover to a later pass when getBranch() succeeds.
			const realEntryIdsAvailable =
				strictEntryIds?.some((id) => typeof id === "string" && id.length > 0) ??
				false;
			const stableIdSchemeCutover =
				storedStableIdScheme < PI_STABLE_ID_SCHEME && realEntryIdsAvailable;
			if (
				storedStableIdScheme < PI_STABLE_ID_SCHEME &&
				!realEntryIdsAvailable
			) {
				sessionLog(
					sessionId,
					`stable-id scheme cutover deferred: real SessionEntry ids unavailable this pass (branch resolution failed) — will retry when getBranch() succeeds`,
				);
			}
			if (stableIdSchemeCutover) {
				schedulerDecision = "execute";
				signalPiPendingMaterialization(sessionId);
				// Re-keying of stripped_placeholder_ids from pi-msg-* to real ids is
				// done by the strip's own prune this pass (forceDiscovery + carried
				// map → finalIds = idsToStrip ∩ presentIds, and stale pi-msg-* ids
				// aren't in the real-id presentIds, so they're dropped atomically
				// within the strip's persist). We deliberately do NOT pre-clear the
				// set here: an early clear before the pass succeeds would lose the
				// placeholder set on a mid-pass failure, and forceDiscovery keeps
				// retrying every pass until the scheme stamps anyway.
				sessionLog(
					sessionId,
					`stable-id scheme cutover: stored=${storedStableIdScheme} < current=${PI_STABLE_ID_SCHEME} — forcing execute+materialize this pass`,
				);
			}

			const schedulerDecisionEarly = schedulerDecision;
			const midTurn = isMidTurnPi(event, sessionId);
			const bypassReason = detectMidTurnBypassReason({
				contextUsage: { percentage: usagePercentage },
				sessionMeta,
				historyRefreshSessions,
				sessionId,
			});

			const { midTurnAdjustedSchedulerDecision, sideEffect } =
				applyMidTurnDeferral({
					base: schedulerDecisionEarly,
					bypassReason,
					midTurn,
				});

			if (sideEffect === "set-flag") {
				const flagPayload = {
					id: crypto.randomUUID(),
					reason: `${schedulerDecisionEarly}-${bypassReason}`,
					recordedAt: Date.now(),
				};
				setDeferredExecutePendingIfAbsent(options.db, sessionId, flagPayload);
			}

			schedulerDecision = midTurnAdjustedSchedulerDecision;
			const deferredExecutePending = peekDeferredExecutePending(
				options.db,
				sessionId,
			);
			if (
				deferredExecutePending !== null &&
				schedulerDecision === "defer" &&
				!midTurn
			) {
				schedulerDecision = "execute";
			}
			sessionLog(
				sessionId,
				`[boundary-exec] base=${schedulerDecisionEarly} bypass=${bypassReason} midTurn=${midTurn} effective=${midTurnAdjustedSchedulerDecision} sideEffect=${sideEffect}`,
			);

			// Force-materialization @ 85%+: aggressive drop-all-tools mode.
			// Mirrors OpenCode transform-postprocess-phase.ts:145-146.
			const forceMaterialization =
				usagePercentage >= FORCE_MATERIALIZATION_PERCENTAGE;

			// 95% emergency block: usage is dangerous enough that we
			// MUST wait for any in-flight historian to finish so its
			// queued drops can materialize on this pass, AND we apply
			// drop-all-tools cleanup to shrink the prompt as much as
			// possible before the LLM call. Mirrors OpenCode's >=95%
			// emergency path in transform.ts (~line 514+).
			//
			// Pi differences vs OpenCode:
			//   - We can't `client.session.abort()` mid-pass (Pi
			//     doesn't expose that surface to extensions). The next
			//     best is to await the in-flight historian here so the
			//     LLM call still happens, but with a freshly-shrunk
			//     prompt. If no historian is in flight we still apply
			//     dropAllTools via forceMaterialization so the prompt
			//     shrinks regardless.
			//   - We cap the wait at 30s to avoid stalling the user's
			//     turn forever if historian hangs. After 30s we fall
			//     through to the normal pipeline (with drop-all-tools
			//     still active via the 85%+ branch).
			const isEmergency = usagePercentage >= EMERGENCY_BLOCK_PERCENTAGE;
			if (isEmergency) {
				const lastNotifiedAt =
					lastEmergencyNotificationAtMs.get(sessionId) ?? 0;
				const now = Date.now();
				if (now - lastNotifiedAt >= EMERGENCY_NOTIFICATION_COOLDOWN_MS) {
					lastEmergencyNotificationAtMs.set(sessionId, now);
					sessionLog(
						sessionId,
						`EMERGENCY: usage=${usagePercentage.toFixed(1)}% — awaiting in-flight historian + applying drop-all-tools`,
					);
				}

				// Wait for in-flight historian (if any) so its drops can
				// be applied on this pass. Bounded so a hung historian
				// doesn't stall the user's turn.
				const histPromise = inFlightHistorian.get(sessionId);
				if (histPromise) {
					try {
						await withTimeout(histPromise, 30_000);
						sessionLog(
							sessionId,
							"EMERGENCY: historian wait completed (or timed out)",
						);
					} catch {
						// Historian already logged its own failure; just continue.
					}
				}
			}

			// `isCacheBusting` controls whether the injection cache is
			// bypassed for the `<session-history>` block. ONLY reads
			// `historyRefreshSessions` — the narrow injection-rebuild
			// signal — to mirror OpenCode's transform.ts:444 exactly.
			//
			// Critical: do NOT force a cache rebuild on every execute /
			// force / emergency pass. Those signal that THIS pass will
			// mutate tag state (drops, caveman, reasoning clearing), but
			// the rendered `<session-history>` block depends only on
			// stored compartments/facts/memories, which only change
			// when historian publishes (which sets historyRefreshSessions
			// via the shared compartment-runner publish path).
			//
			// Without this separation, every execute pass rebuilds and
			// re-renders the history block — busting Anthropic prompt
			// cache on EVERY tool call once context crosses the execute
			// threshold, exactly the regression Oracle flagged.
			// PEEK-then-drain-on-success pattern (Oracle audit Round 8 #6):
			// capture the boolean here, but DELETE only after
			// `injectSessionHistoryIntoPi(...)` succeeds inside
			// `runPipeline`. If injection throws, the flag survives so
			// the next pass retries the rebuild. Defer passes within the
			// same TTL window still hit the cached injection result
			// because the consumer compares against the cached cutoff.
			const isCacheBusting = historyRefreshSessions.has(sessionId);

			sessionLog(
				sessionId,
				`transform: usage=${usagePercentage.toFixed(1)}% (${usageInputTokens} tokens, limit=${usageContextLimit ?? "?"}) decision=${schedulerDecision}${forceMaterialization ? " force=true" : ""}${isEmergency ? " EMERGENCY=true" : ""}${isCacheBusting ? " busting=true" : ""}`,
			);
			logTransformTiming(
				sessionId,
				"emergencyRecoveryBlock",
				tEmergencyRecovery,
			);

			// Resolve SessionEntry IDs for each AgentMessage in event.messages
			// so the boundary lookup in `<session-history>` injection uses
			// the same id format historian persists. Reference-based
			// matching — see collectMessageEntryIdsByRef for why this is
			// preferred over the position-based collectMessageEntryIds.
			const entryIds = strictEntryIds ?? undefined;

			const result = await runPipeline({
				db: options.db,
				tagger,
				sessionId,
				projectIdentity,
				projectDirectory,
				messages: event.messages,
				ctxReduceEnabled: options.ctxReduceEnabled,
				protectedTags: options.protectedTags ?? 20,
				heuristics: options.heuristics,
				injection: options.injection
					? {
							...options.injection,
							// v2 decay rendering needs the HISTORY budget (~60K), not the
							// memory injection budget (~4K). Compute it from live usage +
							// historian config, mirroring OpenCode's decayPressure budget.
							historyBudgetTokens: resolveHistoryBudgetTokensForPi({
								historyBudgetPercentage:
									options.historian?.historyBudgetPercentage,
								usagePercentage,
								usageInputTokens,
								usageContextLimit,
								executeThresholdPercentage:
									options.historian?.executeThresholdPercentage,
								executeThresholdTokens:
									options.historian?.executeThresholdTokens,
								modelKey: liveModelBySession.get(sessionId),
							}),
						}
					: undefined,
				entryIds,
				entryIdByRef,
				stableIdSchemeCutover,
				schedulerDecision,
				// 95% emergency forces drop-all-tools regardless of the
				// 85% gate, so the LLM call sees the smallest possible
				// prompt before we hand control back to Pi.
				forceMaterialization: forceMaterialization || isEmergency,
				contextUsage: {
					percentage: usagePercentage,
					inputTokens: usageInputTokens,
				},
				isCacheBusting,
				reasoningClearing: {
					clearReasoningAge:
						options.heuristics?.clearReasoningAge ??
						DEFAULT_CLEAR_REASONING_AGE,
				},
				temporalAwareness: options.injection?.temporalAwareness === true,
				appendCompaction: resolvePiAppendCompaction(ctx),
				readBranchEntries: resolvePiReadBranchEntries(ctx),
			});

			// After tagging+drops have committed, check whether historian
			// should fire. Historian config is optional — tagging-only
			// behavior is the Step 4b.2 contract, and historian is
			// fire-and-forget so we never block the LLM call on it.
			if (options.historian) {
				maybeFireHistorian({
					ctx,
					sessionId,
					db: options.db,
					historian: options.historian,
					isFirstContextPassForSession,
					activeTags: result.activeTags,
					rawMessageProvider,
				});
			}

			// Stamp the new stable-id scheme ONLY after a successful cutover pass
			// that actually executed (re-tagged + re-dropped under the new scheme).
			// Stamp the new scheme only when the cutover's ESSENTIAL work completed.
			// Re-keying tag identity (pi-msg-* → entry-id) orphans the old drop
			// state, so previously-dropped tools resurface as fresh active tags;
			// the cutover is not "done" until heuristic cleanup actually re-dropped
			// them. `executedWorkThisPass` is too loose — it's set true even when
			// the heuristics try-block THREW (the empty-pending-ops path also sets
			// it), which would stamp the scheme while the re-drop never happened,
			// leaving resurrected tools in context permanently. Gate on
			// `heuristicsExecuted` (the re-drop ran without throwing) when heuristics
			// are enabled; when disabled there are no drops to redo, so a completed
			// pipeline (executedWorkThisPass) is sufficient. The forced pass reliably
			// runs heuristics (shouldRunHeuristics is true under the forced
			// execute+materialize), so a genuine throw defers the stamp and the next
			// pass retries the cutover rather than skipping it — no infinite loop
			// unless heuristics throws every pass, which is a separate bug that this
			// gate correctly refuses to paper over.
			const cutoverWorkComplete =
				options.heuristics === undefined
					? result.executedWorkThisPass
					: result.heuristicsExecuted;
			// `stableIdSchemeCutover` is already gated on realEntryIdsAvailable at
			// activation (see the cutover-detection block above), so reaching here
			// with it true guarantees real entry ids were used for the re-key. The
			// remaining gate is cutoverWorkComplete (the re-drop actually ran).
			if (stableIdSchemeCutover && cutoverWorkComplete) {
				try {
					updateSessionMeta(options.db, sessionId, {
						piStableIdScheme: PI_STABLE_ID_SCHEME,
					});
					sessionLog(
						sessionId,
						`stable-id scheme cutover complete — stamped scheme=${PI_STABLE_ID_SCHEME}`,
					);
				} catch (err) {
					sessionLog(
						sessionId,
						`stable-id cutover: failed to stamp scheme (will retry next pass): ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}

			// Step 4b.4: nudge + note-nudge + auto-search hint. All three
			// run AFTER tagging/drops finish so they see the post-mutation
			// message shape. Each is independently optional and fail-open —
			// any thrown error is logged and the pipeline returns the
			// already-mutated messages unchanged.
			const tPostTransform = performance.now();
			let outputMessages = result.messages as PiAgentMessage[];

			try {
				const cacheBustingPass = isCacheBusting || result.executedWorkThisPass;
				outputMessages = applyStickyTurnReminder({
					sessionId,
					db: options.db,
					messages: outputMessages,
					entryIds: entryIds ?? null,
					// Post-commit/post-splice ref-map from runPipeline — the
					// pass-start `entryIdByRef` keys pre-commit objects and misses
					// cloned (dirty) messages, resolving anchors to the wrong id.
					entryIdByRef: result.postCommitEntryIdByRef,
					hasRecentReduceCall: hasRecentPiCtxReduceExecution(sessionId),
					isCacheBustingPass: cacheBustingPass,
					syntheticLeadingCount: result.syntheticLeadingCount,
				});
			} catch (err) {
				sessionLog(
					sessionId,
					`sticky turn reminder failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			// Rolling nudge inserts exactly one id-less synthetic assistant
			// message when it fires. Track it via the array-length delta so the
			// note-nudge anchor-GC denominator below can exclude it too —
			// otherwise the extra unresolved synthetic keeps allResolved false and
			// the GC never prunes. (Sticky reminder above runs BEFORE the nudge, so
			// it correctly excludes only the m[0]/m[1] prepends.)
			let rollingNudgeSyntheticCount = 0;
			if (nudgerFn && options.nudge) {
				try {
					const tNudge = performance.now();
					const beforeLen = outputMessages.length;
					outputMessages = applyRollingNudge({
						sessionId,
						db: options.db,
						messages: outputMessages,
						ctx,
						nudgerFn,
					});
					rollingNudgeSyntheticCount = Math.max(
						0,
						outputMessages.length - beforeLen,
					);
					logTransformTiming(sessionId, "applyContextNudge", tNudge);
				} catch (err) {
					sessionLog(
						sessionId,
						`rolling nudge failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}

			try {
				outputMessages = applyNoteNudges({
					sessionId,
					db: options.db,
					messages: outputMessages,
					projectIdentity,
					entryIds: strictEntryIds,
					// Post-commit/post-splice ref-map (see sticky reminder above).
					entryIdByRef: result.postCommitEntryIdByRef,
					// Same signal OpenCode uses to gate sticky-anchor GC
					// (isCacheBustingPass = history-refresh OR work executed).
					isCacheBusting: isCacheBusting || result.executedWorkThisPass,
					// All id-less synthetic injections present in outputMessages: the
					// m[0]/m[1] prepends PLUS the rolling-nudge synthetic (if it
					// fired this pass). Excluded from the anchor-GC denominator.
					syntheticLeadingCount:
						result.syntheticLeadingCount + rollingNudgeSyntheticCount,
				});
			} catch (err) {
				sessionLog(
					sessionId,
					`note nudges failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			if (options.autoSearch?.enabled) {
				try {
					await ensureProjectRegisteredFromPiDirectory(
						projectDirectory,
						options.db,
					);
					outputMessages = await runAutoSearchHintForPi({
						sessionId,
						db: options.db,
						messages: outputMessages,
						entryIds: strictEntryIds,
						// Post-commit/post-splice ref-map (see sticky reminder above).
						entryIdByRef: result.postCommitEntryIdByRef,
						options: {
							enabled: true,
							scoreThreshold: options.autoSearch.scoreThreshold,
							minPromptChars: options.autoSearch.minPromptChars,
							projectPath: projectIdentity,
							visibleMemoryIds:
								getVisibleMemoryIds(options.db, sessionId) ?? null,
						},
					});
				} catch (err) {
					sessionLog(
						sessionId,
						`auto-search failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}

			// Synthetic todowrite injection — Pi parity with OpenCode's
			// transform-postprocess-phase.ts B7. On cache-busting passes,
			// inject a Pi-shape toolCall + toolResult pair built from the
			// `session_meta.last_todo_state` snapshot captured by
			// `tool_execution_start` in index.ts. On defer passes, replay
			// the same pair from the persisted snapshot to keep wire bytes
			// byte-identical (Anthropic prompt cache stability).
			//
			// Cache-busting gate parity: OpenCode uses
			// `isCacheBustingPass = shouldApplyPendingOps || shouldRunHeuristics`
			// (transform-postprocess-phase.ts:273). Pi's `isCacheBusting`
			// flag from the outer handler only covers history refresh
			// (historian publication), so we OR it with
			// `result.executedWorkThisPass` — pending-op materialization,
			// heuristic cleanup, or reasoning clearing — to match
			// OpenCode's broader "execute pass that actually mutated state"
			// semantics.
			//
			// Subagents skip — they don't get synthetic injection in
			// OpenCode either (see B7 `args.fullFeatureMode` gate).
			try {
				const sessionMetaForTodo = getOrCreateSessionMeta(
					options.db,
					sessionId,
				);
				if (
					!sessionMetaForTodo.isSubagent &&
					sessionMetaForTodo.lastTodoState !== ""
				) {
					const isCacheBustingForTodo =
						isCacheBusting || result.executedWorkThisPass;
					outputMessages = injectSyntheticTodowriteForPi({
						db: options.db,
						sessionId,
						isSubagent: sessionMetaForTodo.isSubagent,
						isCacheBusting: isCacheBustingForTodo,
						lastTodoState: sessionMetaForTodo.lastTodoState,
						messages: outputMessages as unknown as Parameters<
							typeof injectSyntheticTodowriteForPi
						>[0]["messages"],
					}) as unknown as typeof outputMessages;
				}
			} catch (err) {
				sessionLog(
					sessionId,
					`synthetic todowrite injection failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			// Work-metrics update runs on EVERY transform pass (not just
			// execute passes). The Pi compute helper is pure-read on
			// outputMessages; setSessionWorkMetrics is a pure write to
			// session_meta (no tag state, no message[0] mutation, no
			// cache-busting). Gating on executedWorkThisPass would mean
			// sessions sitting below execute threshold never see populated
			// values, making Pi's status surface permanently zero.
			try {
				const metrics = computePiWorkMetrics(outputMessages as unknown[]);
				setSessionWorkMetrics(
					options.db,
					sessionId,
					metrics.newWorkTokens,
					metrics.totalInputTokens,
				);
			} catch (err) {
				sessionLog(
					sessionId,
					`work-metrics update failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			logTransformTiming(sessionId, "postTransformPhase", tPostTransform);
			sessionLog(
				sessionId,
				`transform completed in ${(performance.now() - transformStartTime).toFixed(1)}ms (${outputMessages.length} messages, ${result.targetCount} targets, watermark: ${result.reasoningWatermark})`,
			);

			// Cast the rebuilt array back to the AgentMessage[] shape Pi's
			// ContextEventResult expects. The nudge/note/auto-search paths
			// preserve message identity for unchanged messages and only
			// rebuild the mutated ones, so this cast is safe at runtime.
			clearLastTransformErrorIfSet(options.db, sessionId);
			return { messages: outputMessages } as {
				messages: typeof event.messages;
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error ? err.stack : undefined;
			log(
				`[magic-context][pi] context handler failed (continuing without mutation): ${message}`,
				stack,
			);
			if (sessionIdForError) {
				persistLastTransformErrorIfChanged(
					options.db,
					sessionIdForError,
					summarizeTransformError(err),
				);
			}
			// Fall through with no mutation — Pi proceeds with original
			// messages, equivalent to a no-op transform pass.
			return;
		}
	});
	log(
		"[magic-context][pi] registered context handler (tagging + drops + nudges)",
	);
}

/**
 * Track in-flight historian runs per session so we don't fire a second
 * pass while the first is still running. The flag also exists in
 * session_meta.compartment_in_progress (see `runPiHistorian` setting
 * it), but that DB-side flag is durable across restarts and the
 * trigger logic already inspects it; this in-memory map is a
 * fast-path so we don't hit the DB just to dedupe per turn.
 *
 * We store the actual Promise (not just the session id) so the
 * `session_shutdown` handler can `await` outstanding runs before Pi
 * exits — critical for `pi --print` mode where the parent process
 * exits as soon as `agent_end` fires, otherwise killing the historian
 * subprocess mid-run.
 */
const inFlightHistorian = new Map<string, Promise<unknown>>();

/**
 * Wait for all in-flight historian runs to complete. Called from the
 * Pi `session_shutdown` event handler so historian can finish writing
 * compartments before the process exits. Returns immediately if no
 * runs are in-flight.
 */
export async function awaitInFlightHistorians(): Promise<void> {
	if (inFlightHistorian.size === 0) return;
	await Promise.allSettled(Array.from(inFlightHistorian.values()));
}

export function resolvePiHistorianTriggerInputs(args: {
	db: ContextDatabase;
	sessionId: string;
	historian: PiHistorianOptions;
	modelKey: string | undefined;
	usageContextLimit?: number;
}): {
	executeThresholdPercentage: number;
	triggerBudget: number;
	autoDropToolAge: number;
	protectedTags: number | undefined;
	clearReasoningAge: number;
	dropToolStructure: boolean;
	commitClusterTrigger: { enabled: boolean; min_clusters: number } | undefined;
	contextLimit: number;
} {
	// Pi resolves the context window from its own runtime (passed in as
	// usageContextLimit, derived from getContextUsage()/getModel().contextWindow
	// with the detected-overflow override already applied). models.dev is not
	// consulted for Pi. Fall back to the conservative default only when the
	// runtime hasn't reported a usable window yet.
	const contextLimit =
		typeof args.usageContextLimit === "number" &&
		Number.isFinite(args.usageContextLimit) &&
		args.usageContextLimit > 0
			? args.usageContextLimit
			: DEFAULT_CONTEXT_LIMIT;
	const executeThresholdPercentage = resolveExecuteThreshold(
		args.historian.executeThresholdPercentage ?? 65,
		args.modelKey,
		65,
		{
			tokensConfig: args.historian.executeThresholdTokens,
			contextLimit,
			sessionId: args.sessionId,
		},
	);
	return {
		executeThresholdPercentage,
		triggerBudget: deriveTriggerBudget(
			contextLimit,
			executeThresholdPercentage,
		),
		autoDropToolAge: args.historian.autoDropToolAge ?? 100,
		protectedTags: args.historian.protectedTags,
		clearReasoningAge:
			args.historian.clearReasoningAge ?? DEFAULT_CLEAR_REASONING_AGE,
		dropToolStructure: args.historian.dropToolStructure ?? true,
		commitClusterTrigger: args.historian.commitClusterTrigger,
		contextLimit,
	};
}

export function resolveHistoryBudgetTokensForPi(args: {
	historyBudgetPercentage: number | undefined;
	usagePercentage: number;
	usageInputTokens: number;
	usageContextLimit: number | undefined;
	executeThresholdPercentage: PiHistorianOptions["executeThresholdPercentage"];
	executeThresholdTokens: PiHistorianOptions["executeThresholdTokens"];
	modelKey: string | undefined;
}): number | undefined {
	const {
		historyBudgetPercentage,
		usagePercentage,
		usageInputTokens,
		usageContextLimit,
		executeThresholdPercentage,
		executeThresholdTokens,
		modelKey,
	} = args;
	if (!historyBudgetPercentage) return undefined;
	// Prefer the model's STABLE context limit (Pi reports contextWindow; an
	// overflow-detected limit overrides it). Only fall back to the live-usage
	// back-derivation when no stable limit is available — and that fallback
	// needs a positive percentage. The earlier `usagePercentage <= 0` early
	// return was too aggressive: on the first pass after restart Pi can report
	// percentage=0 while contextWindow is already known, which forced the
	// budget through to the hard-coded 60K default and over-archived history
	// (matches the OpenCode resolveHistoryBudgetTokens fix).
	const derivedLimit =
		usageContextLimit && usageContextLimit > 0
			? usageContextLimit
			: usagePercentage > 0 && usageInputTokens > 0
				? usageInputTokens / (usagePercentage / 100)
				: 0;
	if (!Number.isFinite(derivedLimit) || derivedLimit <= 0) return undefined;
	return Math.floor(
		derivedLimit *
			// Pass executeThresholdTokens so token-based per-model thresholds drive
			// the history budget identically to OpenCode (resolveHistoryBudgetTokens).
			// Without it, a session configured with execute_threshold_tokens would
			// get a different (percentage-only) decay budget than OpenCode → different
			// render tiers for the same state.
			(resolveExecuteThreshold(executeThresholdPercentage ?? 65, modelKey, 65, {
				tokensConfig: executeThresholdTokens,
				contextLimit: derivedLimit,
			}) /
				100) *
			historyBudgetPercentage,
	);
}

function startPiCompartmentLeaseRenewal(
	db: ContextDatabase,
	sessionId: string,
	holderId: string,
): ReturnType<typeof setInterval> {
	return setInterval(() => {
		if (!renewCompartmentLease(db, sessionId, holderId)) {
			sessionLog(
				sessionId,
				"compartment lease renewal failed; publish will be skipped if holder is stale",
			);
		}
	}, COMPARTMENT_LEASE_RENEWAL_MS);
}

function hasEligiblePiCompartmentHistory(
	db: ContextDatabase,
	sessionId: string,
): boolean {
	try {
		const lastCompartmentEnd = getLastCompartmentEndMessage(db, sessionId);
		const nextStartOrdinal = Math.max(1, lastCompartmentEnd + 1);
		const rawMessageCount = getRawSessionMessageCount(sessionId);
		const protectedTailStart = getProtectedTailStartOrdinal(sessionId);
		return (
			rawMessageCount >= nextStartOrdinal &&
			nextStartOrdinal < protectedTailStart
		);
	} catch (err) {
		sessionLog(
			sessionId,
			`historian recovery eligibility failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
}

function sendPiIgnoredNotification(
	ctx: ExtensionContext,
	message: string,
): void {
	const uiNotify = (ctx as { ui?: { notify?: (message: string) => unknown } })
		.ui?.notify;
	if (typeof uiNotify === "function") {
		try {
			void uiNotify.call(ctx.ui, message);
			return;
		} catch {
			// Fall through to session log below.
		}
	}
	sessionLog("pi", message);
}

function spawnPiHistorianRun(args: {
	ctx: ExtensionContext;
	sessionId: string;
	db: ContextDatabase;
	historian: PiHistorianOptions;
	provider: { readMessages: () => ReturnType<typeof readPiSessionMessages> };
	unregister: () => void;
}): void {
	const { ctx, sessionId, db, historian, provider, unregister } = args;
	const holderId = crypto.randomUUID();
	const runPromise = (async () => {
		const lease = acquireCompartmentLease(db, sessionId, holderId);
		if (!lease) {
			sessionLog(
				sessionId,
				"historian skipped: compartment lease held by another process",
			);
			return;
		}
		const renewal = startPiCompartmentLeaseRenewal(db, sessionId, holderId);
		try {
			await runPiHistorian({
				db,
				sessionId,
				directory: ctx.cwd,
				provider,
				appendCompaction: resolvePiAppendCompaction(ctx),
				readBranchEntries: resolvePiReadBranchEntries(ctx),
				runner: historian.runner,
				historianModel: historian.model,
				fallbackModels: historian.fallbackModels,
				historianChunkTokens: historian.historianChunkTokens,
				historianTimeoutMs: historian.timeoutMs,
				twoPass: historian.twoPass,
				thinkingLevel: historian.thinkingLevel,
				memoryEnabled: historian.memoryEnabled,
				autoPromote: historian.autoPromote,
				userMemoriesEnabled: historian.userMemoriesEnabled,
				compartmentLeaseHolderId: holderId,
				onPublished: () => {
					const sessionStillActive = isContextHandlerSessionActive(sessionId);
					try {
						clearEmergencyRecovery(db, sessionId);
					} catch (err) {
						sessionLog(
							sessionId,
							`historian: clearEmergencyRecovery failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
					// Historian publication invalidates the injection cache AND
					// queues drops for the messages now covered by new
					// compartments. Mirrors OpenCode's onInjectionCacheCleared
					// callback in transform.ts:502-505:
					//   - signalPiHistoryRefresh: triggers ONE rebuild on the next
					//     transform pass (drained immediately after rebuild).
					//   - signalPiPendingMaterialization: queues the drops the
					//     historian published; persists until the next pipeline
					//     pass actually materializes them. Without this signal,
					//     drops sit in pending_ops and context climbs until the
					//     85% force-materialization threshold — exactly the
					//     "context kept going up after historian ran" symptom
					//     users observed at 64% → 69%+ on Pi.
					//
					// We deliberately do NOT signal systemPromptRefresh — historian
					// doesn't change disk-backed adjuncts (docs/profile/key-files),
					// so re-reading them would burn IO for nothing.
					signalPiDeferredHistoryRefresh(sessionId);
					signalPiDeferredMaterialization(sessionId);
					if (sessionStillActive) {
						historian.onStatusChange?.(ctx, sessionId);
					} else {
						sessionLog(
							sessionId,
							"historian publication recorded after session clear; status callback skipped",
						);
					}
				},
			});
		} finally {
			clearInterval(renewal);
			releaseCompartmentLease(db, sessionId, holderId);
		}
	})().finally(() => {
		inFlightHistorian.delete(sessionId);
		unregister();
		if (isContextHandlerSessionActive(sessionId)) {
			historian.onStatusChange?.(ctx, sessionId);
		}
	});
	inFlightHistorian.set(sessionId, runPromise);
	historian.onStatusChange?.(ctx, sessionId);
}

function resolvePiAppendCompaction(
	ctx: ExtensionContext,
): PiHistorianDeps["appendCompaction"] {
	const sm = ctx.sessionManager as
		| {
				appendCompaction?: (
					summary: string,
					firstKeptEntryId: string,
					tokensBefore: number,
					details?: unknown,
					fromHook?: boolean,
				) => string | undefined;
		  }
		| undefined;
	if (typeof sm?.appendCompaction !== "function") return undefined;
	return sm.appendCompaction.bind(sm);
}

function resolvePiReadBranchEntries(
	ctx: ExtensionContext,
): (() => unknown[]) | undefined {
	const sm = ctx.sessionManager as { getBranch?: () => unknown[] } | undefined;
	if (typeof sm?.getBranch !== "function") return undefined;
	return () => {
		const entries = sm.getBranch?.call(sm);
		if (!Array.isArray(entries)) {
			throw new Error("Pi sessionManager.getBranch() did not return an array");
		}
		return entries;
	};
}

/**
 * Trigger evaluation + fire-and-forget historian invocation. Runs
 * after the synchronous tagging pass so trigger logic sees the
 * just-assigned tags.
 *
 * The actual historian subagent spawn (`runPiHistorian`) is async
 * and intentionally NOT awaited — the LLM call should never wait on
 * historian. Errors are logged but never propagated; the user's
 * agent turn continues regardless of historian outcome.
 */
function maybeFireHistorian(args: {
	ctx: ExtensionContext;
	sessionId: string;
	db: ContextDatabase;
	historian: PiHistorianOptions;
	isFirstContextPassForSession?: boolean;
	activeTags?: ReturnType<typeof getActiveTagsBySession>;
	rawMessageProvider?: {
		readMessages: () => ReturnType<typeof readPiSessionMessages>;
	};
}): void {
	const { ctx, sessionId, db, historian, isFirstContextPassForSession } = args;

	if (inFlightHistorian.has(sessionId)) {
		sessionLog(sessionId, "historian trigger eval: in-flight, skipping");
		return;
	}

	// Prefer OpenCode-equivalent pressure persisted by message_end.
	// Pi's built-in `ctx.getContextUsage()` reports total-tokens
	// percent (input + output + cache), but historian/trigger math
	// expects wire-input pressure (input + cacheRead + cacheWrite).
	// `session_meta.lastContextPercentage` carries the corrected value
	// computed by `pi-pressure.ts` against the effective context
	// limit (with detected_context_limit override applied).
	let usage: { percentage: number; inputTokens: number };
	let usageContextLimit: number | undefined;
	try {
		const piUsage = ctx.getContextUsage?.();
		usageContextLimit =
			typeof piUsage?.contextWindow === "number" && piUsage.contextWindow > 0
				? piUsage.contextWindow
				: undefined;
		const sessionMetaForUsage = getOrCreateSessionMeta(db, sessionId);
		if (
			sessionMetaForUsage.lastContextPercentage > 0 &&
			sessionMetaForUsage.lastInputTokens > 0
		) {
			usage = {
				percentage: sessionMetaForUsage.lastContextPercentage,
				inputTokens: sessionMetaForUsage.lastInputTokens,
			};
			sessionLog(
				sessionId,
				`historian trigger eval: usage=${usage.percentage.toFixed(1)}% (${usage.inputTokens} tokens) [from session_meta], checking trigger...`,
			);
		} else {
			// Fallback to Pi-reported usage when no message_end has
			// landed yet (first turn). This is the same fallback the
			// original implementation used; the +output token drift
			// of ~0.1% is acceptable on the first turn before
			// message_end runs.
			if (
				!piUsage ||
				piUsage.tokens === null ||
				piUsage.percent === null ||
				piUsage.contextWindow === 0
			) {
				sessionLog(
					sessionId,
					`historian trigger eval: no usage info yet (tokens=${piUsage?.tokens ?? "<no piUsage>"}, percent=${piUsage?.percent ?? "<no piUsage>"}, contextWindow=${piUsage?.contextWindow ?? "<no piUsage>"})`,
				);
				return;
			}
			usage = {
				percentage: piUsage.percent,
				inputTokens: piUsage.tokens,
			};
			sessionLog(
				sessionId,
				`historian trigger eval: usage=${usage.percentage.toFixed(1)}% (${usage.inputTokens} tokens) [piUsage fallback], checking trigger...`,
			);
		}
	} catch (err) {
		sessionLog(
			sessionId,
			`historian trigger eval: getContextUsage threw: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}

	// Register the Pi RawMessageProvider for this sessionId so the
	// shared trigger logic + historian can read Pi session messages
	// via the standard `readRawSessionMessages` etc. helpers. The
	// provider stays registered while the historian runs and
	// unregisters in finally.
	const provider = args.rawMessageProvider ?? {
		readMessages: () => readPiSessionMessages(ctx),
	};
	const unregister = setRawMessageProvider(sessionId, provider);

	let triggered = false;
	try {
		if (isFirstContextPassForSession) {
			const sessionMeta = getOrCreateSessionMeta(db, sessionId);
			if (
				sessionMeta.compartmentInProgress &&
				!inFlightHistorian.has(sessionId)
			) {
				updateSessionMeta(db, sessionId, { compartmentInProgress: false });
				sessionLog(
					sessionId,
					"historian: cleared stale compartmentInProgress flag on first context pass after restart",
				);
			}

			const failureState = getHistorianFailureState(db, sessionId);
			const shouldRecoverOnFirstPass =
				failureState.failureCount > 0 &&
				hasEligiblePiCompartmentHistory(db, sessionId);
			if (shouldRecoverOnFirstPass) {
				triggered = true;
				sessionLog(
					sessionId,
					`historian recovery triggered on session load after ${failureState.failureCount} failure(s)`,
				);
				sendPiIgnoredNotification(
					ctx,
					`## Historian recovery\n\nHistorian previously failed ${failureState.failureCount} time(s), so Magic Context is retrying history comparting immediately after restart.`,
				);
				spawnPiHistorianRun({
					ctx,
					sessionId,
					db,
					historian,
					provider,
					unregister,
				});
				return;
			}
		}

		const sessionMeta = getOrCreateSessionMeta(db, sessionId);
		const modelKey = liveModelBySession.get(sessionId);
		const triggerInputs = resolvePiHistorianTriggerInputs({
			db,
			sessionId,
			historian,
			modelKey,
			usageContextLimit,
		});
		const trigger = checkCompartmentTrigger(
			db,
			sessionId,
			sessionMeta,
			usage,
			0, // _previousPercentage — unused by current trigger logic
			triggerInputs.executeThresholdPercentage,
			triggerInputs.triggerBudget,
			triggerInputs.autoDropToolAge,
			triggerInputs.protectedTags,
			triggerInputs.clearReasoningAge,
			triggerInputs.dropToolStructure,
			triggerInputs.commitClusterTrigger,
			args.activeTags,
		);

		if (!trigger.shouldFire) {
			sessionLog(
				sessionId,
				`historian trigger eval: shouldFire=false (no trigger condition met)`,
			);
			return;
		}

		triggered = true;
		sessionLog(
			sessionId,
			`historian trigger fired (reason=${trigger.reason ?? "unknown"}) usage=${usage.percentage.toFixed(1)}% — spawning subagent`,
		);

		// Fire-and-forget for the user's LLM call: the parent agent
		// turn never awaits this. But we DO track the Promise in
		// inFlightHistorian so `awaitInFlightHistorians()` can wait
		// at session_shutdown — without that, `pi --print` mode would
		// kill the historian subprocess mid-run when the parent exits.
		spawnPiHistorianRun({
			ctx,
			sessionId,
			db,
			historian,
			provider,
			unregister,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		sessionLog(sessionId, `historian trigger eval failed: ${message}`);
	} finally {
		if (!triggered) unregister();
	}
}
interface RunPipelineArgs {
	db: ContextDatabase;
	tagger: Tagger;
	sessionId: string;
	projectIdentity: string;
	projectDirectory: string;
	messages: Parameters<typeof createPiTranscript>[0];
	ctxReduceEnabled: boolean;
	protectedTags: number;
	/** Heuristic-cleanup config — when omitted, defaults to OpenCode parity values. */
	heuristics?: {
		autoDropToolAge: number;
		dropToolStructure: boolean;
		caveman?: { enabled: boolean; minChars: number };
	};
	/** Memory-injection config — when omitted, no <session-history> injection runs. */
	injection?: {
		injectionBudgetTokens: number;
		/** v2 decay-render history budget (~60K), distinct from the memory
		 *  injection budget. Drives compartment tier demotion in renderM0Pi. */
		historyBudgetTokens?: number;
		temporalAwareness?: boolean;
		keyFilesEnabled?: boolean;
		keyFilesTokenBudget?: number;
	};
	/**
	 * Optional entry-id array, indexed 1:1 with `messages`, providing
	 * the SessionEntry id for each AgentMessage. When supplied,
	 * `injectSessionHistoryIntoPi` uses these IDs for compartment
	 * boundary lookup — matching what historian persists as
	 * `start_message_id`/`end_message_id` (set up via read-session-pi.ts:
	 * `RawMessage.id = entry.id`). Caller resolves this by walking
	 * `ctx.sessionManager.getBranch()` and filtering to message-type
	 * entries — same filter `buildSessionContext` applies.
	 *
	 * Without this, boundary lookup falls back to a synthesized
	 * `pi-msg-${index}-${ts}-${role}` id, which never matches anything
	 * historian wrote → `<session-history>` cannot trim raw history.
	 */
	entryIds?: readonly (string | undefined)[];
	/**
	 * Splice-safe message→entryId map keyed by AgentMessage reference. Best-effort
	 * first try for stable-id resolution (misses messages tagging/drops cloned this
	 * pass — positional entryIds is the mandatory fallback). Threaded so the
	 * transcript-tag path and the reasoning/heuristic stable-id paths resolve the
	 * SAME id for a message (the cross-path lookup invariant).
	 */
	entryIdByRef?: ReadonlyMap<object, string> | null;
	/**
	 * True on the one-time stable-id-scheme cutover pass (Pi message identity
	 * switched from index-based to real-entry-id). Forces placeholder rediscovery
	 * under the new scheme. The forced execute+materialize cutover machinery
	 * (pi_stable_id_scheme persisted version) is wired by the caller; when unset,
	 * no cutover behavior runs (safe default).
	 */
	stableIdSchemeCutover?: boolean;
	/**
	 * Pre-resolved scheduler decision for THIS pass. When `"execute"`,
	 * heuristic cleanup runs (cache-busting). When `"defer"`, only the
	 * cache-stable stages run (tagging + applyFlushedStatuses + replay
	 * cached injection). Mirrors OpenCode's `schedulerDecisionEarly`.
	 */
	schedulerDecision: "execute" | "defer";
	/**
	 * Force-materialization signal: when true, drop-all-tools mode
	 * activates (mirrors OpenCode's >=85% emergency cleanup). Caller
	 * computes from current usage percentage.
	 */
	forceMaterialization?: boolean;
	contextUsage: { percentage: number; inputTokens: number };
	/**
	 * One-shot signal that the injection cache should be invalidated and
	 * the prepared block rebuilt on this pass. Mirrors OpenCode's
	 * historyRefreshSessions set.
	 */
	isCacheBusting: boolean;
	/**
	 * Reasoning-clearing config. When provided, typed PiThinkingContent
	 * blocks for messages older than `clearReasoningAge` from the newest
	 * tag are replaced with `[cleared]` on execute passes; the watermark
	 * is persisted to `session_meta.cleared_reasoning_through_tag` so
	 * defer passes replay the cleared state. Mirrors OpenCode's
	 * `clearOldReasoning` + `replayClearedReasoning` pair.
	 *
	 * OpenCode PR #24146 (preserve empty reasoning_content for DeepSeek
	 * V4 thinking mode) made the provider transform always emit the
	 * interleaved field (e.g. Moonshot/Kimi `reasoning_content`) — empty
	 * when no reasoning parts remain — so providers that previously
	 * needed prior reasoning preserved no longer reject the request.
	 */
	reasoningClearing?: {
		clearReasoningAge: number;
	};
	/**
	 * Whether to inject temporal `<!-- +Xm -->` markers into user
	 * messages with large gaps. Mirrors OpenCode's
	 * `experimental.temporal_awareness`. Idempotent across passes.
	 */
	temporalAwareness?: boolean;
	appendCompaction?: ApplyDeferredPiCompactionMarkerDeps["appendCompaction"];
	readBranchEntries?: ApplyDeferredPiCompactionMarkerDeps["readBranchEntries"];
}

interface RunPipelineResult {
	messages: unknown[];
	/** Whether heuristic cleanup actually ran on this pass. */
	heuristicsExecuted: boolean;
	/** Whether any execute-only state mutation ran on this pass. */
	executedWorkThisPass: boolean;
	/** Whether <session-history> was written into message[0]. */
	historyInjected: boolean;
	/**
	 * Count of synthetic id-less messages injection prepended (the m[0]/m[1]
	 * pair). Anchor-GC excludes these from its "all messages resolved"
	 * denominator — they never resolve to a real entry id, so without this
	 * exclusion `allResolved` is permanently false and pruning never runs.
	 */
	syntheticLeadingCount: number;
	/** Aggregate counts for log parity with OpenCode. */
	heuristicsResult: PiHeuristicCleanupResult | null;
	injectionResult: PiInjectionResult | null;
	targetCount: number;
	reasoningWatermark: number;
	activeTags: ReturnType<typeof getActiveTagsBySession>;
	/**
	 * REAL-SessionEntry-id map keyed by AgentMessage object identity, built AFTER
	 * transcript.commit() and BEFORE injection splices. The ONLY correct map for
	 * consumers running after runPipeline mutated the array (sticky reminder,
	 * note nudges, auto-search): the pass-start `entryIdByRef` keys pre-commit
	 * objects and misses every cloned (dirty) message. Contains NO pi-msg-*
	 * fallback ids, so a branch-resolution failure leaves a message unmapped and
	 * the consumer correctly falls to its degraded (entryIds === null) path.
	 */
	postCommitEntryIdByRef: ReadonlyMap<object, string>;
}

async function runPipeline(args: RunPipelineArgs): Promise<RunPipelineResult> {
	let executedWorkThisPass = false;
	let historyWasConsumedThisPass = false;
	let materializationSatisfiedThisPass = false;
	let suppressDeferredHistoryDrain = false;
	let casLost = false;
	const deferredHistoryWasPendingAtPassStart =
		deferredHistoryRefreshSessions.has(args.sessionId);

	// 0. Inject temporal `<!-- +Xm -->` markers into user messages
	// BEFORE tagging so the §N§ tag prefix wraps around our marker on
	// re-tagging. Idempotent: existing markers are detected by regex
	// and skipped. Same invariants as OpenCode's `injectTemporalMarkers`
	// at transform.ts:648 — runs on every pass, deterministic from
	// timestamps, retroactive when the flag flips.
	if (args.temporalAwareness) {
		const tTemporal = performance.now();
		try {
			const injected = injectPiTemporalMarkers(args.messages);
			if (injected > 0) {
				sessionLog(
					args.sessionId,
					`temporal-awareness: injected ${injected} gap markers`,
				);
			}
		} catch (err) {
			sessionLog(
				args.sessionId,
				`temporal-awareness failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		logTransformTiming(args.sessionId, "injectTemporalMarkers", tTemporal);
	}

	// Pass entryIds so the transcript tags each message under its real SessionEntry
	// id (position-independent) instead of the index-based pi-msg-* id that drifts
	// when the visible array shifts (compaction trim / custom_message inserts),
	// orphaning tags/source_contents/caveman/drop-state. Positional entryIds is
	// exactly aligned here: tagging runs at transcript-build time, before any splice.
	const transcript = createPiTranscript(
		args.messages,
		args.sessionId,
		args.entryIds,
	);
	// Reasoning clearing/replay mutate `part.thinking` in place. They MUST target
	// the transcript's `working` array (the channel commit() flushes), not the
	// original `args.messages`: tagging/drops/caveman reassign working[idx] to
	// fresh objects, so a reasoning mutation written to args.messages[idx] (a
	// now-divergent object) would be discarded when commit() does
	// source[idx] = working[idx], leaving the cleared-reasoning watermark ahead
	// of the actual wire bytes → defer-pass replay divergence → cache bust.
	const workingMessages = transcript.getWorkingMessages();
	// Stable-id resolver for the reasoning/placeholder paths. MUST match the id the
	// transcript assigned each message (so reasoning's messageIdToMaxTag lookup
	// hits). Reasoning runs on `workingMessages` where tagging may have cloned
	// working[i] → entryIdByRef misses those, so positional args.entryIds is the
	// mandatory fallback (same precedence resolvePiStableId enforces).
	const stableIdResolver = (msg: unknown, index: number): string | undefined =>
		resolvePiStableId(
			msg,
			index,
			args.entryIds,
			args.entryIdByRef ?? undefined,
		);
	const currentTurnId = (() => {
		const ids = buildPiMessageIdByIndex(
			args.messages as PiAgentMessage[],
			args.entryIds ?? null,
		);
		return (
			findLatestUserMessageIdPi(args.messages as PiAgentMessage[], ids)
				?.messageId ?? null
		);
	})();
	const alreadyRanHeuristicsThisTurn =
		currentTurnId !== null &&
		lastHeuristicsTurnIdBySession.get(args.sessionId) === currentTurnId;
	// Pi sessions are primary-equivalent today. If Pi adds subagents on this
	// transform path, subagents should bypass this once-per-turn guard like
	// OpenCode does, because they do not share the primary agent's turn cache.
	const shouldRunHeuristics =
		args.heuristics !== undefined &&
		(args.forceMaterialization === true ||
			hasPendingMaterialization(args.sessionId) ||
			deferredMaterializationSessions.has(args.sessionId) ||
			(args.schedulerDecision === "execute" && !alreadyRanHeuristicsThisTurn));

	// 1. Tagging: assigns tag numbers + injects §N§ prefixes (unless
	// ctx_reduce_enabled is false, in which case prefixes are skipped
	// but DB-side tag IDs still get created so drops continue to work).
	//
	// Pi-only fallback-tag adoption: the newest (in-flight) message is tagged
	// under an unstable pi-msg-* fallback id on the pass it is newest (its real
	// SessionEntry id isn't resolvable yet), then resolves to its real id one
	// pass later. Build a raw-message fingerprint map (BEFORE tagging mutates
	// text) and migrate any fallback-id tag onto the real id up front, so the
	// message keeps its tag_number/§N§ instead of getting a fresh tag. No-op for
	// OpenCode (this path is Pi-only) and for messages already on a real id.
	const entryFingerprintByMessageId = buildEntryFingerprintMap(
		args.messages as PiAgentMessage[],
		stableIdResolver,
	);
	adoptPiFallbackTags(
		args.db,
		args.sessionId,
		args.tagger,
		entryFingerprintByMessageId,
	);
	const tTag = performance.now();
	const { targets } = tagTranscript(
		args.sessionId,
		transcript,
		args.tagger,
		args.db,
		{
			skipPrefixInjection: !args.ctxReduceEnabled,
			entryFingerprintByMessageId,
		},
	);
	logTransformTiming(args.sessionId, "tagMessages", tTag);

	// 1b. Note-nudge `commit_detected` trigger. Mirrors OpenCode's logic
	// in `tag-messages.ts` + `transform.ts:677-690`: only fire on the
	// RISING edge (this pass saw a commit, previous pass did not, and a
	// previous pass actually ran). First-pass detection silently sets
	// the baseline so a fresh restart over an old session that already
	// committed doesn't surface a stale trigger.
	//
	// Subagents never deliver note nudges (gated in postprocess), so
	// skip accumulating orphan trigger state.
	try {
		const sessionMeta = getOrCreateSessionMeta(args.db, args.sessionId);
		if (!sessionMeta.isSubagent) {
			const hasRecentCommit = detectRecentCommit(args.messages);
			const hadPriorCommitState = commitSeenLastPass.has(args.sessionId);
			const sawCommitLastPass = commitSeenLastPass.get(args.sessionId) ?? false;
			if (hadPriorCommitState && hasRecentCommit && !sawCommitLastPass) {
				onNoteTrigger(args.db, args.sessionId, "commit_detected");
			}
			commitSeenLastPass.set(args.sessionId, hasRecentCommit);
		}
	} catch (err) {
		// commit-detect is opportunistic; failure should not break the
		// pipeline. Log and continue.
		sessionLog(
			args.sessionId,
			`commit-detect failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// 2. Apply queued drops from pending_ops. Gated on scheduler decision
	// because materialization mutates tag content, busting provider cache.
	// Mirrors OpenCode's transform-postprocess-phase.ts:184-186 gating:
	// run on execute, force, OR when /ctx-flush has set
	// pendingMaterializationSessions for this session. Hash-change
	// detection in `before_agent_start` also signals this set so a
	// real prompt-content change forces materialization on the same
	// turn the cache already busts.
	//
	// PEEK-then-drain-on-success pattern (Oracle audit Round 8 #6):
	// the signal is only deleted AFTER applyPendingOperations succeeds.
	// If the call throws, the flag survives so the next pass retries.
	//
	// Drops in the protected window are deferred (re-queued) so the
	// agent's recent working context stays intact.
	const hasPendingMaterializeSignal = hasPendingMaterialization(args.sessionId);
	const deferredMaterializationWasPending = deferredMaterializationSessions.has(
		args.sessionId,
	);
	const deferredHistoryRefreshWasPending = deferredHistoryWasPendingAtPassStart;
	const deferredExecuteWasPending =
		peekDeferredExecutePending(args.db, args.sessionId) !== null;
	const pendingOps = getPendingOps(args.db, args.sessionId);
	const baseShouldApplyPendingOps =
		args.schedulerDecision === "execute" ||
		args.forceMaterialization ||
		hasPendingMaterializeSignal ||
		deferredExecuteWasPending;
	const canConsumeDeferredLate =
		baseShouldApplyPendingOps || shouldRunHeuristics;
	const deferredMaterialize =
		canConsumeDeferredLate && deferredMaterializationWasPending;
	const deferredHistoryRefresh =
		canConsumeDeferredLate && deferredHistoryRefreshWasPending;
	const shouldApplyPendingOps =
		baseShouldApplyPendingOps || deferredMaterialize;
	if (shouldApplyPendingOps) {
		const applyReason = hasPendingMaterializeSignal
			? "explicit_flush"
			: deferredExecuteWasPending
				? "deferred_boundary_execute"
				: deferredMaterialize
					? "deferred_publication"
					: args.forceMaterialization
						? "force_materialization"
						: `scheduler_execute (scheduler=${args.schedulerDecision})`;
		sessionLog(
			args.sessionId,
			`pending ops WILL APPLY — reason=${applyReason}, pendingOps=${pendingOps.length}, context=${args.contextUsage.percentage.toFixed(1)}%`,
		);
		try {
			const tApplyPending = performance.now();
			applyPendingOperations(
				args.sessionId,
				args.db,
				targets,
				args.protectedTags,
				undefined,
				pendingOps,
			);
			logTransformTiming(
				args.sessionId,
				"applyPendingOperations",
				tApplyPending,
			);
			executedWorkThisPass = true;
			// Drain only after success — if applyPendingOperations throws
			// the flag stays set so the next pass retries.
			materializationSatisfiedThisPass = true;
			if (hasPendingMaterializeSignal) {
				if (args.heuristics === undefined) {
					consumePendingMaterialization(args.sessionId);
				}
			}
			if (deferredMaterialize) {
				consumeDeferredMaterialization(args.sessionId);
			}
		} catch (err) {
			sessionLog(
				args.sessionId,
				`pending operations failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			throw err;
		}
	} else {
		sessionLog(
			args.sessionId,
			`pending ops WILL NOT APPLY — reason=scheduler_defer pendingOps=${pendingOps.length} context=${args.contextUsage.percentage.toFixed(1)}%`,
		);
	}

	// 3. Apply persistent dropped/truncated tag statuses so cross-pass
	// drops survive. Always runs, regardless of scheduler decision —
	// this is the cache-stable replay of mutations persisted on prior
	// execute passes. Mirrors OpenCode's `applyFlushedStatuses` call
	// at transform.ts:728.
	//
	// P0 perf: applyFlushedStatuses only ever mutates tags whose
	// tag_number is in `targets`, so feed it just that slice instead
	// of the whole session (~50k rows on long sessions). Without this
	// pre-load it lazy-loads via getTagsBySession internally — exactly
	// the full-table scan we eliminated in OpenCode's transform.
	const targetTagNumbers = [...targets.keys()];
	const tGetTags = performance.now();
	const flushedSliceTags = getTagsByNumbers(
		args.db,
		args.sessionId,
		targetTagNumbers,
	);
	logTransformTiming(
		args.sessionId,
		"getTagsByNumbers",
		tGetTags,
		`targets=${targetTagNumbers.length} fetched=${flushedSliceTags.length}`,
	);
	const tFlushed = performance.now();
	applyFlushedStatuses(args.sessionId, args.db, targets, flushedSliceTags);
	logTransformTiming(args.sessionId, "applyFlushedStatuses", tFlushed);
	logTransformTiming(args.sessionId, "batchFinalize:flushed", tFlushed);

	// 3b. Reasoning replay (cache-stable, runs on EVERY pass).
	// Re-applies typed-reasoning [cleared] markers and inline
	// <thinking> stripping for messages whose tag is below the
	// persisted watermark. Pi rebuilds AgentMessage[] from the JSONL
	// on every context event, so without replay the original
	// thinking content would re-appear on defer passes and bust
	// provider prompt cache. Mirrors OpenCode's
	// `replayClearedReasoning` + `replayStrippedInlineThinking`
	// in transform-postprocess-phase.ts.
	const messageIdToMaxTag = buildMessageIdToMaxTag(targets);
	if (args.reasoningClearing) {
		try {
			const tReplayReasoning = performance.now();
			const clearedReplay = replayClearedReasoningPi({
				db: args.db,
				sessionId: args.sessionId,
				messages: workingMessages,
				messageIdToMaxTag,
				piMessageStableId: stableIdResolver,
			});
			const inlineReplay = replayStrippedInlineThinkingPi({
				db: args.db,
				sessionId: args.sessionId,
				messages: workingMessages,
				messageIdToMaxTag,
				piMessageStableId: stableIdResolver,
			});
			if (clearedReplay > 0 || inlineReplay > 0) {
				sessionLog(
					args.sessionId,
					`reasoning replay: cleared=${clearedReplay} inline=${inlineReplay}`,
				);
			}
			logTransformTiming(
				args.sessionId,
				"replayReasoningClearing",
				tReplayReasoning,
			);
			logTransformTiming(
				args.sessionId,
				"stripClearedReasoning",
				tReplayReasoning,
				`strippedParts=${clearedReplay}`,
			);
		} catch (err) {
			sessionLog(
				args.sessionId,
				`reasoning replay failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// 3c. Caveman compression replay (cache-stable, runs on EVERY pass).
	// applyPiHeuristicCleanup persists per-tag caveman_depth on execute
	// passes, but the actual compressed text only lives in memory; on
	// the next defer pass the AgentMessage[] is rebuilt fresh from the
	// JSONL and arrives uncompressed. Without replay, every defer pass
	// after a caveman pass would bust the provider cache prefix because
	// the compressed text vanishes and reverts to the original.
	//
	// Mirrors OpenCode's `replayCavemanCompression` call in
	// transform.ts:793. Idempotent — `cavemanCompress(originalText, level)`
	// is deterministic, so replay produces the exact text the original
	// execute pass produced, regardless of how many times it runs.
	try {
		// P0 perf: caveman replay only acts on tags whose tag_number is in
		// `targets`, so fetch just that slice instead of the whole session
		// (~50k rows on long sessions).
		const tags = getTagsByNumbers(args.db, args.sessionId, targetTagNumbers);
		const replayed = replayCavemanCompression(
			args.sessionId,
			args.db,
			targets,
			tags,
		);
		if (replayed > 0) {
			sessionLog(
				args.sessionId,
				`caveman replay: ${replayed} tags re-compressed from source`,
			);
		}
	} catch (err) {
		sessionLog(
			args.sessionId,
			`caveman replay failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// 3d. Cleanup stages NOT applicable to Pi (intentionally omitted):
	//
	// - stripStructuralNoise: removes OpenCode AI-SDK-specific part
	//   types (step-start, step-finish, meta, reasoning shells). Pi's
	//   AgentMessage shape doesn't have these — only text, toolCall,
	//   toolResult, thinking, image — so there's nothing to strip.
	//
	// - stripReasoningFromMergedAssistants: handles a quirk of the
	//   Vercel AI SDK where two consecutive assistant messages with
	//   reasoning parts get merged before send. Pi's send path doesn't
	//   merge messages this way, so the workaround isn't needed.
	//
	// - stripProcessedImages: replaces large base64 image payloads in
	//   user `file` parts with sentinels after the assistant has
	//   processed them. Pi's image part shape is different (kind:
	//   "image" with a URL) and large base64 images are rare in Pi
	//   sessions — the equivalent path here would only fire for the
	//   pasted-screenshot case, which we don't currently optimize.
	//   Can be added later with a Pi-specific image-content stripper.

	// 4. Heuristic cleanup — drops aged tools, dedups, strips system
	// injections, age-tier caveman compression. Gated on scheduler
	// decision because mutations bust provider cache; persisted to DB
	// so subsequent defer passes replay via applyFlushedStatuses.
	// Mirrors OpenCode's `applyHeuristicCleanup` call in
	// transform-postprocess-phase.ts.
	let heuristicsExecuted = false;
	let heuristicsResult: PiHeuristicCleanupResult | null = null;
	const tActiveTags = performance.now();
	const activeTags = getActiveTagsBySession(args.db, args.sessionId);
	logTransformTiming(
		args.sessionId,
		"getActiveTagsBySession",
		tActiveTags,
		`count=${activeTags.length}`,
	);
	if (shouldRunHeuristics) {
		const reason = args.forceMaterialization
			? "force_materialization"
			: `scheduler_execute (pendingOps=${pendingOps.length}, scheduler=${args.schedulerDecision})`;
		sessionLog(
			args.sessionId,
			`heuristics WILL RUN — reason=${reason}, context=${args.contextUsage.percentage.toFixed(1)}%, turn=n/a`,
		);
	} else {
		const reason =
			args.heuristics === undefined ? "disabled" : "scheduler_defer";
		sessionLog(args.sessionId, `heuristics WILL NOT RUN — reason=${reason}`);
	}
	if (shouldRunHeuristics && args.heuristics) {
		try {
			const tHeuristic = performance.now();
			heuristicsResult = applyPiHeuristicCleanup(
				args.sessionId,
				args.db,
				targets,
				args.messages,
				{
					autoDropToolAge: args.heuristics.autoDropToolAge,
					dropToolStructure: args.heuristics.dropToolStructure,
					protectedTags: args.protectedTags,
					dropAllTools: args.forceMaterialization === true,
					caveman: args.heuristics.caveman,
				},
				activeTags,
				stableIdResolver,
			);
			heuristicsExecuted = true;
			executedWorkThisPass = true;
			if (hasPendingMaterializeSignal) {
				consumePendingMaterialization(args.sessionId);
			}
			if (currentTurnId !== null) {
				lastHeuristicsTurnIdBySession.set(args.sessionId, currentTurnId);
			}
			logTransformTiming(
				args.sessionId,
				"applyHeuristicCleanup",
				tHeuristic,
				`droppedTools=${heuristicsResult.droppedTools} deduplicatedTools=${heuristicsResult.deduplicatedTools} droppedInjections=${heuristicsResult.droppedInjections} compressedTextTags=${heuristicsResult.compressedTextTags}`,
			);
		} catch (err) {
			sessionLog(
				args.sessionId,
				`heuristic cleanup failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// 4b. Reasoning clearing on EXECUTE passes only (cache-busting).
	// Walks Pi assistant messages whose tag number is older than
	// `clearReasoningAge` from the newest tag and replaces typed
	// PiThinkingContent.thinking with `[cleared]`. Persists the
	// max-tag-cleared watermark so subsequent defer passes replay
	// the same set via the cache-stable replay above. Mirrors
	// OpenCode's `clearOldReasoning` (strip-content.ts) gated to
	// execute passes via the same scheduler decision used for
	// heuristic cleanup.
	// Gate reasoning clearing on the SAME signal as heuristic drops
	// (shouldRunHeuristics), not the narrower execute||forceMaterialization.
	// OpenCode runs clearOldReasoning inside its shouldRunHeuristics block, so
	// the reasoning-watermark advance rides the exact same cache-busting passes
	// as the tool drops. The old gate skipped reasoning on pending/deferred-
	// materialization passes where heuristics DO run — leaving reasoning on the
	// wire on a pass that already dropped tools (inconsistent + a missed
	// same-pass mutation). shouldRunHeuristics is the broader, correct set.
	if (args.reasoningClearing && shouldRunHeuristics) {
		try {
			const tClearReasoning = performance.now();
			const meta = getOrCreateSessionMeta(args.db, args.sessionId);
			const prevWatermark = meta.clearedReasoningThroughTag ?? 0;
			const clearOutcome = clearOldReasoningPi({
				messages: workingMessages,
				messageIdToMaxTag,
				clearReasoningAge: args.reasoningClearing.clearReasoningAge,
				piMessageStableId: stableIdResolver,
			});
			const stripOutcome = stripInlineThinkingPi({
				messages: workingMessages,
				messageIdToMaxTag,
				clearReasoningAge: args.reasoningClearing.clearReasoningAge,
				piMessageStableId: stableIdResolver,
			});
			const combinedWatermark = Math.max(
				clearOutcome.newWatermark,
				stripOutcome.newWatermark,
			);
			if (combinedWatermark > prevWatermark) {
				updateSessionMeta(args.db, args.sessionId, {
					clearedReasoningThroughTag: combinedWatermark,
				});
				sessionLog(
					args.sessionId,
					`reasoning cleanup: cleared=${clearOutcome.cleared} inlineStripped=${stripOutcome.stripped} watermark=${prevWatermark}→${combinedWatermark}`,
				);
			}
			logTransformTiming(args.sessionId, "clearOldReasoning", tClearReasoning);
			logTransformTiming(args.sessionId, "watermarkCleanup", tClearReasoning);
			if (
				combinedWatermark > prevWatermark ||
				clearOutcome.cleared > 0 ||
				stripOutcome.stripped > 0
			) {
				executedWorkThisPass = true;
			}
		} catch (err) {
			sessionLog(
				args.sessionId,
				`reasoning clearing failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// 5. Commit tagging mutations back to Pi messages BEFORE injecting
	// the history block. Otherwise the injection write target is the
	// pre-tagged content. Pi's transcript adapter writes mutations
	// back to the underlying AgentMessage[] via the part proxies, so
	// commit() just locks the result in.
	transcript.commit();

	// Two post-commit stable-id maps, both keyed by AgentMessage object identity.
	// Built AFTER commit() — commit reassigns args.messages[idx] = working[idx]
	// (cloned objects for dirty messages), so a map built BEFORE the pipeline (the
	// pass-start `entryIdByRef`) keys the PRE-commit objects and misses every
	// cloned message. Built BEFORE injectM0M1Pi — injection splices/unshifts the
	// array, after which positional entryIds[index] is stale; object identity
	// survives both the clone and the splice, so a ref-keyed map resolves correctly
	// for consumers that run AFTER the pipeline mutates the array. There is NO
	// structural splice between pass start and here (only commit's in-place
	// reassignment), so positional entryIds[i] is still authoritative at build time.
	//
	// Two maps because the consumers have DIFFERENT identity contracts:
	//   1. postCommitStableIdByRef (FULL fallback via resolvePiStableId, incl.
	//      pi-msg-* index ids) — for stripPiDroppedPlaceholderMessages, which needs
	//      a stable id for EVERY message (skip-on-miss + legacy path).
	//   2. postCommitEntryIdByRef (REAL SessionEntry ids ONLY, no pi-msg-* fallback)
	//      — for sticky reminder / note nudges / auto-search. These must fall to
	//      their degraded path (entryIds === null) when branch resolution failed;
	//      a pi-msg-* fallback id would defeat that and anchor to an unstable id.
	// The only legitimate misses are injection's synthetic m[0]/m[1] prepends,
	// which carry no SessionEntry id and must not be anchored.
	const postCommitStableIdByRef = new Map<object, string>();
	const postCommitEntryIdByRef = new Map<object, string>();
	for (let i = 0; i < args.messages.length; i++) {
		const m = args.messages[i];
		if (!m || typeof m !== "object") continue;
		const id = resolvePiStableId(
			m,
			i,
			args.entryIds,
			args.entryIdByRef ?? undefined,
		);
		if (id) postCommitStableIdByRef.set(m as object, id);
		// Real-only: positional entryIds[i] is a real SessionEntry id or undefined
		// (never pi-msg-*). Authoritative here because nothing has spliced yet.
		const realId = args.entryIds?.[i];
		if (typeof realId === "string" && realId.length > 0) {
			postCommitEntryIdByRef.set(m as object, realId);
		}
	}

	// 6. <session-history> injection — writes compartments, facts, and
	// project memories into message[0]. This is the second-biggest
	// reduction lever after heuristic cleanup: a session that's been
	// summarized has its bulk history replaced by a compact compartment
	// block. Mirrors OpenCode's prepareCompartmentInjection +
	// renderCompartmentInjection pair (transform.ts:587-616 + ~960).
	let injectionResult: PiInjectionResult | null = null;
	if (args.injection) {
		try {
			const tInjection = performance.now();
			// NOTE: do NOT clear the m[0]/m[1] cache on a cache-busting pass. A new
			// compartment is an m[1] DELTA (SOFT), not an m[0] re-materialization
			// (HARD) — clearing forced mustMaterializePi to first_render and folded
			// m[0] every history-refresh pass, defeating the whole m[0]/m[1] split
			// (parity with the OpenCode max_compartment_seq removal). injectM0M1Pi
			// now keeps cached m[0] and soft-refreshes m[1] with the new compartment;
			// HARD triggers (model/system/ttl/epoch/docs/upgrade/mutation) still
			// re-materialize inside mustMaterializePi when genuinely needed.
			// HARD-bust signals (parity with OpenCode). systemHash + TTL idle derive
			// from the freshly-read session_meta; modelKey from the volatile live
			// map. Pi has no tool.definition hook, so toolSetHash is always "" — its
			// mustMaterializePi branch is inert (see PARITY.md).
			const hardMeta = getOrCreateSessionMeta(args.db, args.sessionId);
			let piTtlMs = 5 * 60 * 1000;
			try {
				piTtlMs = parseCacheTtl(hardMeta.cacheTtl);
			} catch {
				// invalid cache_ttl → 5m default (parity with execute-status)
			}
			const piHardSignals = {
				systemHash:
					typeof hardMeta.systemPromptHash === "string"
						? hardMeta.systemPromptHash
						: "",
				toolSetHash: "",
				modelKey: liveModelBySession.get(args.sessionId) ?? "",
				cacheExpired:
					hardMeta.lastResponseTime > 0 &&
					Date.now() - hardMeta.lastResponseTime >= piTtlMs,
				lastResponseTime: hardMeta.lastResponseTime,
			};
			injectionResult = injectM0M1Pi(
				{
					sessionId: args.sessionId,
					projectIdentity: args.projectIdentity,
					projectDirectory: args.projectDirectory,
					injectionBudgetTokens: args.injection.injectionBudgetTokens,
					historyBudgetTokens: args.injection.historyBudgetTokens,
					keyFilesEnabled: args.injection.keyFilesEnabled,
					keyFilesTokenBudget: args.injection.keyFilesTokenBudget,
					hardSignals: piHardSignals,
				},
				args.db,
				args.messages as Parameters<typeof injectM0M1Pi>[2],
				args.entryIds,
				// recomputeM1ThisPass: recompute m[1] (vs byte-identical replay) on any
				// cache-busting pass — history refresh (new compartment published),
				// deferred history refresh, OR executed work (drops/heuristics). A
				// history-refresh-only pass has executedWorkThisPass=false but MUST
				// re-render m[1] so the new compartment surfaces; gating on work alone
				// (the prior behavior, masked by the now-removed cache clear) would
				// replay stale m[1]. Mirrors OpenCode's isCacheBustingPass gate.
				args.isCacheBusting || deferredHistoryRefresh || executedWorkThisPass,
			);
			// PEEK-then-drain-on-success (Oracle audit Round 8 #6):
			// only drain `historyRefreshSessions` if the rebuild
			// succeeded AND this pass was busting the cache. If
			// injection throws, the flag survives so the next pass
			// retries the rebuild. Deferred-history is NOT drained
			// here; Pi-native compaction marker application happens at
			// the end of runPipeline after materializing work succeeds.
			if (args.isCacheBusting) {
				historyRefreshSessions.delete(args.sessionId);
				historyWasConsumedThisPass = true;
			}
			if (deferredHistoryRefresh) {
				historyWasConsumedThisPass = true;
			}
			logTransformTiming(
				args.sessionId,
				"prepareCompartmentInjection",
				tInjection,
			);
			logTransformTiming(args.sessionId, "compartmentPhase", tInjection);
		} catch (err) {
			sessionLog(
				args.sessionId,
				`compartment injection failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	stripPiDroppedPlaceholderMessages({
		db: args.db,
		sessionId: args.sessionId,
		messages: args.messages,
		// Discovery is gated to history-refresh passes ONLY (args.isCacheBusting) —
		// deliberately NARROWER than OpenCode's `shouldApplyPendingOps ||
		// shouldRunHeuristics`. The two harnesses diverge in strip SEMANTICS:
		// OpenCode NEUTRALIZES a placeholder-only message in place (replaces parts
		// with an empty sentinel, message stays in the array), so discovering on a
		// fresh-drop execute pass is harmless. Pi REMOVES (splices) the message.
		// A freshly-dropped tool stub renders as `[dropped §N§]`, which
		// isDroppedOnlyText matches — so discovering on the same execute pass that
		// created it would splice out the just-dropped turn and collapse it. We
		// therefore discover only at history-refresh boundaries (where the array is
		// rebuilt anyway); a stub created on a drop-only execute pass is tiny and
		// gets discovered on the next refresh pass. Replay still runs every pass.
		isCacheBusting: args.isCacheBusting,
		stableIdByRef: postCommitStableIdByRef,
		// F4 cutover: when the stable-id scheme just changed, force rediscovery so
		// previously-stripped placeholders get re-keyed under the new scheme this
		// pass (discovery is otherwise gated on isCacheBusting = history-refresh).
		forceDiscovery: args.stableIdSchemeCutover === true,
	});

	// Drain predicate intentionally has two Pi-specific terms beyond OpenCode's
	// `historyWasConsumedThisPass && deferredHistoryWasPendingAtPassStart &&
	// !suppress`:
	//   • `materializationSatisfiedThisPass` — Pi's m[0]/m[1] materialization is
	//     a separate signal from history consumption; the deferred-history
	//     one-shot must not drain until materialization actually landed this pass,
	//     or the next pass would rebuild against a half-applied snapshot.
	//   • `|| hasPendingMaterializeSignal` — Pi rebuilds a fresh AgentMessage[]
	//     per `context` event (no persistent transform array), so a pending
	//     materialize signal that arrived mid-pass is an equally valid drain
	//     trigger as a pass-start-pending refresh.
	// Net effect is signal-equivalent to OpenCode's model for the same
	// scheduler/materialization input (Oracle Round 8 peek-then-drain).
	const deferredHistoryDrainEligible =
		historyWasConsumedThisPass &&
		materializationSatisfiedThisPass &&
		(deferredHistoryWasPendingAtPassStart || hasPendingMaterializeSignal) &&
		!suppressDeferredHistoryDrain &&
		!casLost;
	if (deferredHistoryDrainEligible) {
		try {
			const pending = getPendingPiCompactionMarkerState(
				args.db,
				args.sessionId,
			);
			if (!pending) {
				consumeDeferredHistoryRefresh(args.sessionId);
			} else if (!args.appendCompaction || !args.readBranchEntries) {
				suppressDeferredHistoryDrain = true;
				sessionLog(
					args.sessionId,
					"Pi compaction-marker drain skipped: sessionManager appendCompaction/getBranch unavailable; preserving deferred-history signal",
				);
			} else {
				const outcome = applyDeferredPiCompactionMarker(
					{
						db: args.db,
						appendCompaction: args.appendCompaction,
						readBranchEntries: args.readBranchEntries,
					},
					args.sessionId,
					pending,
				);
				if (outcome.kind === "retryable-failure") {
					sessionLog(
						args.sessionId,
						`Pi compaction-marker drain retryable failure: ${outcome.error.message}`,
					);
				} else if (
					clearPendingPiCompactionMarkerStateIf(
						args.db,
						args.sessionId,
						pending,
					)
				) {
					consumeDeferredHistoryRefresh(args.sessionId);
				} else {
					casLost = true;
					sessionLog(
						args.sessionId,
						"CAS-clear failed (newer blob written or another actor cleared); preserving deferred-history signal",
					);
				}
			}
		} catch (err) {
			sessionLog(
				args.sessionId,
				`Pi compaction-marker drain failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	if (executedWorkThisPass) {
		try {
			const currentFlag = peekDeferredExecutePending(args.db, args.sessionId);
			if (currentFlag !== null) {
				clearDeferredExecutePendingIfMatches(
					args.db,
					args.sessionId,
					currentFlag,
				);
			}
		} catch (err) {
			sessionLog(
				args.sessionId,
				`[boundary-exec] drain failed (continuing): ${err}`,
			);
		}
	}
	logTransformTiming(
		args.sessionId,
		"batchFinalize:heuristics",
		performance.now(),
	);

	const outputMessages = transcript.getOutputMessages();

	// 7. Persist conversation/tool-call token totals for /ctx-status and
	// the dashboard. Walks the post-everything message array (tagged,
	// injected, stripped) so the numbers reflect what the LLM actually
	// receives. Mirrors OpenCode's transform.ts:996-1127. Best-effort —
	// never fail the pipeline on a stats write error.
	try {
		const counts = tokenizePiMessages(outputMessages as unknown[]);
		updateSessionMeta(args.db, args.sessionId, {
			conversationTokens: counts.conversation,
			toolCallTokens: counts.toolCall,
		});
	} catch (err) {
		sessionLog(
			args.sessionId,
			`token accounting failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return {
		messages: outputMessages,
		heuristicsExecuted,
		executedWorkThisPass,
		historyInjected: injectionResult?.injected ?? false,
		syntheticLeadingCount: injectionResult?.syntheticLeadingCount ?? 0,
		heuristicsResult,
		injectionResult,
		targetCount: targets.size,
		reasoningWatermark:
			getOrCreateSessionMeta(args.db, args.sessionId)
				.clearedReasoningThroughTag ?? 0,
		activeTags,
		postCommitEntryIdByRef,
	};
}

// ---------------------------------------------------------------------------
// Nudge / note-nudge helpers
// ---------------------------------------------------------------------------

/**
 * Apply the rolling/iteration nudge after tagging. Mirrors OpenCode's
 * `transform-postprocess-phase.ts` (around lines 568-604) — but for Pi
 * there is no anchored-assistant cache, so we use the simpler
 * insert-before-latest-user strategy from `injectPiNudge`.
 *
 * Pi delivers a fresh `AgentMessage[]` per `context` event, so every
 * pass behaves like an OpenCode "cache-busting" pass: nudges always
 * apply when the nudger says so, and there is no defer-pass replay or
 * anchor retirement to manage.
 */
function applyRollingNudge(args: {
	sessionId: string;
	db: ContextDatabase;
	messages: PiAgentMessage[];
	ctx: ExtensionContext;
	nudgerFn: ReturnType<typeof createNudger>;
}): PiAgentMessage[] {
	const { sessionId, db, messages, ctx, nudgerFn } = args;

	const piUsage = ctx.getContextUsage?.();
	if (
		!piUsage ||
		piUsage.tokens === null ||
		piUsage.percent === null ||
		piUsage.contextWindow === 0
	) {
		// No usage info yet — nudger requires real numbers, so skip.
		return messages;
	}

	const usage = {
		percentage: piUsage.percent,
		inputTokens: piUsage.tokens,
		// Nudger's ContextUsage type carries a contextLimit too; pass it
		// for completeness even though the rolling-nudge math doesn't
		// consume it directly.
		contextLimit: piUsage.contextWindow,
	};

	// P0 perf: nudger filters to status === "active" anyway, so feed it
	// active-only directly. Saves a full-table scan on long sessions.
	const tags = getActiveTagsBySession(db, sessionId);
	const messagesSinceLastUser = countMessagesSinceLastUserPi(messages);

	const nudge = nudgerFn(
		sessionId,
		usage,
		db,
		getTopNBySize,
		tags,
		messagesSinceLastUser,
		// Let the nudger fetch session meta itself — Pi doesn't have the
		// preloaded-meta optimization the OpenCode transform uses.
		undefined,
	);
	if (!nudge) return messages;

	return injectPiNudge(messages, nudge);
}

function applyStickyTurnReminder(args: {
	sessionId: string;
	db: ContextDatabase;
	messages: PiAgentMessage[];
	entryIds: readonly (string | undefined)[] | null;
	/**
	 * Splice-safe message→entryId map keyed by AgentMessage reference. Resolved
	 * against branch entries; correct even though `messages` was spliced since
	 * the positional `entryIds` was computed. Takes precedence over `entryIds`.
	 */
	entryIdByRef?: ReadonlyMap<object, string> | null;
	hasRecentReduceCall: boolean;
	isCacheBustingPass: boolean;
	/**
	 * Count of synthetic id-less messages injection prepended (m[0]/m[1] pair).
	 * Excluded from the `allResolved` denominator — they never resolve to a real
	 * entry id, so without this every injected pass would have allResolved=false
	 * and pruning would never run.
	 */
	syntheticLeadingCount?: number;
}): PiAgentMessage[] {
	const reminder = getPersistedStickyTurnReminder(args.db, args.sessionId);
	if (!reminder) return args.messages;

	if (args.hasRecentReduceCall && args.isCacheBustingPass) {
		clearPersistedStickyTurnReminder(args.db, args.sessionId);
		return args.messages;
	}

	const messageIdByIndex = buildPiMessageIdByIndex(
		args.messages,
		args.entryIds,
		false,
		args.entryIdByRef,
	);
	// Reference-resolved set of entry ids actually present in the CURRENT
	// (post-splice) messages — used to decide whether the anchored reminder
	// message is still visible, instead of the stale positional `entryIds`.
	const visibleResolvedIds = new Set<string>(messageIdByIndex.values());
	// "All REAL messages resolved" — exclude injection's synthetic id-less
	// m[0]/m[1] prepends from the denominator. Those never resolve, so comparing
	// against the raw length would leave allResolved permanently false on every
	// injected pass and disable the guard's prune entirely.
	const realMessageCount = Math.max(
		0,
		args.messages.length - (args.syntheticLeadingCount ?? 0),
	);
	const allResolved = messageIdByIndex.size === realMessageCount;
	if (reminder.messageId) {
		const reinjected = appendReminderToUserMessageByIdPi(
			args.messages,
			messageIdByIndex,
			reminder.messageId,
			reminder.text,
		);
		if (
			!reinjected &&
			args.isCacheBustingPass &&
			allResolved &&
			!visibleResolvedIds.has(reminder.messageId)
		) {
			clearPersistedStickyTurnReminder(args.db, args.sessionId);
		}
		return args.messages;
	}

	if (args.entryIds === null) {
		sessionLog(
			args.sessionId,
			"Pi sticky turn reminder: strict resolution failed; replay-only until next pass",
		);
		return args.messages;
	}

	const latest = findLatestUserMessageIdPi(args.messages, messageIdByIndex);
	if (latest) {
		appendReminderToPiUserMessage(args.messages[latest.index], reminder.text);
		setPersistedStickyTurnReminder(
			args.db,
			args.sessionId,
			reminder.text,
			latest.messageId,
		);
	}
	return args.messages;
}

/**
 * Apply note-nudge replay + delivery. Mirrors OpenCode's
 * `transform-postprocess-phase.ts` (around lines 611-650).
 *
 * Two paths:
 *   1. Sticky replay: a previously-delivered nudge anchored to a user
 *      message id replays into that same message every pass (idempotent
 *      because `appendReminderToUserMessageById` checks for the exact
 *      reminder text before appending).
 *   2. Fresh delivery: when a note trigger has fired since the last
 *      delivery and the agent hasn't already read the note state,
 *      append a `<instruction name="deferred_notes">…` block to the
 *      latest user message and mark delivered.
 *
 * Both paths fail-open: if no eligible user message exists, the call
 * simply returns the messages unchanged.
 */
function applyNoteNudges(args: {
	sessionId: string;
	db: ContextDatabase;
	messages: PiAgentMessage[];
	projectIdentity: string;
	entryIds: readonly (string | undefined)[] | null;
	/**
	 * Splice-safe message→entryId map keyed by AgentMessage reference. Resolved
	 * against branch entries and correct even though `messages` was spliced since
	 * `entryIds` (positional) was computed. Takes precedence over `entryIds`.
	 */
	entryIdByRef?: ReadonlyMap<object, string> | null;
	/**
	 * Whether THIS pass is cache-busting. Sticky-anchor pruning is storage-only
	 * and must run ONLY on cache-busting passes (parity with OpenCode
	 * transform-postprocess `args.fullFeatureMode && isCacheBustingPass`). On a
	 * defer pass the persisted sticky state must not change, or future replay
	 * bytes could shift and bust the prompt cache.
	 */
	isCacheBusting: boolean;
	/**
	 * Count of ALL id-less synthetic messages present in `messages` — the
	 * m[0]/m[1] prepends plus the rolling-nudge synthetic if it fired this pass.
	 * Excluded from the anchor-GC `allResolved` denominator (see below) since none
	 * of them resolve to a real entry id. Position is irrelevant; only the count
	 * matters for the denominator.
	 */
	syntheticLeadingCount?: number;
}): PiAgentMessage[] {
	const { sessionId, db, messages, projectIdentity, entryIds, entryIdByRef } =
		args;

	const messageIdByIndex = buildPiMessageIdByIndex(
		messages,
		entryIds,
		false,
		entryIdByRef,
	);
	const replayMessageIdByIndex = buildPiMessageIdByIndex(
		messages,
		entryIds,
		true,
		entryIdByRef,
	);

	for (const anchor of getNoteNudgeAnchors(db, sessionId)) {
		appendReminderToUserMessageByIdPi(
			messages,
			replayMessageIdByIndex,
			anchor.messageId,
			anchor.text,
		);
	}
	for (const decision of getAutoSearchHintDecisions(db, sessionId)) {
		if (decision.decision === "hint") {
			appendReminderToUserMessageByIdPi(
				messages,
				replayMessageIdByIndex,
				decision.messageId,
				decision.text,
			);
		}
	}

	// Path 2: fresh delivery. Use the latest user message id (or null if
	// no user messages yet) as the trigger-message hint to peekNoteNudgeText.
	//
	// Visibility-aware suppression: peekNoteNudgeText suppresses the
	// nudge when the agent already ran ctx_note(read) since the latest
	// note activity AND that read is still visible in the current
	// message context. Once the read has aged out / been dropped, we
	// re-surface the nudge at the next work-boundary trigger so the
	// agent regains visibility into deferred intentions. Mirrors
	// OpenCode's transform-postprocess-phase.ts:647 wiring.
	const latestUser = findLatestUserMessageIdPi(messages, messageIdByIndex);
	const latestUserId = latestUser?.messageId ?? null;
	const noteReadStillVisible = hasVisibleNoteReadCallPi(messages);
	const deferredNoteText = peekNoteNudgeText(
		db,
		sessionId,
		latestUserId,
		projectIdentity,
		noteReadStillVisible,
	);
	if (deferredNoteText) {
		if (entryIds === null) {
			sessionLog(
				sessionId,
				"Pi note-nudge: strict resolution failed; deferring delivery to next pass",
			);
			return messages;
		}
		const noteInstruction = `\n\n<instruction name="deferred_notes">${deferredNoteText}</instruction>`;
		const anchoredId = latestUser?.messageId ?? null;
		if (!anchoredId) {
			sessionLog(
				sessionId,
				"Pi note-nudge: latest user message has no resolved SessionEntry id; deferring delivery to next pass",
			);
			return messages;
		}
		const outcome = markNoteNudgeDelivered(
			db,
			sessionId,
			noteInstruction,
			anchoredId,
		);
		if (latestUser && outcome.ok) {
			appendReminderToPiUserMessage(
				messages[latestUser.index] as PiAgentMessage,
				noteInstruction,
			);
		} else if (!outcome.ok) {
			sessionLog(
				sessionId,
				`Pi note-nudge delivery skipped wire append: ${outcome.kind}`,
			);
		}
	}

	// Storage-only GC of stale sticky anchors — gated on cache-busting passes
	// ONLY (parity with OpenCode). Pruning on a defer pass would mutate persisted
	// sticky-injection state and could shift future replay bytes.
	//
	// The visible set MUST reflect the CURRENT (post-splice) messages, not the
	// stale positional `entryIds`: pruning against pre-splice positions could
	// drop an anchor whose message is still present (just shifted) and therefore
	// erase a still-needed replay. We derive it from `messageIdByIndex`, which is
	// reference-resolved against the current array. Only prune when every current
	// message resolved to a real id (a partial map could miss a present message
	// and wrongly prune its anchor).
	if (args.isCacheBusting) {
		const visibleIds = new Set<string>(messageIdByIndex.values());
		// "All REAL messages resolved" — exclude injection's synthetic id-less
		// m[0]/m[1] prepends from the denominator (they never resolve to a real
		// entry id). Without this, allResolved is permanently false on every
		// injected pass and the prune never runs → unbounded anchor growth.
		const realMessageCount = Math.max(
			0,
			messages.length - (args.syntheticLeadingCount ?? 0),
		);
		const allResolved = messageIdByIndex.size === realMessageCount;
		if (allResolved && visibleIds.size > 0) {
			pruneNoteNudgeAnchors(db, sessionId, visibleIds);
			pruneAutoSearchHintDecisions(db, sessionId, visibleIds);
		}
	}

	return messages;
}

/**
 * Count messages since the latest meaningful user message. "Meaningful"
 * here means a `user` role with non-empty text content. Mirrors
 * `countMessagesSinceLastUser` from
 * `packages/plugin/src/hooks/magic-context/transform-message-helpers.ts`,
 * adapted to the Pi `AgentMessage` shape.
 */
function countMessagesSinceLastUserPi(messages: PiAgentMessage[]): number {
	let count = 0;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg?.role === "user" && hasMeaningfulUserTextPi(msg)) break;
		count += 1;
	}
	return count;
}

/** Returns true when the message is a user role with non-empty text content. */
function hasMeaningfulUserTextPi(message: PiAgentMessage): boolean {
	if (message.role !== "user") return false;
	const content = (message as { content: unknown }).content;
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	for (const part of content as Array<{ type?: unknown; text?: unknown }>) {
		if (
			part &&
			part.type === "text" &&
			typeof part.text === "string" &&
			part.text.trim().length > 0
		) {
			return true;
		}
	}
	return false;
}

type PiMessageIdByIndex = Map<number, string>;

/**
 * Build an index→entryId map for the CURRENT `messages` array.
 *
 * # Why a per-call rebuild keyed by reference, not a frozen positional array
 *
 * `strictEntryIds` is a positional array resolved against the ORIGINAL
 * `event.messages` at pass start. `runPipeline` then structurally mutates the
 * array in place — compartment-boundary trim and `stripPiDroppedPlaceholderMessages`
 * both `splice()` messages out, shifting every later index. Any consumer that
 * runs AFTER those splices (sticky reminders, note nudges, auto-search hints)
 * must NOT index the stale positional `strictEntryIds[]` against the shifted
 * array — index N no longer points at the same message, so anchors would resolve
 * to the wrong SessionEntry id and replay/prune on the wrong message (the Pi
 * analogue of the #81 positional-drift class).
 *
 * Reference identity survives splices (splicing changes positions, not object
 * identity). When `entryIdByRef` is supplied, each CURRENT message is resolved
 * through it by identity, so the map is correct regardless of how many splices
 * happened. The positional `entryIds` path is kept for pre-mutation callers
 * (those that legitimately align to the original `event.messages`).
 */
function buildPiMessageIdByIndex(
	messages: PiAgentMessage[],
	entryIds: readonly (string | undefined)[] | null,
	includeMessageIdFallback = false,
	entryIdByRef?: ReadonlyMap<object, string> | null,
): PiMessageIdByIndex {
	const ids = new Map<number, string>();
	for (let index = 0; index < messages.length; index += 1) {
		// Reference-identity resolution takes precedence: correct even after the
		// array was spliced since strictEntryIds was computed.
		if (entryIdByRef) {
			const msg = messages[index];
			const byRef =
				msg && typeof msg === "object"
					? entryIdByRef.get(msg as object)
					: undefined;
			if (typeof byRef === "string") {
				ids.set(index, byRef);
				continue;
			}
			// CRITICAL: when a ref-map is supplied, a MISS must NOT fall back to
			// positional `entryIds[index]`. The ref-map is built against the
			// CURRENT (post-commit/post-splice) array; `entryIds` is the stale
			// pass-start positional array, so after a splice index N no longer
			// points at the same message and the positional id would anchor the
			// WRONG message. The only legitimate ref-map misses are injection's
			// synthetic m[0]/m[1] prepends and commit-cloned messages with no real
			// SessionEntry id — both must resolve to "unmapped" so the consumer
			// degrades safely (replay-only / no fresh anchor) rather than mis-anchor.
			// The own-`.id` fallback below IS splice-safe (reads the current
			// object's own id, not a positional lookup) so it stays for replay
			// callers (includeMessageIdFallback=true).
			if (includeMessageIdFallback) {
				const messageId = (messages[index] as { id?: unknown } | undefined)?.id;
				if (typeof messageId === "string") {
					ids.set(index, messageId);
				}
			}
			continue;
		}
		// No ref-map (pre-mutation callers that legitimately align to the original
		// event.messages): positional entryIds is authoritative.
		const entryId = entryIds?.[index];
		if (typeof entryId === "string") {
			ids.set(index, entryId);
			continue;
		}
		if (includeMessageIdFallback) {
			const messageId = (messages[index] as { id?: unknown } | undefined)?.id;
			if (typeof messageId === "string") {
				ids.set(index, messageId);
			}
		}
		// Fresh anchors deliberately do not use AgentMessage.id: Pi's context
		// messages may carry transient wrapper ids that are not SessionEntry ids.
		// Existing anchors may still replay through that fallback for backward
		// compatibility when includeMessageIdFallback=true.
	}
	return ids;
}

function findLatestUserMessageIdPi(
	messages: PiAgentMessage[],
	messageIdByIndex: PiMessageIdByIndex,
): { index: number; messageId: string } | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg?.role !== "user" || !hasMeaningfulUserTextPi(msg)) continue;
		const messageId = messageIdByIndex.get(i);
		if (typeof messageId === "string") {
			return { index: i, messageId };
		}
	}
	return null;
}

/**
 * Append `reminder` to the user message at `messageId`. Idempotent: skips if
 * the exact reminder text is already present. Mirrors
 * `appendReminderToUserMessageById` from OpenCode's
 * `transform-message-helpers.ts:54`.
 */
function appendReminderToUserMessageByIdPi(
	messages: PiAgentMessage[],
	messageIdByIndex: PiMessageIdByIndex,
	messageId: string,
	reminder: string,
): boolean {
	for (let i = 0; i < messages.length; i += 1) {
		const msg = messages[i];
		if (msg?.role !== "user" || !hasMeaningfulUserTextPi(msg)) continue;
		if (messageIdByIndex.get(i) !== messageId) continue;
		appendReminderToPiUserMessage(msg, reminder);
		return true;
	}
	return false;
}

/**
 * Append text to a user message, preserving its existing content shape:
 *   - `string`: direct concat (Pi accepts string user content).
 *   - array: append to the first text block, or push a new text block
 *     when the message is image-only.
 *
 * Idempotent — skips when the reminder is already present.
 */
function appendReminderToPiUserMessage(
	message: PiAgentMessage,
	reminder: string,
): void {
	// Only `user` messages carry a string-or-array content shape we can
	// safely append to. Other roles (toolResult, custom, bashExecution)
	// don't get nudge text.
	if (message.role !== "user") return;
	const userMsg = message as { content: unknown };

	if (typeof userMsg.content === "string") {
		if (!userMsg.content.includes(reminder)) {
			userMsg.content = userMsg.content + reminder;
		}
		return;
	}
	if (!Array.isArray(userMsg.content)) return;

	const contentArr = userMsg.content as Array<{
		type?: unknown;
		text?: unknown;
	}>;
	for (let i = 0; i < contentArr.length; i += 1) {
		const part = contentArr[i];
		if (
			part &&
			part.type === "text" &&
			typeof (part as { text?: string }).text === "string"
		) {
			const text = (part as { text: string }).text;
			if (!text.includes(reminder)) {
				(part as { text: string }).text = text + reminder;
			}
			return;
		}
	}
	// Image-only or empty array — push a new text block. Trim leading
	// `\n\n` because there's nothing to separate from.
	contentArr.push({ type: "text", text: reminder.trimStart() });
}

/**
 * Per-session cleanup. Pi has no `session_deleted` event, but it does
 * fire `session_before_switch` when the user switches to a different
 * session within the same Pi process, and `session_shutdown` when the
 * process exits. Both are valid moments to drain caches keyed by the
 * outgoing session id so we don't leak unbounded memory across many
 * session switches in a long-lived Pi process.
 *
 * Counterpart to OpenCode `session.deleted` cleanup in
 * `event-handler.ts:262-276`. We clean every per-session map this
 * module owns:
 *   - all 3 refresh signal sets (history / pendingMaterialization /
 *     systemPromptRefresh)
 *   - first-pass tracking
 *   - emergency-notification cooldown
 *   - auto-search per-turn cache
 *   - compressor cooldown timer
 *
 * NOT cleaned (intentional):
 *   - `inFlightHistorian` / `inFlightCompressor` — these promises
 *     own their own cleanup in `.finally()` and a session switch
 *     doesn't cancel a background subagent that's already running.
 *   - `recentReduceBySession` / `pendingNoteNudgeState` — module-
 *     private to other files; they expose their own clear helpers
 *     called from where they live.
 */
// IMPORTANT: this clears only IN-MEMORY, process-local maps — it must NOT call
// the durable DB `clearSession(db, sessionId)`. The two callers are
// `session_shutdown` and `session_before_switch`, NEITHER of which means the
// session was deleted — the session still exists on disk and may be resumed.
// Pi has no `session_deleted` event (OpenCode's event-handler is the only place
// the durable DB clearSession fires). Calling DB clearSession here would DESTROY
// live durable state (compartments, tags, memories) for a session the user
// merely switched away from — a data-loss bug far worse than the bounded
// orphan-row cost for sessions that are genuinely abandoned and never resumed.
// Do not add DB clearSession here.
export function clearContextHandlerSession(sessionId: string): void {
	activeContextHandlerSessions.delete(sessionId);
	clearAutoSearchForPiSession(sessionId);
	lastEmergencyNotificationAtMs.delete(sessionId);
	historyRefreshSessions.delete(sessionId);
	pendingMaterializationSessions.delete(sessionId);
	systemPromptRefreshSessions.delete(sessionId);
	deferredHistoryRefreshSessions.delete(sessionId);
	deferredMaterializationSessions.delete(sessionId);
	firstContextPassSeenBySession.delete(sessionId);
	commitSeenLastPass.delete(sessionId);
	recentReduceBySession.delete(sessionId);
	liveModelBySession.delete(sessionId);
	toolUsageSinceUserTurn.delete(sessionId);
	latestUserMessageBySession.delete(sessionId);
	lastHeuristicsTurnIdBySession.delete(sessionId);
	lastSeenProjectIdentityBySession.delete(sessionId);
	for (const [projectIdentity, sessions] of sessionsByProject) {
		sessions.delete(sessionId);
		if (sessions.size === 0) sessionsByProject.delete(projectIdentity);
	}
	const unregister = rawMessageProviderUnregistersBySession.get(sessionId);
	if (unregister) {
		unregister();
		rawMessageProviderUnregistersBySession.delete(sessionId);
	}
	clearSessionTracking(sessionId);
}
