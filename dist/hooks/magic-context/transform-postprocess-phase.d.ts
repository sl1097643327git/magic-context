import { type ContextDatabase, type PendingCompactionMarker } from "../../features/magic-context/storage";
import type { SessionMeta, TagEntry } from "../../features/magic-context/types";
import { type M0HardSignals, type PreparedCompartmentInjection } from "./inject-compartments";
import { type MessageLike, type TagTarget } from "./transform-operations";
export declare function resetDegradedCacheCount(sessionId: string): void;
export type DeferredCompactionMarkerClearOutcome = "cleared" | "cas-lost-newer-pending" | "cas-lost-already-cleared";
export declare function clearPendingCompactionMarkerAfterSuccessfulDrain(args: {
    db: ContextDatabase;
    sessionId: string;
    pending: PendingCompactionMarker;
    deferredHistoryRefreshSessions: Set<string>;
}): DeferredCompactionMarkerClearOutcome;
interface RunPostTransformPhaseArgs {
    sessionId: string;
    db: ContextDatabase;
    messages: MessageLike[];
    tags: TagEntry[];
    targets: Map<number, TagTarget>;
    reasoningByMessage: Map<MessageLike, {
        type: string;
        thinking?: string;
        text?: string;
    }[]>;
    messageTagNumbers: Map<MessageLike, number>;
    batch: {
        finalize: () => void;
    } | null;
    contextUsage: {
        percentage: number;
        inputTokens: number;
    };
    schedulerDecision: "execute" | "defer";
    fullFeatureMode: boolean;
    canRunCompartments: boolean;
    awaitedCompartmentRun: boolean;
    phaseJustAwaitedPublication: boolean;
    compartmentInProgress: boolean;
    historyRefreshExplicitBeforePrepare: boolean;
    deferredHistoryWasPendingAtPassStart: boolean;
    compartmentInjectionRebuiltFromDb: boolean;
    rebuiltHistoryFromInitialPrepare: boolean;
    historyRebuiltThisPass: boolean;
    canConsumeDeferredLate: boolean;
    sessionMeta: SessionMeta;
    currentTurnId: string | null;
    /**
     * Persistent signal that pending ops + heuristics need to materialize.
     * Survives across defer passes when `compartmentRunning` blocks the
     * heuristic pass. Drained ONLY after `shouldRunHeuristics` succeeds —
     * preserving `/ctx-flush` intent across blocked passes is the entire
     * reason for the three-set split (see Oracle review 2026-04-26).
     */
    pendingMaterializationSessions: Set<string>;
    deferredHistoryRefreshSessions: Set<string>;
    deferredMaterializationSessions: Set<string>;
    lastHeuristicsTurnId: Map<string, string>;
    clearReasoningAge: number;
    protectedTags: number;
    /**
     * Ceiling for the tiered emergency drop = contextLimit × executeThreshold%.
     * Undefined when the context limit isn't resolved (cold start) — the
     * emergency drop then skips (the 95% block stays the backstop).
     */
    emergencyCeilingTokens?: number;
    pendingCompartmentInjection: PreparedCompartmentInjection | null;
    didMutateFromFlushedStatuses: boolean;
    watermark: number;
    forceMaterializationPercentage: number;
    hasRecentReduceCall: boolean;
    projectPath?: string;
    sessionDirectory?: string;
    /** Experimental auto-search: when enabled, runs ctx_search on the latest
     *  user prompt and appends a compact fragment hint. */
    autoSearch?: {
        enabled: boolean;
        scoreThreshold: number;
        minPromptChars: number;
        directory?: string;
        ensureProjectRegistered?: (directory: string, db: ContextDatabase) => Promise<void>;
    };
    /**
     * Age-tier caveman compression (experimental). Only honored when
     * ctx_reduce_enabled is false. Caller is responsible for zeroing this
     * out when ctx_reduce is on. Passed through to `applyHeuristicCleanup`.
     */
    cavemanTextCompression?: {
        enabled: boolean;
        minChars: number;
    };
    /**
     * Smart-drops (experimental, default off): content-aware reclaim of tool
     * output that a later call supersedes. Runs alongside the age-based
     * auto-drop, only inside an execute pass that is already mutating, so it
     * never causes a cache bust on its own. Off → the messages sent to the model
     * are byte-identical to the age-based-only behavior.
     */
    smartDrops?: boolean;
    /**
     * Provider resolved once by the main transform for this pass. Used for every
     * empty-sentinel gate and whole-message placeholder choice so postprocess
     * cannot diverge from the main transform on cold DB-recovered passes.
     */
    resolvedProviderID?: string;
    historyRefreshSessions?: Set<string>;
    m0M1?: {
        projectPath?: string;
        projectDirectory?: string;
        injectDocs?: boolean;
        memoryInjectionBudgetTokens?: number;
        historyBudgetTokens?: number;
        hardSignals?: M0HardSignals;
    };
}
export interface PostTransformPhaseResult {
    explicitMaterializedSuccessfully: boolean;
    deferredMaterializedSuccessfully: boolean;
    materialized: boolean;
    materializeReason: string | null;
    droppedTokens: number;
    droppedCount: number;
    emergency: boolean;
    bustedThisPass: boolean;
}
export declare function runPostTransformPhase(args: RunPostTransformPhaseArgs): Promise<PostTransformPhaseResult>;
export declare function checkM0MutationDriftAndSignal(args: {
    db: ContextDatabase;
    sessionId: string;
    cachedM0MaxMutationId: number | null;
    pendingMaterializationSessions: Set<string>;
    historyRefreshSessions?: Set<string>;
}): boolean;
export {};
//# sourceMappingURL=transform-postprocess-phase.d.ts.map