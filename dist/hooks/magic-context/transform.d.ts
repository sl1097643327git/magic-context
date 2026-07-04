import type { Scheduler } from "../../features/magic-context/scheduler";
import { type ContextDatabase } from "../../features/magic-context/storage";
import type { Tagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import type { LiveModelBySession } from "./hook-handlers";
export declare function clearMessageTokensCache(sessionId: string, messageId?: string): void;
/**
 * Test-only accessor that returns (and lazily creates) the per-session token
 * cache map so tests can seed and inspect entries without running the full
 * transform pipeline. Not exported from any barrel.
 */
export declare function __getMessageTokensCacheForTest(sessionId: string): Map<string, {
    conversation: number;
    toolCall: number;
}>;
export interface TransformDeps {
    tagger: Tagger;
    scheduler: Scheduler;
    contextUsageMap: Map<string, {
        usage: ContextUsage;
        updatedAt: number;
        lastResponseTime?: number;
    }>;
    db: ContextDatabase;
    /**
     * Channel 1 (ctx_reduce tool-output nudge) per-session metric baseline,
     * refreshed at the end of each primary-session transform pass and read in
     * tool.execute.after. Subagents never get a snapshot, which is how Channel 1
     * stays primary-only.
     */
    channel1StateBySession?: Map<string, import("./ctx-reduce-nudge").Channel1State>;
    protectedTags: number;
    /**
     * Primary-session ctx_reduce setting. When false, tag prefix injection is
     * skipped for ALL sessions (primary + subagent). When true, primary sessions
     * get prefixes but subagent sessions still skip (subagents are always
     * treated as ctx_reduce_enabled=false). See tag-messages.ts for the gate.
     * Defaults to true when omitted (preserves legacy behavior for tests).
     */
    ctxReduceEnabled?: boolean;
    /** Smart-drops (experimental, default off): also reclaim tool output that a
     *  later call supersedes, on top of the age-based auto-drop. Off → messages
     *  sent to the model are byte-identical to the age-based-only behavior. */
    smartDrops?: boolean;
    clearReasoningAge: number;
    /** Commit-cluster historian trigger config (`commit_cluster_trigger`). */
    commitClusterTrigger?: {
        enabled: boolean;
        min_clusters: number;
    };
    /**
     * One-shot signal that `<session-history>` injection cache is stale and
     * `prepareCompartmentInjection` should rebuild on this pass. Drained
     * after the rebuild so subsequent defer passes hit the fresh cache.
     * See Oracle review 2026-04-26 for the three-set split rationale.
     */
    historyRefreshSessions: Set<string>;
    deferredHistoryRefreshSessions?: Set<string>;
    /**
     * Persistent signal that pending ops + heuristics need to materialize.
     * Survives across defer passes when `compartmentRunning` blocks the
     * heuristic pass. Drained only after `shouldRunHeuristics` succeeds.
     */
    pendingMaterializationSessions: Set<string>;
    deferredMaterializationSessions?: Set<string>;
    lastHeuristicsTurnId: Map<string, string>;
    commitSeenLastPass?: Map<string, boolean>;
    client?: PluginContext["client"];
    directory?: string;
    memoryConfig?: {
        enabled: boolean;
        injectionBudgetTokens: number;
        /** When true, historian/recomp auto-promote eligible session facts
         *  to project memories. When false, promotion is skipped — agents can
         *  still write memories explicitly via `ctx_memory write`. Issue #44. */
        autoPromote: boolean;
    };
    /** Defaults true. When false, m[0] omits the <project-docs> block and docs hash. */
    injectDocs?: boolean;
    ensureProjectRegistered?: (directory: string, db: ContextDatabase) => Promise<void>;
    /**
     * Returns the historian chunk budget. Called at each historian spawn site
     * so the value is always derived from current config — keeping hook,
     * RPC, and TUI trigger paths consistent and honoring runtime config changes.
     * Optional for tests; production (hook.ts) always provides it.
     */
    getHistorianChunkTokens?: () => number;
    historyBudgetPercentage?: number;
    executeThresholdPercentage?: number | {
        default: number;
        [modelKey: string]: number;
    };
    executeThresholdTokens?: {
        default?: number;
        [modelKey: string]: number | undefined;
    };
    historianTimeoutMs?: number;
    /** Resolved fallback chain for historian-family calls. */
    fallbackModels?: readonly string[];
    /** False when historian.disable=true, blocking historian-backed child agents. */
    historianRunnable?: boolean;
    getNotificationParams?: (sessionId: string) => import("./send-session-notification").NotificationParams;
    getModelKey?: (sessionId: string) => string | undefined;
    getFallbackModelId?: (sessionId: string) => string | undefined;
    projectPath?: string;
    experimentalUserMemories?: boolean;
    /** When true, inject wall-clock gap markers (<!-- +Xm -->) on user messages and
     *  add start/end date attributes to <compartment> elements in <session-history>.
     *  Controlled by `experimental.temporal_awareness` config. */
    experimentalTemporalAwareness?: boolean;
    /** When true, run a second editor pass after historian to clean U: lines.
     *  Enables the historian-editor agent. Controlled by `historian.two_pass` config. */
    historianTwoPass?: boolean;
    liveModelBySession?: LiveModelBySession;
    /**
     * Process-scoped cache of resolved session.directory values. When provided,
     * we look up here before hitting OpenCode's API and populate after a
     * successful lookup. The session→project binding is immutable in OpenCode,
     * so this cache lives until the session is deleted.
     */
    sessionDirectoryBySession?: Map<string, string>;
    /**
     * Process-scoped set of Magic Context's OWN hidden child sessions
     * (historian/dreamer/sidekick/memory-migration), detected by title prefix
     * at `session.created`. When a session is in this set the transform returns
     * immediately (messages unmodified) — these children have their own fixed
     * agent identity and never use any MC feature, so even reduced-mode work
     * (tagging, heuristic drops) is pure overhead. See live-session-state.ts.
     */
    internalChildSessions?: Set<string>;
    /** Experimental auto-search hint — transform-time ctx_search on each new
     *  user message; when top hit clears the threshold, append a compact
     *  fragment hint to the user message. Controlled by
     *  `experimental.auto_search.*` config. */
    autoSearch?: {
        enabled: boolean;
        scoreThreshold: number;
        minPromptChars: number;
        directory?: string;
        ensureProjectRegistered?: (directory: string, db: ContextDatabase) => Promise<void>;
    };
    /**
     * Experimental age-tier caveman text compression — rewrites long
     * user/assistant text parts with progressively aggressive caveman
     * rules based on their position in the eligible tag window. Only
     * honored when `ctx_reduce_enabled: false` (transform zeroes this
     * out when ctx_reduce is on so the postprocess path stays unaware).
     */
    cavemanTextCompression?: {
        enabled: boolean;
        minChars: number;
    };
    /** Fire-and-forget active-session embed backfill after transform returns. */
    maybeAutoEmbedSession?: (sessionId: string) => void;
}
export declare function createTransform(deps: TransformDeps): (_input: Record<string, never>, output: {
    messages: unknown[];
}) => Promise<void>;
export declare function resolveHistoryBudgetTokens(historyBudgetPercentage: number | undefined, contextUsage: ContextUsage, executeThresholdPercentage: number | {
    default: number;
    [modelKey: string]: number;
} | undefined, modelKey: string | undefined, executeThresholdTokens?: {
    default?: number;
    [modelKey: string]: number | undefined;
}, resolvedContextLimit?: number): number | undefined;
//# sourceMappingURL=transform.d.ts.map