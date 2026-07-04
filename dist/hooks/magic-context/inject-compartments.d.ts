import { Buffer } from "node:buffer";
import { type Compartment, type SessionFact } from "../../features/magic-context/compartment-storage";
import type { Memory } from "../../features/magic-context/memory/types";
import { type UserMemory } from "../../features/magic-context/user-memory/storage-user-memory";
import { type WorkspaceIdentitySet } from "../../features/magic-context/workspaces";
import type { Database } from "../../shared/sqlite";
import type { MessageLike } from "./tag-messages";
export interface PreparedCompartmentInjection {
    block: string;
    compartmentEndMessage: number;
    compartmentEndMessageId: string | null;
    compartmentCount: number;
    skippedVisibleMessages: number;
    factCount: number;
    memoryCount: number;
    rebuiltFromDb: boolean;
}
export declare function clearInjectionCache(sessionId: string): void;
/**
 * Return the set of memory ids currently rendered in the cached
 * <session-history> block for this session, if any. Used by ctx_search
 * to hard-filter memories the agent already sees in context — retrieving
 * them from search wastes tokens and pushes high-signal raw-history hits
 * further down the ranking.
 *
 * Returns null when no cache exists or the JSON payload is malformed
 * (callers should treat null as "don't filter" — the worst case is a
 * redundant memory result, not a correctness issue).
 */
export declare function getVisibleMemoryIds(db: Database, sessionId: string): Set<number> | null;
export interface CompartmentInjectionResult {
    injected: boolean;
    compartmentEndMessage: number;
    compartmentCount: number;
    skippedVisibleMessages: number;
}
export declare function renderMemoryBlock(memories: Memory[]): string | null;
/**
 * Sort memories by priority and trim to budget.
 *
 * Priority order:
 *   1. permanent status first
 *   2. utility tier (retrieved > constraint > other)
 *   3. seen count descending
 *   4. shorter content first (fit more memories in budget)
 *   5. deterministic id tiebreaker for cache stability
 *
 * Uses the real Claude tokenizer (via estimateTokens) so the trim stays
 * consistent with the rest of the plugin's token math — mismatching units
 * (chars/4 here vs real tokens elsewhere) caused either under- or
 * over-injection of memories, depending on memory content shape.
 */
export declare function trimMemoriesToBudget(sessionId: string, memories: Memory[], budgetTokens: number): Memory[];
export declare function prepareCompartmentInjection(db: Database, sessionId: string, messages: MessageLike[], isCacheBusting: boolean, projectPath?: string, injectionBudgetTokens?: number, temporalAwareness?: boolean): PreparedCompartmentInjection | null;
export declare function renderCompartmentInjection(sessionId: string, messages: MessageLike[], prepared: PreparedCompartmentInjection): CompartmentInjectionResult;
export interface M0SnapshotMarkers {
    projectMemoryEpoch: number;
    workspaceFingerprint: string | null;
    projectUserProfileVersion: number;
    maxCompartmentSeq: number;
    maxMemoryId: number;
    maxMutationId: number;
    maxMemoryMutationId: number;
    projectDocsHash: string;
    materializedAt: number;
    sessionFactsVersion: number;
    upgradeState: string | null;
    systemHash: string;
    modelKey: string;
}
/**
 * Runtime cache-eviction signals threaded into the materialization decision.
 * These are NOT derived from durable DB state like the content markers — they
 * come from the current flight (system-prompt hash, tool-set fingerprint,
 * provider/model key) plus the TTL idle window.
 */
export interface M0HardSignals {
    systemHash: string;
    modelKey: string;
    /** True when the provider cache TTL has elapsed since lastResponseTime. */
    cacheExpired: boolean;
    /** Epoch ms of the last completed assistant response (end-of-turn). */
    lastResponseTime: number;
}
export interface M0M1State {
    sessionId: string;
    isSubagent?: boolean;
    cachedM0Bytes: Buffer | null;
    cachedM1Bytes: Buffer | null;
    cachedM0ProjectMemoryEpoch: number | null;
    cachedM0WorkspaceFingerprint: string | null;
    cachedM0ProjectUserProfileVersion: number | null;
    cachedM0MaxCompartmentSeq: number | null;
    cachedM0MaxMemoryId: number | null;
    cachedM0MaxMutationId: number | null;
    cachedM0MaxMemoryMutationId: number | null;
    cachedM0ProjectDocsHash: string | null;
    cachedM0MaterializedAt: number | null;
    cachedM0SessionFactsVersion: number | null;
    cachedM0UpgradeState: string | null;
    cachedM0SystemHash: string | null;
    cachedM0ToolSetHash: string | null;
    cachedM0ModelKey: string | null;
    snapshotMarkers?: M0SnapshotMarkers | null;
}
export interface M0M1RenderOptions {
    db: Database;
    sessionId: string;
    messages?: MessageLike[];
    state: M0M1State;
    projectPath?: string;
    projectDirectory?: string;
    /** Defaults true. When false, m[0] omits the <project-docs> block and stores an empty docs hash. */
    injectDocs?: boolean;
    memoryInjectionBudgetTokens?: number;
    historyBudgetTokens?: number;
    userProfileBudgetTokens?: number;
    isCacheBustingPass?: boolean;
    /** Provider-side cache-eviction signals for HARD-bust detection. */
    hardSignals?: M0HardSignals;
    workspaceIdentitySet?: WorkspaceIdentitySet;
    beforePhase3ForTest?: () => void;
}
export interface MaterializeDecision {
    value: boolean;
    reason: string | null;
}
export interface MaterializeM0Result {
    m0Bytes: Buffer;
    m0Text: string;
    m1Bytes: Buffer;
    m1Text: string;
    snapshotMarkers: M0SnapshotMarkers;
    renderedMemoryIds: number[];
}
export interface InjectM0M1Result {
    injected: boolean;
    m0RematerializedThisPass: boolean;
    materializationContentionRetryExhausted: boolean;
    decision: MaterializeDecision;
    m0Bytes: Buffer | null;
    m1Text: string | null;
}
export declare class MaterializeContentionError extends Error {
    readonly retries: number;
    readonly reason: string;
    constructor(args?: {
        retries?: number;
        reason?: string;
    });
}
export declare class RenderM1InvalidMarkersError extends Error {
    constructor(sessionId: string);
}
type M0Compartment = Compartment;
export declare const DEFAULT_MEMORY_BUDGET_TOKENS = 8000;
export declare const DEFAULT_USER_PROFILE_BUDGET_TOKENS = 4000;
export interface WorkspaceRenderContext {
    identities: string[];
    expandedIdentities: string[];
    ownIdentities: string[];
    shareCategories: string[] | null;
    namesByIdentity: Map<string, string>;
    canonicalIdentityByStoredPath: Map<string, string>;
    isWorkspaced: boolean;
}
export interface MemoryRenderOptions {
    sourceNameByMemoryId?: ReadonlyMap<number, string>;
}
export declare function readCurrentM0SnapshotMarkers(args: {
    db: Database;
    sessionId: string;
    projectPath?: string;
    projectDirectory?: string;
    injectDocs?: boolean;
    hardSignals?: M0HardSignals;
    workspaceIdentitySet?: WorkspaceIdentitySet;
}): M0SnapshotMarkers;
/**
 * The materialization decision, organized around the bust taxonomy:
 *
 *   SOFT+  — defer pass, nothing new: replay m[0] AND m[1] byte-identical.
 *   SOFT   — exec / deferred-consume pass: m[1] re-renders (new compartments,
 *            new memories, new user-profile ride the m[1] delta), m[0] stays.
 *   HARD   — the provider cache is already dead (idle>TTL, model/system/tools
 *            changed) OR a genuine m[0] *content* marker changed: fold m[1] into
 *            m[0], re-run decay, reset m[1].
 *
 * `mustMaterialize` returns true ONLY for HARD. New compartments and additive
 * user-profile/memory changes are deliberately NOT triggers — they are m[1]
 * deltas (see renderM1) and must never mutate the m[0] baseline. That is the
 * whole point of the m[0]=frozen-prefix / m[1]=volatile-delta split: a routine
 * historian publish must keep the Anthropic prompt-cache prefix intact.
 */
export declare function mustMaterialize(args: {
    db: Database;
    sessionId: string;
    state: M0M1State;
    projectPath?: string;
    projectDirectory?: string;
    hardSignals?: M0HardSignals;
    workspaceIdentitySet?: WorkspaceIdentitySet;
    injectDocs?: boolean;
}): MaterializeDecision;
export interface TrimMemoriesResultV2 {
    selected: Memory[];
    renderOrder: Memory[];
}
export declare function trimMemoriesToBudgetV2(sessionId: string, memories: Memory[], budgetTokens: number, renderOptions?: MemoryRenderOptions): TrimMemoriesResultV2;
export declare function trimWorkspaceMemoriesToBudgetV2(sessionId: string, memories: Memory[], budgetTokens: number, workspace: WorkspaceRenderContext, renderOptions?: MemoryRenderOptions): TrimMemoriesResultV2;
export declare function trimUserMemoriesToBudget(memories: UserMemory[], budgetTokens: number): UserMemory[];
/**
 * Render ONE memory's v2 line exactly as it lands in the <project-memory> block.
 * Shared by renderMemoryBlockV2 (the wire render) and trimMemoriesToBudgetV2
 * (the budget accounting) so the budget is measured against the SAME bytes that
 * get injected — including the id/category/importance attributes. Measuring a
 * lighter shape (e.g. "- content") under-counts and lets the injected block
 * exceed the configured budget.
 */
export declare function renderMemoryLineV2(memory: Memory, sourceName?: string): string;
export declare function renderMemoryBlockV2(memories: Memory[], wrapper?: string, renderOptions?: MemoryRenderOptions): string;
export declare function renderM0(args: {
    projectDocs: string;
    userProfileBaseline: UserMemory[];
    compartments: M0Compartment[];
    memories: Memory[];
    facts: SessionFact[];
    memoryRenderOptions?: MemoryRenderOptions;
    historyBudgetTokens?: number;
    userProfileBudgetTokens?: number;
    decayPressureMultiplier?: number;
}): string;
export declare function materializeM0(options: M0M1RenderOptions): MaterializeM0Result;
export declare function materializeWithRetry(options: M0M1RenderOptions, maxRetries?: number): MaterializeM0Result;
export declare function renderM1(options: M0M1RenderOptions, markers: M0SnapshotMarkers, renderedMemoryIds?: readonly number[]): string;
export declare function injectM0M1(options: M0M1RenderOptions): InjectM0M1Result;
export {};
//# sourceMappingURL=inject-compartments.d.ts.map