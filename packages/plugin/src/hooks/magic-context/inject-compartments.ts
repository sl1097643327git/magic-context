import { Buffer } from "node:buffer";
import {
    buildCompartmentBlock,
    type Compartment,
    type CompartmentDateRanges,
    escapeXmlAttr,
    escapeXmlContent,
    getCompartments,
    type SessionFact,
} from "../../features/magic-context/compartment-storage";
import {
    CATEGORY_PRIORITY,
    MEMORY_CATEGORY_ORDER_PRIORITY,
    MEMORY_CATEGORY_ORDER_SQL,
    MEMORY_CATEGORY_ORDER_UNKNOWN,
} from "../../features/magic-context/memory/constants";
import {
    getMemoriesByProject,
    getMemorySelectColumns,
    isMemoryRow,
} from "../../features/magic-context/memory/storage-memory";
import type { Memory, MemoryCategory } from "../../features/magic-context/memory/types";
import {
    computeProjectDocsHash,
    GLOBAL_USER_PROFILE_PROJECT_PATH,
    getMaxM0MutationId,
    getProjectState,
    persistCachedM0,
    readProjectDocsCanonical,
} from "../../features/magic-context/storage";
import {
    getActiveUserMemories,
    type UserMemory,
} from "../../features/magic-context/user-memory/storage-user-memory";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { sessionLog } from "../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import { extractM0Block, renderCompartmentAtTier, renderDecayedCompartments } from "./decay-render";
import { buildKeyFilesBlock, type KeyFilesConfigForRender } from "./key-files-block";
import { getMessageTimesFromOpenCodeDb } from "./read-session-db";
import { estimateTokens } from "./read-session-formatting";
import type { MessageLike } from "./tag-messages";
import { formatDate } from "./temporal-awareness";

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

/**
 * In-memory cache of the last compartment injection result per session.
 * On non-flush passes, the cached result is replayed so that historian
 * publications between passes do not bust the Anthropic prompt-cache prefix.
 * The cache is invalidated explicitly via clearInjectionCache() after
 * historian/compressor/recomp write new compartments or facts.
 *
 * Bounded LRU: session.deleted clears entries explicitly, but sessions that
 * are never deleted (crashed OpenCode, force-quit, archived sessions) would
 * otherwise leak PreparedCompartmentInjection objects holding tens of KB of
 * XML each. 100 is generously above any realistic working set of active
 * sessions — evicted entries are simply recomputed on the next cache-busting
 * pass from the authoritative SQLite compartment state.
 */
const INJECTION_CACHE_MAX = 100;
type InjectionCacheEntry =
    | { kind: "empty"; compartmentEndMessageId: string; renderedBytes: number }
    | { kind: "populated"; injection: PreparedCompartmentInjection };

const injectionCache = new BoundedSessionMap<InjectionCacheEntry>(INJECTION_CACHE_MAX);

export function clearInjectionCache(sessionId: string): void {
    injectionCache.delete(sessionId);
}

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
export function getVisibleMemoryIds(db: Database, sessionId: string): Set<number> | null {
    try {
        const row = db
            .prepare("SELECT memory_block_ids FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { memory_block_ids: string | null } | null;
        if (!row?.memory_block_ids) return null;
        const parsed = JSON.parse(row.memory_block_ids) as unknown;
        if (!Array.isArray(parsed)) return null;
        const ids = new Set<number>();
        for (const value of parsed) {
            if (typeof value === "number" && Number.isFinite(value)) {
                ids.add(value);
            }
        }
        return ids.size > 0 ? ids : null;
    } catch {
        return null;
    }
}

export interface CompartmentInjectionResult {
    injected: boolean;
    compartmentEndMessage: number;
    compartmentCount: number;
    skippedVisibleMessages: number;
}

export function renderMemoryBlock(memories: Memory[]): string | null {
    const byCategory = new Map<MemoryCategory, Memory[]>();
    for (const m of memories) {
        const existing = byCategory.get(m.category);
        if (existing) {
            existing.push(m);
        } else {
            byCategory.set(m.category, [m]);
        }
    }

    const sections: string[] = [];
    for (const category of CATEGORY_PRIORITY) {
        const categoryMemories = byCategory.get(category);
        if (!categoryMemories || categoryMemories.length === 0) {
            continue;
        }
        sections.push(
            `<${category}>`,
            ...categoryMemories.map((m) => `- ${escapeXmlContent(m.content)}`),
            `</${category}>`,
        );
    }

    if (sections.length === 0) {
        return null;
    }

    return `<project-memory>\n${sections.join("\n")}\n</project-memory>`;
}

/** Constraint keywords that signal a memory encodes a rule rather than a description. */
const CONSTRAINT_KEYWORDS = /\b(must|never|always|cannot|should not|must not)\b/i;

/**
 * Assign a utility tier to a memory for injection priority.
 * Lower tier = higher priority (packed first).
 *
 * Tier 0: Agent actually searched for and found this memory.
 * Tier 1: Contains constraint/rule keywords — likely guards against a real bug.
 * Tier 2: Everything else.
 */
function utilityTier(m: Memory): number {
    if (m.retrievalCount > 0) return 0;
    if (CONSTRAINT_KEYWORDS.test(m.content)) return 1;
    return 2;
}

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
export function trimMemoriesToBudget(
    sessionId: string,
    memories: Memory[],
    budgetTokens: number,
): Memory[] {
    const sorted = [...memories].sort((a, b) => {
        // Permanent memories first
        if (a.status === "permanent" && b.status !== "permanent") return -1;
        if (b.status === "permanent" && a.status !== "permanent") return 1;
        // Then by utility tier (lower = higher priority)
        const tierDiff = utilityTier(a) - utilityTier(b);
        if (tierDiff !== 0) return tierDiff;
        // Then by seen count descending (more frequently seen = higher priority)
        const seenDiff = b.seenCount - a.seenCount;
        if (seenDiff !== 0) return seenDiff;
        // Prefer shorter memories so more fit in budget
        const lenDiff = a.content.length - b.content.length;
        if (lenDiff !== 0) return lenDiff;
        // Deterministic tiebreaker by id to ensure stable ordering for cache safety
        return a.id - b.id;
    });

    const result: Memory[] = [];
    let usedTokens = 0;

    for (const memory of sorted) {
        // Estimate the rendered memory line ("- {content}") with the real
        // Claude tokenizer, plus a fixed ~6-token allowance for opening and
        // closing XML category tags amortized per item. Keeps units
        // consistent with rpc-handlers.ts / transform.ts / system-prompt-hash.ts
        // so the sidebar's "Memories" segment matches what actually lands in
        // the injection block.
        const memoryTokens = estimateTokens(`- ${memory.content}`) + 6;
        if (usedTokens + memoryTokens > budgetTokens) {
            break;
        }
        result.push(memory);
        usedTokens += memoryTokens;
    }

    if (result.length < memories.length) {
        sessionLog(
            sessionId,
            `trimmed memories from ${memories.length} to ${result.length} to fit injection budget of ${budgetTokens} tokens`,
        );
    }

    return result;
}

export function prepareCompartmentInjection(
    db: Database,
    sessionId: string,
    messages: MessageLike[],
    isCacheBusting: boolean,
    projectPath?: string,
    injectionBudgetTokens?: number,
    temporalAwareness?: boolean,
): PreparedCompartmentInjection | null {
    // On defer (cache-safe) passes, replay the cached injection result so that
    // historian publications between passes do not bust the prompt-cache prefix.
    const cached = injectionCache.get(sessionId);
    if (!isCacheBusting && cached) {
        if (cached.kind === "empty") {
            return null;
        }
        const prepared = cached.injection;
        if (prepared.compartmentEndMessageId === null) {
            sessionLog(
                sessionId,
                "compartment injection cache in degraded mode (null boundary), forcing rebuild",
            );
        } else {
            // Re-do the splice with the cached boundary (messages are rebuilt fresh each pass)
            if (prepared.compartmentEndMessageId.length > 0) {
                const cutoffIndex = messages.findIndex(
                    (message) => message.info.id === prepared.compartmentEndMessageId,
                );
                if (cutoffIndex >= 0) {
                    const remaining = messages.slice(cutoffIndex + 1);
                    messages.splice(0, messages.length, ...remaining);
                } else {
                    // Boundary message not in array — covered messages were already
                    // trimmed by OpenCode (compaction, old history not sent). The splice
                    // is effectively a no-op because there's nothing to splice out.
                    // Keep the cached injection so <session-history> stays stable on
                    // defer passes instead of alternating between injected/not-injected.
                    sessionLog(
                        sessionId,
                        `compartment injection: cached boundary ${prepared.compartmentEndMessageId} not in messages (already trimmed), reusing cache`,
                    );
                }
            }
            return { ...prepared, rebuiltFromDb: false };
        }
    }

    const compartments = getCompartments(db, sessionId);
    // v2 faithful facts: session_facts is retired as a render source. Facts are
    // promoted to project memory and render via <project-memory>. We no longer
    // read or render session_facts here (matching the runner's removed write
    // side); legacy pre-v2 rows are left un-rendered until /ctx-session-upgrade.
    const facts: SessionFact[] = [];

    let memoryBlock: string | undefined;
    let memoryCount = 0;
    if (projectPath) {
        // Use cached memory block to avoid cache busting on background changes (ctx_memory write, promotion).
        // Cache is cleared by replaceSessionFacts/replaceAllCompartmentState after historian/compressor/recomp.
        // Audit note: `as` cast is safe here — session_meta schema is owned by this plugin and the two
        // columns are guaranteed present after initializeDatabase(). A type guard would add overhead on a
        // hot path (every transform) for a table we fully control.
        const cachedMemory = db
            .prepare(
                "SELECT memory_block_cache, memory_block_count FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId) as { memory_block_cache: string; memory_block_count: number } | null;

        if (cachedMemory?.memory_block_cache) {
            memoryBlock = cachedMemory.memory_block_cache;
            memoryCount = cachedMemory.memory_block_count;
        } else {
            let memories = getMemoriesByProject(db, projectPath, ["active", "permanent"]);
            if (injectionBudgetTokens && memories.length > 0) {
                memories = trimMemoriesToBudget(sessionId, memories, injectionBudgetTokens);
            }
            memoryCount = memories.length;
            memoryBlock = renderMemoryBlock(memories) ?? undefined;
            // Capture ids of memories actually rendered in the block. Stored in
            // session_meta.memory_block_ids as JSON so ctx_search can hard-filter
            // them out of search results (the agent already sees them in <session-history>).
            const renderedIds = memories.map((m) => m.id);

            // Snapshot so subsequent turns reuse the same block without cache bust.
            // Swallow SQLITE_BUSY: the cache is a pure optimization (the block itself
            // is already computed and returned below). If another writer holds the DB
            // past busy_timeout=5s — typically a concurrent dreamer/historian child
            // session or a second OpenCode process — we'd rather let the transform
            // proceed with a one-turn cache miss than crash the user's prompt.
            // Issue: https://github.com/cortexkit/magic-context/issues/23
            try {
                db.prepare(
                    "UPDATE session_meta SET memory_block_cache = ?, memory_block_count = ?, memory_block_ids = ? WHERE session_id = ?",
                ).run(memoryBlock ?? "", memoryCount, JSON.stringify(renderedIds), sessionId);
            } catch (error) {
                const code = (error as { code?: string } | null)?.code;
                if (code === "SQLITE_BUSY") {
                    sessionLog(
                        sessionId,
                        "memory_block_cache UPDATE hit SQLITE_BUSY, skipping snapshot for this turn",
                    );
                } else {
                    throw error;
                }
            }
        }
    }

    // Nothing to inject if we have no compartments, no facts, and no memories
    if (compartments.length === 0 && facts.length === 0 && !memoryBlock) {
        injectionCache.set(sessionId, {
            kind: "empty",
            compartmentEndMessageId: "",
            renderedBytes: 0,
        });
        return null;
    }

    let dateRanges: CompartmentDateRanges | undefined;
    if (temporalAwareness && compartments.length > 0) {
        // Resolve start/end message times from OpenCode's DB in a single batched query.
        const ids = new Set<string>();
        for (const c of compartments) {
            if (c.startMessageId) ids.add(c.startMessageId);
            if (c.endMessageId) ids.add(c.endMessageId);
        }
        const times = getMessageTimesFromOpenCodeDb(sessionId, Array.from(ids));
        const byId = new Map<number, { start: string; end: string }>();
        for (const c of compartments) {
            const startMs = times.get(c.startMessageId);
            const endMs = times.get(c.endMessageId);
            if (startMs !== undefined && endMs !== undefined) {
                byId.set(c.id, { start: formatDate(startMs), end: formatDate(endMs) });
            }
        }
        if (byId.size > 0) dateRanges = { byId };
    }

    const block = buildCompartmentBlock(compartments, facts, memoryBlock, dateRanges);

    // When there are no compartments yet (new session, or memories seeded before
    // historian first run), inject memories/facts without a boundary cutoff.
    // No messages are spliced because there's nothing to replace — the block is
    // prepended to message[0] the same way system-level context is.
    if (compartments.length === 0) {
        const result: PreparedCompartmentInjection = {
            block,
            compartmentEndMessage: 0,
            compartmentEndMessageId: "",
            compartmentCount: 0,
            skippedVisibleMessages: 0,
            factCount: facts.length,
            memoryCount,
            rebuiltFromDb: true,
        };
        injectionCache.set(sessionId, { kind: "populated", injection: result });
        return result;
    }

    const lastCompartment = compartments[compartments.length - 1];
    const lastEnd = lastCompartment.endMessage;
    const lastEndMessageId = lastCompartment.endMessageId;

    if (lastEndMessageId.length === 0) {
        sessionLog(
            sessionId,
            "injecting legacy compartments without visible-prefix trimming because latest stored compartment has no end_message_id",
            {
                compartmentCount: compartments.length,
                compartmentEndMessage: lastEnd,
            },
        );
        const result: PreparedCompartmentInjection = {
            block,
            compartmentEndMessage: lastEnd,
            compartmentEndMessageId: "",
            compartmentCount: compartments.length,
            skippedVisibleMessages: 0,
            factCount: facts.length,
            memoryCount,
            rebuiltFromDb: true,
        };
        injectionCache.set(sessionId, { kind: "populated", injection: result });
        return result;
    }

    let skippedVisibleMessages = 0;
    const cutoffIndex = messages.findIndex((message) => message.info.id === lastEndMessageId);
    if (cutoffIndex >= 0) {
        skippedVisibleMessages = cutoffIndex + 1;
        const remaining = messages.slice(cutoffIndex + 1);
        messages.splice(0, messages.length, ...remaining);
    } else {
        sessionLog(
            sessionId,
            `compartment injection entering degraded mode: boundary ${lastEndMessageId} not in visible messages`,
        );
    }

    const result: PreparedCompartmentInjection = {
        block,
        compartmentEndMessage: lastEnd,
        compartmentEndMessageId: cutoffIndex >= 0 ? lastEndMessageId : null,
        compartmentCount: compartments.length,
        skippedVisibleMessages,
        factCount: facts.length,
        memoryCount,
        rebuiltFromDb: true,
    };
    injectionCache.set(sessionId, { kind: "populated", injection: result });
    return result;
}

export function renderCompartmentInjection(
    sessionId: string,
    messages: MessageLike[],
    prepared: PreparedCompartmentInjection,
): CompartmentInjectionResult {
    const historyBlock = `<session-history>\n${prepared.block}\n</session-history>`;
    const firstMessage = messages[0];
    const textPart = firstMessage ? findFirstTextPart(firstMessage.parts) : null;
    if (!firstMessage || !textPart || isDroppedPlaceholder(textPart.text)) {
        messages.unshift({
            info: { role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: historyBlock }],
        });
    } else {
        textPart.text = `${historyBlock}\n\n${textPart.text}`;
    }

    const memoryLabel = prepared.memoryCount > 0 ? ` + ${prepared.memoryCount} memories` : "";
    if (prepared.compartmentCount > 0) {
        sessionLog(
            sessionId,
            `injected ${prepared.compartmentCount} compartments + ${prepared.factCount} facts${memoryLabel} into message[0]`,
        );
    } else {
        sessionLog(
            sessionId,
            `injected ${prepared.factCount} facts${memoryLabel} into message[0] (no compartments yet)`,
        );
    }

    return {
        injected: true,
        compartmentEndMessage: prepared.compartmentEndMessage,
        compartmentCount: prepared.compartmentCount,
        skippedVisibleMessages: prepared.skippedVisibleMessages,
    };
}

function findFirstTextPart(parts: unknown[]): { type: string; text: string } | null {
    for (const part of parts) {
        if (part === null || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string" && !p.ignored) {
            return p as unknown as { type: string; text: string };
        }
    }
    return null;
}

function isDroppedPlaceholder(text: string): boolean {
    return /^\[dropped §\d+§\]$/.test(text.trim());
}

export interface M0SnapshotMarkers {
    projectMemoryEpoch: number;
    projectUserProfileVersion: number;
    maxCompartmentSeq: number;
    maxMemoryId: number;
    maxMutationId: number;
    projectDocsHash: string;
    materializedAt: number;
    sessionFactsVersion: number;
    upgradeState: string | null;
}

export interface M0M1State {
    sessionId: string;
    isSubagent?: boolean;
    cachedM0Bytes: Buffer | null;
    cachedM0ProjectMemoryEpoch: number | null;
    cachedM0ProjectUserProfileVersion: number | null;
    cachedM0MaxCompartmentSeq: number | null;
    cachedM0MaxMemoryId: number | null;
    cachedM0MaxMutationId: number | null;
    cachedM0ProjectDocsHash: string | null;
    cachedM0MaterializedAt: number | null;
    cachedM0SessionFactsVersion: number | null;
    cachedM0UpgradeState: string | null;
    snapshotMarkers?: M0SnapshotMarkers | null;
}

export interface M0M1RenderOptions {
    db: Database;
    sessionId: string;
    messages?: MessageLike[];
    state: M0M1State;
    projectPath?: string;
    projectDirectory?: string;
    memoryInjectionBudgetTokens?: number;
    historyBudgetTokens?: number;
    userProfileBudgetTokens?: number;
    keyFiles?: KeyFilesConfigForRender;
    beforePhase3ForTest?: () => void;
}

export interface MaterializeDecision {
    value: boolean;
    reason: string | null;
}

export interface MaterializeM0Result {
    m0Bytes: Buffer;
    m0Text: string;
    snapshotMarkers: M0SnapshotMarkers;
}

export interface InjectM0M1Result {
    injected: boolean;
    m0RematerializedThisPass: boolean;
    materializationContentionRetryExhausted: boolean;
    decision: MaterializeDecision;
    m0Bytes: Buffer | null;
    m1Text: string | null;
}

export class MaterializeContentionError extends Error {
    readonly retries: number;
    readonly reason: string;

    constructor(args: { retries?: number; reason?: string } = {}) {
        super(args.reason ?? "m[0] materialization contention");
        this.name = "MaterializeContentionError";
        this.retries = args.retries ?? 0;
        this.reason = args.reason ?? "contention";
    }
}

export class RenderM1InvalidMarkersError extends Error {
    constructor(sessionId: string) {
        super(`Cannot render m[1] for ${sessionId}: missing cached m[0] snapshot markers`);
        this.name = "RenderM1InvalidMarkersError";
    }
}

// Compartment already carries p1..p4, importance, episodeType, legacy (v2 model B).
// Alias retained for readability at render call sites.
type M0Compartment = Compartment;

const DEFAULT_HISTORY_BUDGET_TOKENS = 60_000;
export const DEFAULT_MEMORY_BUDGET_TOKENS = 8_000;

/**
 * Token cost of the `<project-memory>` … `</project-memory>` wrapper itself,
 * seeded into the v2 trim accounting so the budget covers the whole injected
 * block (wrapper + lines), not just the line bodies.
 */
const MEMORY_BLOCK_WRAPPER_TOKENS = 6;
export const DEFAULT_USER_PROFILE_BUDGET_TOKENS = 4_000;
const M0_EMPTY_BODY = "<session-history></session-history>";
const M1_EMPTY_PLACEHOLDER =
    "<session-history-since>(no new content since last materialization)</session-history-since>";

const maxCompartmentSeqStatements = new WeakMap<Database, PreparedStatement>();
const maxMemoryIdStatements = new WeakMap<Database, PreparedStatement>();
const legacyCompartmentCountStatements = new WeakMap<Database, PreparedStatement>();
const m0CompartmentStatements = new WeakMap<Database, PreparedStatement>();
const newCompartmentStatements = new WeakMap<Database, PreparedStatement>();

function cachedStatement(
    cache: WeakMap<Database, PreparedStatement>,
    db: Database,
    sql: string,
): PreparedStatement {
    let stmt = cache.get(db);
    if (!stmt) {
        stmt = db.prepare(sql);
        cache.set(db, stmt);
    }
    return stmt;
}

function numberFromRow(row: unknown, key: string): number {
    if (!row || typeof row !== "object") return 0;
    const value = (row as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getMaxCompartmentSeq(db: Database, sessionId: string): number {
    const row = cachedStatement(
        maxCompartmentSeqStatements,
        db,
        "SELECT COALESCE(MAX(sequence), 0) AS s FROM compartments WHERE session_id = ?",
    ).get(sessionId);
    return numberFromRow(row, "s");
}

function getMaxMemoryId(db: Database, projectPath: string | undefined): number {
    if (!projectPath) return 0;
    const row = cachedStatement(
        maxMemoryIdStatements,
        db,
        "SELECT COALESCE(MAX(id), 0) AS max_id FROM memories WHERE project_path = ?",
    ).get(projectPath);
    return numberFromRow(row, "max_id");
}

// v2: session_facts is retired as a render source (facts = promoted memories).
// The m[0] snapshot keeps a sessionFactsVersion field for shape stability, but
// it is pinned to 0 so fact changes never drive m[0] re-materialization —
// rendered bytes no longer depend on session_facts. (Avoids wasted rebuilds.)
function getSessionFactsVersion(_db: Database, _sessionId: string): number {
    return 0;
}

function getUpgradeState(db: Database, sessionId: string): string | null {
    const row = cachedStatement(
        legacyCompartmentCountStatements,
        db,
        "SELECT COUNT(*) AS count FROM compartments WHERE session_id = ? AND legacy = 1",
    ).get(sessionId);
    return numberFromRow(row, "count") > 0 ? "legacy" : "ready";
}

function getProjectMemoryEpoch(db: Database, projectPath: string | undefined): number {
    if (!projectPath) return 0;
    return getProjectState(db, projectPath)?.projectMemoryEpoch ?? 0;
}

function getGlobalUserProfileVersion(db: Database): number {
    return getProjectState(db, GLOBAL_USER_PROFILE_PROJECT_PATH)?.projectUserProfileVersion ?? 0;
}

export function readCurrentM0SnapshotMarkers(args: {
    db: Database;
    sessionId: string;
    projectPath?: string;
    projectDirectory?: string;
}): M0SnapshotMarkers {
    const projectDirectory = args.projectDirectory ?? args.projectPath ?? "";
    return {
        projectMemoryEpoch: getProjectMemoryEpoch(args.db, args.projectPath),
        projectUserProfileVersion: getGlobalUserProfileVersion(args.db),
        maxCompartmentSeq: getMaxCompartmentSeq(args.db, args.sessionId),
        maxMemoryId: getMaxMemoryId(args.db, args.projectPath),
        maxMutationId: getMaxM0MutationId(args.db, args.sessionId) ?? 0,
        projectDocsHash: projectDirectory ? computeProjectDocsHash(projectDirectory) : "",
        materializedAt: Date.now(),
        sessionFactsVersion: getSessionFactsVersion(args.db, args.sessionId),
        upgradeState: getUpgradeState(args.db, args.sessionId),
    };
}

function snapshotMarkersFromCachedM0(state: M0M1State): M0SnapshotMarkers | null {
    if (!state.cachedM0Bytes) return null;
    if (state.cachedM0ProjectMemoryEpoch === null) return null;
    if (state.cachedM0ProjectUserProfileVersion === null) return null;
    if (state.cachedM0MaxCompartmentSeq === null) return null;
    if (state.cachedM0MaxMemoryId === null) return null;
    if (state.cachedM0MaxMutationId === null) return null;
    if (state.cachedM0SessionFactsVersion === null) return null;
    return {
        projectMemoryEpoch: state.cachedM0ProjectMemoryEpoch,
        projectUserProfileVersion: state.cachedM0ProjectUserProfileVersion,
        maxCompartmentSeq: state.cachedM0MaxCompartmentSeq,
        maxMemoryId: state.cachedM0MaxMemoryId,
        maxMutationId: state.cachedM0MaxMutationId,
        projectDocsHash: state.cachedM0ProjectDocsHash ?? "",
        materializedAt: state.cachedM0MaterializedAt ?? 0,
        sessionFactsVersion: state.cachedM0SessionFactsVersion,
        upgradeState: state.cachedM0UpgradeState,
    };
}

export function mustMaterialize(args: {
    db: Database;
    sessionId: string;
    state: M0M1State;
    projectPath?: string;
    projectDirectory?: string;
}): MaterializeDecision {
    if (!args.state.cachedM0Bytes) return { value: true, reason: "first_render" };
    const current = readCurrentM0SnapshotMarkers(args);
    if (args.state.cachedM0ProjectMemoryEpoch !== current.projectMemoryEpoch) {
        return { value: true, reason: "project_memory_epoch" };
    }
    if (args.state.cachedM0ProjectUserProfileVersion !== current.projectUserProfileVersion) {
        return { value: true, reason: "project_user_profile_version" };
    }
    if (args.state.cachedM0MaxCompartmentSeq !== current.maxCompartmentSeq) {
        return { value: true, reason: "max_compartment_seq" };
    }
    // NOTE: maxMemoryId is deliberately NOT a materialization trigger. New
    // memories are ADDITIVE and surface in m[1] via the maxMemoryId watermark
    // (readNewMemoriesForM1 reads id > cachedM0MaxMemoryId). Triggering m[0]
    // rematerialization on every memory write would bust the m[0] cache on
    // routine additive writes — defeating the whole additive-stability design.
    // Non-additive memory mutations (update/delete/archive/merge) bump
    // project_memory_epoch instead, which IS a correct m[0] invalidation above.
    if (args.state.cachedM0MaxMutationId !== current.maxMutationId) {
        return { value: true, reason: "max_mutation_id" };
    }
    if ((args.state.cachedM0ProjectDocsHash ?? "") !== current.projectDocsHash) {
        return { value: true, reason: "project_docs_hash" };
    }
    // session_facts retired as a render source (v2): facts are promoted memories
    // now, so a facts-version change never affects m[0] bytes. (getSessionFactsVersion
    // is pinned to 0; this branch is kept inert-safe but never fires.)
    if ((args.state.cachedM0UpgradeState ?? null) !== current.upgradeState) {
        return { value: true, reason: "upgrade_state" };
    }
    return { value: false, reason: null };
}

export interface TrimMemoriesResultV2 {
    selected: Memory[];
    renderOrder: Memory[];
}

export function trimMemoriesToBudgetV2(
    sessionId: string,
    memories: Memory[],
    budgetTokens: number,
): TrimMemoriesResultV2 {
    const selectionOrder = [...memories].sort((a, b) => {
        if (a.status === "permanent" && b.status !== "permanent") return -1;
        if (b.status === "permanent" && a.status !== "permanent") return 1;
        const importanceDiff = (b.importance ?? 50) - (a.importance ?? 50);
        if (importanceDiff !== 0) return importanceDiff;
        return a.id - b.id;
    });

    const selected: Memory[] = [];
    // Seed with the <project-memory> wrapper cost so the budget covers the whole
    // injected block, not just the line bodies.
    let usedTokens = MEMORY_BLOCK_WRAPPER_TOKENS;
    for (const memory of selectionOrder) {
        // Measure the EXACT v2 line that renderMemoryBlockV2 emits (with
        // id/category/importance attributes). Using a lighter shape here
        // under-counts and lets the rendered block overshoot the budget
        // (e.g. a v1 "- content" estimate fit 202 memories at ~8K while the v2
        // render actually injected ~11.3K against a 10K budget).
        const memoryTokens = estimateTokens(renderMemoryLineV2(memory));
        if (usedTokens + memoryTokens > budgetTokens) continue;
        selected.push(memory);
        usedTokens += memoryTokens;
    }

    if (selected.length < memories.length) {
        sessionLog(
            sessionId,
            `v2 trimmed memories from ${memories.length} to ${selected.length} to fit injection budget of ${budgetTokens} tokens`,
        );
    }

    const renderOrder = [...selected].sort((a, b) => {
        const aPriority =
            (MEMORY_CATEGORY_ORDER_PRIORITY as Record<string, number>)[a.category] ??
            MEMORY_CATEGORY_ORDER_UNKNOWN;
        const bPriority =
            (MEMORY_CATEGORY_ORDER_PRIORITY as Record<string, number>)[b.category] ??
            MEMORY_CATEGORY_ORDER_UNKNOWN;
        const categoryDiff = aPriority - bPriority;
        if (categoryDiff !== 0) return categoryDiff;
        return a.id - b.id;
    });

    return { selected, renderOrder };
}

function safeGetActiveUserMemories(db: Database): UserMemory[] {
    try {
        return getActiveUserMemories(db);
    } catch (error) {
        if (String(error).includes("no such table: user_memories")) return [];
        throw error;
    }
}

export function trimUserMemoriesToBudget(
    memories: UserMemory[],
    budgetTokens: number,
): UserMemory[] {
    const selected: UserMemory[] = [];
    let usedTokens = 0;
    for (const memory of memories) {
        const tokens = estimateTokens(`- ${memory.content}`) + 4;
        if (usedTokens + tokens > budgetTokens) continue;
        selected.push(memory);
        usedTokens += tokens;
    }
    return selected;
}

function readM0Compartments(db: Database, sessionId: string): M0Compartment[] {
    const rows = cachedStatement(
        m0CompartmentStatements,
        db,
        `SELECT id, session_id, sequence, start_message, end_message, start_message_id,
                end_message_id, title, content, p1, p2, p3, p4, episode_type,
                created_at, importance, legacy
           FROM compartments
          WHERE session_id = ?
          ORDER BY sequence ASC`,
    ).all(sessionId) as Array<Record<string, unknown>>;

    return rows.map(rowToM0Compartment);
}

function nullableString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function rowToM0Compartment(row: Record<string, unknown>): M0Compartment {
    return {
        id: Number(row.id ?? 0),
        sessionId: String(row.session_id ?? ""),
        sequence: Number(row.sequence ?? 0),
        startMessage: Number(row.start_message ?? 0),
        endMessage: Number(row.end_message ?? 0),
        startMessageId: String(row.start_message_id ?? ""),
        endMessageId: String(row.end_message_id ?? ""),
        title: String(row.title ?? ""),
        content: String(row.content ?? ""),
        p1: nullableString(row.p1),
        p2: nullableString(row.p2),
        p3: nullableString(row.p3),
        p4: nullableString(row.p4),
        importance: Number(row.importance ?? 50),
        episodeType: nullableString(row.episode_type),
        legacy: Number(row.legacy ?? 0),
        createdAt: Number(row.created_at ?? 0),
    };
}

function readNewCompartments(
    db: Database,
    sessionId: string,
    afterSequence: number,
): M0Compartment[] {
    const rows = cachedStatement(
        newCompartmentStatements,
        db,
        `SELECT id, session_id, sequence, start_message, end_message, start_message_id,
                end_message_id, title, content, p1, p2, p3, p4, episode_type,
                created_at, importance, legacy
           FROM compartments
          WHERE session_id = ? AND sequence > ?
          ORDER BY sequence ASC`,
    ).all(sessionId, afterSequence) as Array<Record<string, unknown>>;
    return rows.map(rowToM0Compartment);
}

function readNewMemoriesForM1(
    db: Database,
    projectPath: string | undefined,
    afterId: number,
    // Expiry cutoff is FROZEN to the m[0] materialization timestamp, NOT live
    // Date.now(). Defer passes replay the same markers (same materializedAt), so
    // the set of "not-yet-expired" memories rendered into m[1] stays byte-stable
    // until the next materialization. Using live Date.now() here would let a
    // memory crossing its expires_at between two defer passes silently change
    // m[1] bytes with no DB mutation — a cache-stability (Anthropic prefix) bust.
    expiryCutoff: number,
): Memory[] {
    if (!projectPath) return [];
    const rows = db
        .prepare(
            `SELECT ${getMemorySelectColumns(db)}
               FROM memories
              WHERE project_path = ?
                AND id > ?
                AND status IN ('active', 'permanent')
                AND (expires_at IS NULL OR expires_at > ?)
              ORDER BY ${MEMORY_CATEGORY_ORDER_SQL}, id ASC`,
        )
        .all(projectPath, afterId, expiryCutoff)
        .filter(isMemoryRow);
    return rows.map((row) => ({ ...row }));
}

/**
 * Render ONE memory's v2 line exactly as it lands in the <project-memory> block.
 * Shared by renderMemoryBlockV2 (the wire render) and trimMemoriesToBudgetV2
 * (the budget accounting) so the budget is measured against the SAME bytes that
 * get injected — including the id/category/importance attributes. Measuring a
 * lighter shape (e.g. "- content") under-counts and lets the injected block
 * exceed the configured budget.
 */
export function renderMemoryLineV2(memory: Memory): string {
    return `  <memory id="${memory.id}" category="${escapeXmlAttr(memory.category)}" importance="${memory.importance ?? 50}">${escapeXmlContent(memory.content)}</memory>`;
}

export function renderMemoryBlockV2(memories: Memory[], wrapper = "project-memory"): string {
    if (memories.length === 0) return "";
    const lines = [`<${wrapper}>`];
    for (const memory of memories) {
        lines.push(renderMemoryLineV2(memory));
    }
    lines.push(`</${wrapper}>`);
    return lines.join("\n");
}

function renderUserProfileBlock(memories: UserMemory[], wrapper = "user-profile"): string {
    if (memories.length === 0) return "";
    const lines = [`<${wrapper}>`];
    for (const memory of memories) {
        lines.push(`- ${escapeXmlContent(memory.content)}`);
    }
    lines.push(`</${wrapper}>`);
    return lines.join("\n");
}

/**
 * v2 decayed session-history rendering delegates entirely to the shared
 * `decay-render` module (which uses the validated `decay-curve` formula). This
 * keeps OpenCode and Pi byte-identical and ensures the council-validated decay
 * math is the single source of truth — no local approximation lives here.
 *
 * Facts are NOT a render input (v2 faithful: facts = promoted memories).
 */
function renderSessionHistoryWithDecay(args: {
    compartments: M0Compartment[];
    historyBudgetTokens: number;
}): string {
    return renderDecayedCompartments({
        compartments: args.compartments,
        historyBudgetTokens: args.historyBudgetTokens,
    });
}

export function renderM0(args: {
    projectDocs: string;
    userProfileBaseline: UserMemory[];
    compartments: M0Compartment[];
    memories: Memory[];
    facts: SessionFact[];
    historyBudgetTokens?: number;
    userProfileBudgetTokens?: number;
    decayPressureMultiplier?: number;
}): string {
    const sections: string[] = [];
    if (args.projectDocs.length > 0) sections.push(args.projectDocs);
    const userProfile = renderUserProfileBlock(
        trimUserMemoriesToBudget(
            args.userProfileBaseline,
            args.userProfileBudgetTokens ?? DEFAULT_USER_PROFILE_BUDGET_TOKENS,
        ),
    );
    if (userProfile) sections.push(userProfile);

    // The +15% drift "pressure multiplier" maps to a proportionally tighter
    // effective budget (lower budget → higher curve pressure → more demotion),
    // keeping decay-curve.ts the single source of pressure math.
    const baseBudget = args.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS;
    const effectiveBudget = baseBudget / Math.max(1, args.decayPressureMultiplier ?? 1);
    const sessionHistory = renderSessionHistoryWithDecay({
        compartments: args.compartments,
        historyBudgetTokens: effectiveBudget,
    });
    sections.push(
        sessionHistory.length > 0
            ? `<session-history>\n${sessionHistory}\n</session-history>`
            : M0_EMPTY_BODY,
    );

    const memoriesBlock = renderMemoryBlockV2(args.memories);
    if (memoriesBlock) sections.push(memoriesBlock);
    return sections.join("\n\n").trim();
}

function applyMarkersToState(state: M0M1State, m0Bytes: Buffer, markers: M0SnapshotMarkers): void {
    state.cachedM0Bytes = m0Bytes;
    state.cachedM0ProjectMemoryEpoch = markers.projectMemoryEpoch;
    state.cachedM0ProjectUserProfileVersion = markers.projectUserProfileVersion;
    state.cachedM0MaxCompartmentSeq = markers.maxCompartmentSeq;
    state.cachedM0MaxMemoryId = markers.maxMemoryId;
    state.cachedM0MaxMutationId = markers.maxMutationId;
    state.cachedM0ProjectDocsHash = markers.projectDocsHash;
    state.cachedM0MaterializedAt = markers.materializedAt;
    state.cachedM0SessionFactsVersion = markers.sessionFactsVersion;
    state.cachedM0UpgradeState = markers.upgradeState;
    state.snapshotMarkers = markers;
}

/**
 * Real-tokenizer size of ONLY the <session-history> slice of a rendered m[0].
 *
 * The over-budget tightening loop must compare the history block against the
 * history budget — NOT the whole m[0]. m[0] also carries <project-docs>,
 * <user-profile>, and <project-memory>, each with its own budget; charging
 * those fixed blocks against the history budget falsely inflates measured cost,
 * over-tightens decay pressure, and starves session-history (e.g. project-docs
 * ~20K eating into a 98K history budget collapsed the effective budget to ~73K,
 * archiving ~157 extra compartments). Returns 0 when no session-history slice is
 * present (empty-history placeholder), so the loop never fires on empty history.
 */
function historySliceTokens(m0Text: string): number {
    const slice = extractM0Block(m0Text, "session-history");
    return slice ? estimateTokens(slice) : 0;
}

export function materializeM0(options: M0M1RenderOptions): MaterializeM0Result {
    const projectPath = options.projectPath;
    const projectDirectory = options.projectDirectory ?? projectPath ?? "";
    let snapshotMarkers: M0SnapshotMarkers;
    let compartments: M0Compartment[] = [];
    let facts: SessionFact[] = [];
    let memories: Memory[] = [];
    let userMemories: UserMemory[] = [];
    let docs: { renderedBlock: string; canonicalHash: string } = {
        renderedBlock: "",
        canonicalHash: "",
    };

    options.db.exec("BEGIN");
    try {
        snapshotMarkers = readCurrentM0SnapshotMarkers({
            db: options.db,
            sessionId: options.sessionId,
            projectPath,
            projectDirectory,
        });
        docs = projectDirectory
            ? readProjectDocsCanonical(projectDirectory)
            : { renderedBlock: "", canonicalHash: "" };
        snapshotMarkers.projectDocsHash = docs.canonicalHash;
        compartments = readM0Compartments(options.db, options.sessionId);
        // v2 faithful facts: session_facts is retired as a render source (facts
        // promote to project memory, rendered below via `memories`). Keep `facts`
        // empty so renderSessionHistoryWithDecay never emits a <session_facts>
        // block and no stale pre-v2 rows leak into m[0].
        facts = [];
        memories = projectPath
            ? getMemoriesByProject(options.db, projectPath, ["active", "permanent"])
            : [];
        userMemories = safeGetActiveUserMemories(options.db);
        options.db.exec("COMMIT");
    } catch (error) {
        try {
            options.db.exec("ROLLBACK");
        } catch {
            // ignore rollback failures from an already-closed transaction
        }
        throw error;
    }

    const memoryBudget = options.memoryInjectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS;
    const trimmed = trimMemoriesToBudgetV2(options.sessionId, memories, memoryBudget);
    let decayPressureMultiplier = 1;
    let m0Text = renderM0({
        projectDocs: docs.renderedBlock,
        userProfileBaseline: userMemories,
        compartments,
        memories: trimmed.renderOrder,
        facts,
        historyBudgetTokens: options.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS,
        userProfileBudgetTokens: options.userProfileBudgetTokens,
        decayPressureMultiplier,
    });

    let attempts = 0;
    const budget = options.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS;
    while (budget > 0 && historySliceTokens(m0Text) > budget * 1.05 && attempts < 3) {
        decayPressureMultiplier *= 1.15;
        m0Text = renderM0({
            projectDocs: docs.renderedBlock,
            userProfileBaseline: userMemories,
            compartments,
            memories: trimmed.renderOrder,
            facts,
            historyBudgetTokens: budget,
            userProfileBudgetTokens: options.userProfileBudgetTokens,
            decayPressureMultiplier,
        });
        attempts += 1;
    }

    if (m0Text.length === 0) m0Text = M0_EMPTY_BODY;
    const m0Bytes = Buffer.from(m0Text, "utf8");
    snapshotMarkers.materializedAt = Date.now();

    options.beforePhase3ForTest?.();

    options.db.exec("BEGIN IMMEDIATE");
    try {
        const current = readCurrentM0SnapshotMarkers({
            db: options.db,
            sessionId: options.sessionId,
            projectPath,
            projectDirectory,
        });
        // NOTE: maxMemoryId is deliberately EXCLUDED from this stale-check.
        // Additive memory writes (write/promote) do not bump projectMemoryEpoch
        // and must NOT bust m[0] (they surface in m[1] via the persisted
        // maxMemoryId watermark). A new memory landing between Phase 1 and Phase 3
        // does not invalidate the rendered m[0] — m[0] correctly reflects the
        // snapshot's memory set and the new one appears in m[1]. Non-additive
        // mutations (update/delete/archive/merge) bump projectMemoryEpoch and ARE
        // caught below. Including maxMemoryId here would convert every additive
        // write into a spurious contention/re-materialize.
        const stale =
            current.projectMemoryEpoch !== snapshotMarkers.projectMemoryEpoch ||
            current.projectUserProfileVersion !== snapshotMarkers.projectUserProfileVersion ||
            current.maxCompartmentSeq !== snapshotMarkers.maxCompartmentSeq ||
            current.maxMutationId !== snapshotMarkers.maxMutationId ||
            current.projectDocsHash !== snapshotMarkers.projectDocsHash ||
            current.sessionFactsVersion !== snapshotMarkers.sessionFactsVersion ||
            current.upgradeState !== snapshotMarkers.upgradeState;
        if (stale) {
            options.db.exec("ROLLBACK");
            throw new MaterializeContentionError({ reason: "snapshot changed before Phase 3" });
        }

        persistCachedM0(options.db, options.sessionId, {
            m0Bytes,
            projectMemoryEpoch: snapshotMarkers.projectMemoryEpoch,
            projectUserProfileVersion: snapshotMarkers.projectUserProfileVersion,
            maxCompartmentSeq: snapshotMarkers.maxCompartmentSeq,
            maxMemoryId: snapshotMarkers.maxMemoryId,
            maxMutationId: snapshotMarkers.maxMutationId,
            projectDocsHash: snapshotMarkers.projectDocsHash,
            materializedAt: snapshotMarkers.materializedAt,
            sessionFactsVersion: snapshotMarkers.sessionFactsVersion,
            upgradeState: snapshotMarkers.upgradeState,
        });

        // v2 path persists the rendered-memory identity itself. `memory_block_ids`
        // / `memory_block_count` are otherwise written ONLY by the dead legacy v1
        // render path, so without this they stay frozen at whatever the last legacy
        // render wrote — wrong sidebar "Injected" count AND a stale ctx_search
        // hide-already-visible filter after any memory change (e.g. the migration
        // delete+reinserts memories with NEW ids; the old ids linger here).
        // dogfood 2026-05-30: AFT showed "Injected 256" against 124 live memories,
        // all 256 ids deleted. Same transaction as the m[0] snapshot so the cached
        // bytes and their id manifest never diverge.
        const renderedMemoryIds = trimmed.renderOrder.map((m) => m.id);
        options.db
            .prepare(
                "UPDATE session_meta SET memory_block_count = ?, memory_block_ids = ? WHERE session_id = ?",
            )
            .run(renderedMemoryIds.length, JSON.stringify(renderedMemoryIds), options.sessionId);

        options.db.exec("COMMIT");
    } catch (error) {
        try {
            options.db.exec("ROLLBACK");
        } catch {
            // already rolled back
        }
        throw error;
    }

    return { m0Bytes, m0Text, snapshotMarkers };
}

export function materializeWithRetry(
    options: M0M1RenderOptions,
    maxRetries = 3,
): MaterializeM0Result {
    let lastError: MaterializeContentionError | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return materializeM0(options);
        } catch (error) {
            if (!(error instanceof MaterializeContentionError)) throw error;
            lastError = error;
        }
    }
    throw new MaterializeContentionError({
        retries: maxRetries,
        reason: lastError?.reason ?? "m[0] materialization contention exhausted",
    });
}

export function renderM1(options: M0M1RenderOptions, markers: M0SnapshotMarkers): string {
    if (!markers || markers.maxCompartmentSeq === undefined) {
        throw new RenderM1InvalidMarkersError(options.sessionId);
    }

    const blocks: string[] = [];
    if (options.projectDirectory) {
        try {
            const keyFiles = buildKeyFilesBlock(
                options.db,
                options.projectDirectory,
                options.keyFiles,
            );
            if (keyFiles) blocks.push(keyFiles);
        } catch (error) {
            sessionLog(options.sessionId, "key-files render for m[1] failed:", error);
        }
    }

    const newCompartments = readNewCompartments(
        options.db,
        options.sessionId,
        markers.maxCompartmentSeq,
    );
    if (newCompartments.length > 0) {
        blocks.push(
            `<new-compartments>\n${newCompartments
                .map((compartment) => renderCompartmentAtTier(compartment, 1))
                .join("\n\n")}\n</new-compartments>`,
        );
    }

    const newMemories = readNewMemoriesForM1(
        options.db,
        options.projectPath,
        markers.maxMemoryId,
        // Freeze expiry to the materialization timestamp for defer-pass byte stability.
        markers.materializedAt,
    );
    const trimmedNewMemories = trimMemoriesToBudgetV2(
        options.sessionId,
        newMemories,
        Math.max(
            1,
            Math.floor(
                (options.memoryInjectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS) * 0.25,
            ),
        ),
    ).renderOrder;
    const newMemoriesBlock = renderMemoryBlockV2(trimmedNewMemories, "new-memories");
    if (newMemoriesBlock) blocks.push(newMemoriesBlock);

    const currentUserProfileVersion = getGlobalUserProfileVersion(options.db);
    if (currentUserProfileVersion !== markers.projectUserProfileVersion) {
        const profileBlock = renderUserProfileBlock(
            trimUserMemoriesToBudget(
                safeGetActiveUserMemories(options.db),
                Math.max(
                    1,
                    Math.floor(
                        (options.userProfileBudgetTokens ?? DEFAULT_USER_PROFILE_BUDGET_TOKENS) *
                            0.25,
                    ),
                ),
            ),
            "new-user-profile",
        );
        if (profileBlock) blocks.push(profileBlock);
    }

    // v2 faithful facts: session_facts is retired as a render source. Fresh
    // facts reach the agent as promoted memories via the new-memories block
    // above (maxMemoryId watermark), not via a <session_facts> delta here.

    if (blocks.length === 0) return M1_EMPTY_PLACEHOLDER;
    return `<session-history-since>\n${blocks.join("\n")}\n</session-history-since>`;
}

function decodeM0Bytes(bytes: Buffer | Uint8Array | null): string | null {
    if (!bytes) return null;
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
}

function prependM0M1Messages(
    sessionId: string,
    messages: MessageLike[],
    m0Text: string,
    m1Text: string,
): void {
    messages.unshift(
        {
            info: { role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: m0Text.length > 0 ? m0Text : M0_EMPTY_BODY }],
        },
        {
            info: { role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: m1Text }],
        },
    );
}

/**
 * Render a fresh m[0] from current DB state WITHOUT persisting it or taking the
 * materialize lock. Last-resort fallback for injectM0M1 when materialization
 * loses the lock (contention exhausted) AND there is no cached baseline to reuse
 * — e.g. the cache was cleared this pass by a history refresh and then a sibling
 * process held the lock. Dropping injection would send the model zero session
 * history; rendering fresh (un-cached) keeps history present for this pass while
 * the next pass re-materializes and persists. Mirrors Pi's renderM0Pi fallback.
 * Uses a plain read (no BEGIN IMMEDIATE) since we are explicitly NOT persisting.
 */
function renderFreshM0NonPersisted(options: M0M1RenderOptions): {
    m0Bytes: Buffer;
    snapshotMarkers: M0SnapshotMarkers;
} {
    const projectPath = options.projectPath;
    const projectDirectory = options.projectDirectory;
    const snapshotMarkers = readCurrentM0SnapshotMarkers({
        db: options.db,
        sessionId: options.sessionId,
        projectPath,
        projectDirectory,
    });
    const docs = projectDirectory
        ? readProjectDocsCanonical(projectDirectory)
        : { renderedBlock: "", canonicalHash: "" };
    snapshotMarkers.projectDocsHash = docs.canonicalHash;
    // CACHE STABILITY: materializedAt feeds the m[1] memory-expiry cutoff
    // (renderM1). It MUST be stable across consecutive fallback passes, or two
    // defer passes that straddle a memory's expires_at would render different
    // m[1] bytes with zero DB mutation. Never use live Date.now() here. Reuse
    // the last persisted materialization timestamp; if none exists (cache fully
    // cleared this pass), use 0 (stable: renders all memories with no expiry
    // filtering, deterministic across passes — matches Pi fallback).
    snapshotMarkers.materializedAt = options.state.cachedM0MaterializedAt ?? 0;
    const compartments = readM0Compartments(options.db, options.sessionId);
    // Use the SAME frozen cutoff for the baseline memory read as m[1] does, so a
    // memory crossing expires_at between two fallback passes can't shift the m[0]
    // baseline bytes either (live Date.now() default would reintroduce drift).
    const memories = projectPath
        ? getMemoriesByProject(
              options.db,
              projectPath,
              ["active", "permanent"],
              snapshotMarkers.materializedAt,
          )
        : [];
    const userMemories = safeGetActiveUserMemories(options.db);
    const memoryBudget = options.memoryInjectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS;
    const trimmed = trimMemoriesToBudgetV2(options.sessionId, memories, memoryBudget);
    const budget = options.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS;
    let decayPressureMultiplier = 1;
    let m0Text = renderM0({
        projectDocs: docs.renderedBlock,
        userProfileBaseline: userMemories,
        compartments,
        memories: trimmed.renderOrder,
        facts: [],
        historyBudgetTokens: budget,
        userProfileBudgetTokens: options.userProfileBudgetTokens,
        decayPressureMultiplier,
    });
    let attempts = 0;
    while (budget > 0 && historySliceTokens(m0Text) > budget * 1.05 && attempts < 3) {
        decayPressureMultiplier *= 1.15;
        m0Text = renderM0({
            projectDocs: docs.renderedBlock,
            userProfileBaseline: userMemories,
            compartments,
            memories: trimmed.renderOrder,
            facts: [],
            historyBudgetTokens: budget,
            userProfileBudgetTokens: options.userProfileBudgetTokens,
            decayPressureMultiplier,
        });
        attempts += 1;
    }
    if (m0Text.length === 0) m0Text = M0_EMPTY_BODY;
    return { m0Bytes: Buffer.from(m0Text, "utf8"), snapshotMarkers };
}

export function injectM0M1(options: M0M1RenderOptions): InjectM0M1Result {
    const skipped: InjectM0M1Result = {
        injected: false,
        m0RematerializedThisPass: false,
        materializationContentionRetryExhausted: false,
        decision: { value: false, reason: "skipped" },
        m0Bytes: options.state.cachedM0Bytes,
        m1Text: null,
    };
    if (options.state.isSubagent) return skipped;

    const decision = mustMaterialize({
        db: options.db,
        sessionId: options.sessionId,
        state: options.state,
        projectPath: options.projectPath,
        projectDirectory: options.projectDirectory,
    });
    let rematerialized = false;
    let contentionExhausted = false;

    if (decision.value) {
        try {
            const materialized = materializeWithRetry(options);
            applyMarkersToState(options.state, materialized.m0Bytes, materialized.snapshotMarkers);
            rematerialized = true;
        } catch (error) {
            if (!(error instanceof MaterializeContentionError)) throw error;
            if (options.state.cachedM0Bytes) {
                // Preferred fallback: reuse the cached baseline. A sibling process
                // mutated state mid-materialization; serving the slightly stale
                // cached m[0] this pass is correct and the next pass retries.
                contentionExhausted = true;
                options.state.snapshotMarkers =
                    options.state.snapshotMarkers ?? snapshotMarkersFromCachedM0(options.state);
                sessionLog(
                    options.sessionId,
                    `m[0] materialization contention exhausted after ${error.retries} retries; reusing cached m[0]`,
                );
            } else {
                // No cached baseline to reuse — happens when the cache was cleared
                // THIS pass (history refresh) and then hit contention. Dropping
                // injection would send the model ZERO session history, so render a
                // fresh non-persisted m[0] as a last resort (mirrors Pi
                // injectM0M1Pi). Not cached because we couldn't win the lock; the
                // next pass re-materializes and persists.
                const fresh = renderFreshM0NonPersisted(options);
                options.state.cachedM0Bytes = fresh.m0Bytes;
                options.state.snapshotMarkers = fresh.snapshotMarkers;
                contentionExhausted = true;
                sessionLog(
                    options.sessionId,
                    `m[0] materialization contention exhausted after ${error.retries} retries with no cached fallback; rendered fresh non-persisted m[0]`,
                );
            }
        }
    } else {
        options.state.snapshotMarkers =
            options.state.snapshotMarkers ?? snapshotMarkersFromCachedM0(options.state);
    }

    if (!options.state.cachedM0Bytes || !options.state.snapshotMarkers) {
        throw new RenderM1InvalidMarkersError(options.sessionId);
    }

    let m0Text = decodeM0Bytes(options.state.cachedM0Bytes) ?? M0_EMPTY_BODY;
    let m1Text = renderM1(options, options.state.snapshotMarkers);

    // Forced +15% drift refold (spec ARCHITECTURE.md: "A forced refold also
    // fires at +15% budget drift if no natural hard bust occurred"). When m[1]
    // has drifted past 15% of m[0]'s size without a materialization this pass,
    // fold the accumulated delta into a fresh m[0] baseline so the volatile
    // block doesn't grow unbounded between hard busts. Skipped when contention
    // exhausted (we're already reusing a cached m[0] and must not thrash).
    if (
        !rematerialized &&
        !contentionExhausted &&
        m0Text.length > 0 &&
        // Only refold on GENUINE accumulated delta — never when m[1] is just the
        // empty placeholder. Otherwise a tiny baseline (near-empty session) would
        // see placeholder > m0*0.15 and refold every defer pass, breaking the
        // byte-identical-defer cache invariant.
        m1Text !== M1_EMPTY_PLACEHOLDER &&
        m1Text.length > m0Text.length * 0.15
    ) {
        try {
            const refolded = materializeWithRetry(options);
            applyMarkersToState(options.state, refolded.m0Bytes, refolded.snapshotMarkers);
            rematerialized = true;
            m0Text = decodeM0Bytes(options.state.cachedM0Bytes) ?? M0_EMPTY_BODY;
            m1Text = renderM1(options, options.state.snapshotMarkers);
        } catch (error) {
            // Contention during the drift refold is non-fatal: keep the current
            // (un-refolded) m[0]/m[1]; the next pass retries the fold.
            if (!(error instanceof MaterializeContentionError)) throw error;
        }
    }

    if (options.messages) {
        prependM0M1Messages(options.sessionId, options.messages, m0Text, m1Text);
    }

    return {
        injected: true,
        m0RematerializedThisPass: rematerialized,
        materializationContentionRetryExhausted: contentionExhausted,
        decision,
        m0Bytes: options.state.cachedM0Bytes,
        m1Text,
    };
}
