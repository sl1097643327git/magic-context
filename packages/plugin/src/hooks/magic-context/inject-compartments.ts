import { Buffer } from "node:buffer";
import {
    buildCompartmentBlock,
    type Compartment,
    type CompartmentDateRanges,
    escapeXmlAttr,
    escapeXmlContent,
    getCompartments,
    getSessionFacts,
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
    const facts = getSessionFacts(db, sessionId);

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

type M0Compartment = Compartment & {
    importance: number;
    legacy: number;
};

const DEFAULT_HISTORY_BUDGET_TOKENS = 60_000;
const DEFAULT_MEMORY_BUDGET_TOKENS = 8_000;
const DEFAULT_USER_PROFILE_BUDGET_TOKENS = 4_000;
const M0_EMPTY_BODY = "<session-history></session-history>";
const M1_EMPTY_PLACEHOLDER =
    "<session-history-since>(no new content since last materialization)</session-history-since>";

const maxCompartmentSeqStatements = new WeakMap<Database, PreparedStatement>();
const maxMemoryIdStatements = new WeakMap<Database, PreparedStatement>();
const sessionFactsVersionStatements = new WeakMap<Database, PreparedStatement>();
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

function getSessionFactsVersion(db: Database, sessionId: string): number {
    try {
        const row = cachedStatement(
            sessionFactsVersionStatements,
            db,
            "SELECT COALESCE(session_facts_version, 0) AS version FROM session_meta WHERE session_id = ?",
        ).get(sessionId);
        return numberFromRow(row, "version");
    } catch (error) {
        if (String(error).includes("session_facts_version")) return 0;
        throw error;
    }
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
    if (args.state.cachedM0MaxMemoryId !== current.maxMemoryId) {
        return { value: true, reason: "max_memory_id" };
    }
    if (args.state.cachedM0MaxMutationId !== current.maxMutationId) {
        return { value: true, reason: "max_mutation_id" };
    }
    if ((args.state.cachedM0ProjectDocsHash ?? "") !== current.projectDocsHash) {
        return { value: true, reason: "project_docs_hash" };
    }
    if (args.state.cachedM0SessionFactsVersion !== current.sessionFactsVersion) {
        return { value: true, reason: "session_facts_version" };
    }
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
    let usedTokens = 0;
    for (const memory of selectionOrder) {
        const memoryTokens = estimateTokens(`- ${memory.content}`) + 6;
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

function trimUserMemoriesToBudget(memories: UserMemory[], budgetTokens: number): UserMemory[] {
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
                end_message_id, title, content, created_at, importance, legacy
           FROM compartments
          WHERE session_id = ?
          ORDER BY sequence ASC`,
    ).all(sessionId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
        id: Number(row.id ?? 0),
        sessionId: String(row.session_id ?? sessionId),
        sequence: Number(row.sequence ?? 0),
        startMessage: Number(row.start_message ?? 0),
        endMessage: Number(row.end_message ?? 0),
        startMessageId: String(row.start_message_id ?? ""),
        endMessageId: String(row.end_message_id ?? ""),
        title: String(row.title ?? ""),
        content: String(row.content ?? ""),
        createdAt: Number(row.created_at ?? 0),
        importance: Number(row.importance ?? 50),
        legacy: Number(row.legacy ?? 0),
    }));
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
                end_message_id, title, content, created_at, importance, legacy
           FROM compartments
          WHERE session_id = ? AND sequence > ?
          ORDER BY sequence ASC`,
    ).all(sessionId, afterSequence) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
        id: Number(row.id ?? 0),
        sessionId: String(row.session_id ?? sessionId),
        sequence: Number(row.sequence ?? 0),
        startMessage: Number(row.start_message ?? 0),
        endMessage: Number(row.end_message ?? 0),
        startMessageId: String(row.start_message_id ?? ""),
        endMessageId: String(row.end_message_id ?? ""),
        title: String(row.title ?? ""),
        content: String(row.content ?? ""),
        createdAt: Number(row.created_at ?? 0),
        importance: Number(row.importance ?? 50),
        legacy: Number(row.legacy ?? 0),
    }));
}

function readNewMemoriesForM1(
    db: Database,
    projectPath: string | undefined,
    afterId: number,
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
        .all(projectPath, afterId, Date.now())
        .filter(isMemoryRow);
    return rows.map((row) => ({ ...row }));
}

function renderMemoryBlockV2(memories: Memory[], wrapper = "project-memory"): string {
    if (memories.length === 0) return "";
    const lines = [`<${wrapper}>`];
    for (const memory of memories) {
        lines.push(
            `  <memory id="${memory.id}" category="${escapeXmlAttr(memory.category)}" importance="${memory.importance ?? 50}">${escapeXmlContent(memory.content)}</memory>`,
        );
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

function renderFactsBlock(facts: SessionFact[], wrapper = "session_facts"): string {
    if (facts.length === 0) return "";
    const lines = [`<${wrapper}>`];
    for (const fact of facts) {
        lines.push(
            `  <fact category="${escapeXmlAttr(fact.category)}">${escapeXmlContent(fact.content)}</fact>`,
        );
    }
    lines.push(`</${wrapper}>`);
    return lines.join("\n");
}

function bodyForTier(content: string, tier: number): string {
    if (tier <= 1) return content;
    if (tier === 2)
        return content.length > 1_200 ? `${content.slice(0, 1_200).trimEnd()}…` : content;
    return content.length > 420 ? `${content.slice(0, 420).trimEnd()}…` : content;
}

function legacyTier(compartment: M0Compartment): number {
    return /^U:/m.test(compartment.content) ? 3 : 4;
}

function initialTier(
    compartment: M0Compartment,
    index: number,
    total: number,
    pressure: number,
): number {
    if (compartment.legacy === 1) return legacyTier(compartment);
    const age = total - index - 1;
    const importance = Math.max(1, Math.min(100, compartment.importance || 50));
    const halfLife = 2 + importance / 20;
    return Math.max(1, Math.min(4, 1 + Math.floor((age * pressure) / halfLife)));
}

function renderOneCompartment(compartment: M0Compartment, tier: number): string {
    const baseAttrs = `start="${compartment.startMessage}" end="${compartment.endMessage}" title="${escapeXmlAttr(compartment.title)}"`;
    if (tier >= 5) return "";
    if (tier === 4) return `<compartment ${baseAttrs} />`;
    return [
        `<compartment ${baseAttrs}>`,
        escapeXmlContent(bodyForTier(compartment.content, tier)),
        "</compartment>",
    ].join("\n");
}

function renderSessionHistoryWithDecay(args: {
    compartments: M0Compartment[];
    facts: SessionFact[];
    historyBudgetTokens: number;
    pressure: number;
}): string {
    const tiers = args.compartments.map((compartment, index) =>
        initialTier(compartment, index, args.compartments.length, args.pressure),
    );

    const render = (): string => {
        const parts: string[] = [];
        for (let i = 0; i < args.compartments.length; i++) {
            const rendered = renderOneCompartment(args.compartments[i], tiers[i]);
            if (rendered.length > 0) parts.push(rendered);
        }
        const factsBlock = renderFactsBlock(args.facts);
        if (factsBlock) parts.push(factsBlock);
        return parts.join("\n\n");
    };

    let body = render();
    let guard = args.compartments.length * 5;
    while (
        args.historyBudgetTokens > 0 &&
        estimateTokens(body) > args.historyBudgetTokens &&
        guard > 0
    ) {
        let demoted = false;
        for (let i = 0; i < tiers.length; i++) {
            if (tiers[i] < 5) {
                tiers[i] += 1;
                demoted = true;
                break;
            }
        }
        if (!demoted) break;
        body = render();
        guard -= 1;
    }
    return body;
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

    const sessionHistory = renderSessionHistoryWithDecay({
        compartments: args.compartments,
        facts: args.facts,
        historyBudgetTokens: args.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS,
        pressure: args.decayPressureMultiplier ?? 1,
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
        facts = getSessionFacts(options.db, options.sessionId);
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
    while (budget > 0 && estimateTokens(m0Text) > budget * 1.05 && attempts < 3) {
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
        const stale =
            current.projectMemoryEpoch !== snapshotMarkers.projectMemoryEpoch ||
            current.projectUserProfileVersion !== snapshotMarkers.projectUserProfileVersion ||
            current.maxCompartmentSeq !== snapshotMarkers.maxCompartmentSeq ||
            current.maxMemoryId !== snapshotMarkers.maxMemoryId ||
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
                .map((compartment) => renderOneCompartment(compartment, 1))
                .join("\n\n")}\n</new-compartments>`,
        );
    }

    const newMemories = readNewMemoriesForM1(options.db, options.projectPath, markers.maxMemoryId);
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

    const currentFactsVersion = getSessionFactsVersion(options.db, options.sessionId);
    if (currentFactsVersion !== markers.sessionFactsVersion) {
        const factsBlock = renderFactsBlock(getSessionFacts(options.db, options.sessionId));
        if (factsBlock) blocks.push(factsBlock);
    }

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
            if (error instanceof MaterializeContentionError && options.state.cachedM0Bytes) {
                contentionExhausted = true;
                options.state.snapshotMarkers =
                    options.state.snapshotMarkers ?? snapshotMarkersFromCachedM0(options.state);
                sessionLog(
                    options.sessionId,
                    `m[0] materialization contention exhausted after ${error.retries} retries; reusing cached m[0]`,
                );
            } else {
                throw error;
            }
        }
    } else {
        options.state.snapshotMarkers =
            options.state.snapshotMarkers ?? snapshotMarkersFromCachedM0(options.state);
    }

    if (!options.state.cachedM0Bytes || !options.state.snapshotMarkers) {
        throw new RenderM1InvalidMarkersError(options.sessionId);
    }

    const m0Text = decodeM0Bytes(options.state.cachedM0Bytes) ?? M0_EMPTY_BODY;
    const m1Text = renderM1(options, options.state.snapshotMarkers);
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
