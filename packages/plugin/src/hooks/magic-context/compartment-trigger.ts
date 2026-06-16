import {
    getLastCompartmentEndMessage,
    getLastCompartmentEndMessageId,
} from "../../features/magic-context/compartment-storage";
import {
    getActiveTagsBySession,
    getPendingOps,
    getTriggerTagTokenUpperBound,
    loadProtectedTailMeta,
} from "../../features/magic-context/storage";
import type { ContextUsage, SessionMeta, TagEntry } from "../../features/magic-context/types";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    createDefaultBoundarySnapshotForTests,
    getRawHistoryEligibility,
    hasRunnableCompartmentWindow,
    type ProtectedTailBoundarySnapshot,
    resolveOpenCodeProtectedTailBoundary,
} from "./protected-tail-boundary";
import {
    primeInMemoryTailRawMessageCache,
    primeTailRawMessageCache,
    readSessionChunk,
    withRawSessionMessageCache,
} from "./read-session-chunk";
import {
    buildInMemoryTailRawMessages,
    type InMemoryMessageView,
    type RawMessage,
} from "./read-session-raw";

const PROACTIVE_TRIGGER_OFFSET_PERCENTAGE = 2;
const POST_DROP_TARGET_RATIO = 0.75;
const MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE = 6_000;
const MIN_PROACTIVE_TAIL_MESSAGE_COUNT = 12;
const DEFAULT_MIN_COMMIT_CLUSTERS_FOR_TRIGGER = 3;
const TAIL_SIZE_TRIGGER_MULTIPLIER = 3;
const FORCE_COMPARTMENT_PERCENTAGE = 80;
const BLOCK_UNTIL_DONE_PERCENTAGE = 95;
const FORCE_MATERIALIZE_PERCENTAGE = 85;

export {
    BLOCK_UNTIL_DONE_PERCENTAGE,
    FORCE_COMPARTMENT_PERCENTAGE,
    FORCE_MATERIALIZE_PERCENTAGE,
    POST_DROP_TARGET_RATIO,
};

export interface CompartmentTriggerResult {
    shouldFire: boolean;
    reason?: "projected_headroom" | "force_80" | "commit_clusters" | "tail_size";
    /**
     * The protected-tail boundary snapshot the decision was computed from.
     * Present whenever the tail inspection ran. Callers that start the
     * historian in the SAME pass (transform path) should hand this to
     * runCompartmentPhase so it doesn't re-resolve the boundary — one
     * resolution per pass, and the historian sees exactly the snapshot the
     * decision saw.
     */
    boundarySnapshot?: ProtectedTailBoundarySnapshot;
}

/**
 * In-memory tail source for the trigger — the transform's `args.messages`
 * converted to absolute-ordinal RawMessages (via `buildInMemoryTailRawMessages`
 * with `anchorFound=true`). When supplied, the tail inspection primes the
 * raw-message cache from memory and performs ZERO opencode.db reads on the hot
 * path. Callers must only pass an ANCHORED conversion — an unanchored one has
 * assumed ordinals; leave it undefined to fall through to the DB-primed path.
 */
export interface InMemoryTailSource {
    messages: RawMessage[];
    absoluteMessageCount: number;
}

/**
 * Convert the transform's in-memory `args.messages` into a trigger tail source,
 * applying the anchored-only gate:
 *
 * - Compartments exist + boundary has a message id → require the anchor to be
 *   FOUND in the array (`anchorFound`). OpenCode's `filterCompacted` stops at
 *   our compaction marker (the boundary message), so the anchor is normally the
 *   array head; when the marker drain lags, the anchor sits a few messages in
 *   and the converter drops the already-compartmentalized prefix. If it isn't
 *   present at all (deleted, or the marker advanced past it), ordinal
 *   assignment would be an unverified guess → return undefined so the caller
 *   falls through to the DB-primed read.
 * - Compartments exist but the boundary row has NO message id (legacy rows) →
 *   undefined (DB path, as before).
 * - No compartments (#132 early-session) → the whole array is the session;
 *   ordinals from 1, no anchor needed.
 *
 * Live-verified byte-identical to the DB path on every boundary decision field
 * (offset, protectedTailStart, eligibleEndOrdinal, N, trueRawEligibleTokens,
 * arc fencing) across real sessions before the cutover.
 */
export function buildTriggerInMemoryTail(
    db: Database,
    sessionId: string,
    messages: readonly InMemoryMessageView[],
): InMemoryTailSource | undefined {
    if (messages.length === 0) return undefined;
    const lastCompartmentEnd = getLastCompartmentEndMessage(db, sessionId);
    const anchorMessageId = getLastCompartmentEndMessageId(db, sessionId);
    if (lastCompartmentEnd >= 1 && !anchorMessageId) return undefined;

    const built = buildInMemoryTailRawMessages({
        messages,
        lastCompartmentEnd,
        anchorMessageId,
    });
    if (!built) return undefined;
    if (lastCompartmentEnd >= 1 && anchorMessageId && !built.anchorFound) return undefined;
    return { messages: built.messages, absoluteMessageCount: built.absoluteMessageCount };
}

export function getProactiveCompartmentTriggerPercentage(
    executeThresholdPercentage: number,
): number {
    return Math.max(0, executeThresholdPercentage - PROACTIVE_TRIGGER_OFFSET_PERCENTAGE);
}

function estimateProjectedPostDropPercentage(
    db: Database,
    sessionId: string,
    usage: ContextUsage,
    activeTags: readonly TagEntry[],
    clearReasoningAge?: number,
    clearedReasoningThroughTag?: number,
): number | null {
    // Denominator must include both text/tool bytes and reasoning bytes to match the numerator
    const totalActiveBytes = activeTags.reduce(
        (sum, tag) => sum + tag.byteSize + tag.reasoningByteSize,
        0,
    );
    if (totalActiveBytes === 0) return null;

    let droppableBytes = 0;

    // 1. Pending user-queued drops (from ctx_reduce) — include both text and reasoning bytes
    //    because dropping a message tag also clears its associated reasoning parts
    const pendingDrops = getPendingOps(db, sessionId).filter((op) => op.operation === "drop");
    const pendingDropTagIds = new Set(pendingDrops.map((op) => op.tagId));
    if (pendingDrops.length > 0) {
        droppableBytes += activeTags
            .filter((tag) => pendingDropTagIds.has(tag.tagNumber))
            .reduce((sum, tag) => sum + tag.byteSize + tag.reasoningByteSize, 0);
    }

    // 2. Reasoning clearing: reasoning bytes on message tags between watermark and age cutoff.
    //    (Phase 2 removed routine age-based tool drops — tool outputs are no longer
    //    projected as droppable here. The tiered emergency drop fires only at ≥85%,
    //    which is above this trigger's window, so it is intentionally not modeled.)
    const maxTag = activeTags.reduce((max, t) => Math.max(max, t.tagNumber), 0);
    if (clearReasoningAge !== undefined && clearedReasoningThroughTag !== undefined) {
        const reasoningAgeCutoff = maxTag - clearReasoningAge;
        for (const tag of activeTags) {
            if (tag.type !== "message") continue;
            // Skip tags already fully counted in pending drops (text + reasoning)
            if (pendingDropTagIds.has(tag.tagNumber)) continue;
            // Only count reasoning not yet cleared (between watermark and age cutoff)
            if (tag.tagNumber <= clearedReasoningThroughTag) continue;
            if (tag.tagNumber > reasoningAgeCutoff) continue;
            if (tag.reasoningByteSize > 0) {
                droppableBytes += tag.reasoningByteSize;
            }
        }
    }

    if (droppableBytes === 0) return null;

    const dropRatio = Math.min(droppableBytes / totalActiveBytes, 1);
    return usage.percentage * (1 - dropRatio);
}

interface TailInfo {
    nextStartOrdinal: number;
    hasNewRawHistory: boolean;
    hasProtectedEligibleHead: boolean;
    isMeaningful: boolean;
    tokenEstimate: number;
    /**
     * True when the TC chunk scan exhausted its token budget before reaching
     * the end of the eligible head — i.e. the chunked (U:/A:/TC:) content
     * exceeds the scan budget. `tokenEstimate` saturates at the scan budget
     * (the reader stops appending blocks at the cap), so THIS is the signal
     * that the narratable content crossed the tail_size threshold.
     */
    chunkHasMore: boolean;
    trueRawEligibleTokens: number;
    commitClusterCount: number;
    boundarySnapshot?: ProtectedTailBoundarySnapshot;
}

const TAIL_INFO_DEFAULTS: TailInfo = {
    nextStartOrdinal: 1,
    hasNewRawHistory: false,
    hasProtectedEligibleHead: false,
    isMeaningful: false,
    tokenEstimate: 0,
    chunkHasMore: false,
    trueRawEligibleTokens: 0,
    commitClusterCount: 0,
};

function resolveBoundaryContextLimit(usage: ContextUsage, fallbackContextLimit?: number): number {
    if (fallbackContextLimit && fallbackContextLimit > 0) return fallbackContextLimit;
    if (usage.percentage > 0 && usage.inputTokens > 0) {
        return Math.max(1, Math.round(usage.inputTokens / (usage.percentage / 100)));
    }
    return 128_000;
}

function getUnsummarizedTailInfo(
    db: Database,
    sessionId: string,
    triggerBudget: number,
    usage: ContextUsage,
    executeThresholdPercentage: number,
    contextLimit?: number,
    inMemoryTail?: InMemoryTailSource,
): TailInfo {
    return withRawSessionMessageCache(() => {
        try {
            // Prime the scoped cache from MEMORY when the transform supplied its
            // own `args.messages` tail (live-verified byte-identical to the DB
            // read on every boundary decision field) — zero opencode.db reads.
            // Otherwise prime with the TAIL-ONLY DB read so the boundary
            // resolution and chunk scan below read only messages after the last
            // compartment — never the whole session (the O(session) read that
            // froze the JS event loop ~3s on a large session and made every
            // parallel tool.definition hook measure multi-second durations). The
            // boundary math is offset-forward only, so a tail slice anchored at
            // lastCompartmentEnd+1 yields an identical trigger decision. Skipped
            // (full read) when the protected-tail policy hasn't migrated to v3
            // yet, because the one-time v3 seed (getLegacyProtectedTailStartOrdinal)
            // scans ALL user-message parts; once seeded it never runs again.
            // No-op for Pi (provider-backed) and in test/no-DB environments, and
            // when no usable boundary anchor exists (falls through to full read).
            const memoryPrimed = inMemoryTail
                ? primeInMemoryTailRawMessageCache({
                      sessionId,
                      messages: inMemoryTail.messages,
                      absoluteMessageCount: inMemoryTail.absoluteMessageCount,
                  })
                : false;
            if (!memoryPrimed) {
                const policyVersion = loadProtectedTailMeta(
                    db,
                    sessionId,
                ).protectedTailPolicyVersion;
                if (policyVersion >= 3) {
                    primeTailRawMessageCache({
                        sessionId,
                        lastCompartmentEnd: getLastCompartmentEndMessage(db, sessionId),
                        anchorMessageId: getLastCompartmentEndMessageId(db, sessionId),
                    });
                }
            }

            const rawEligibility = getRawHistoryEligibility(db, sessionId);
            if (!rawEligibility.hasRawBeyondLastCompartment) {
                return { ...TAIL_INFO_DEFAULTS, nextStartOrdinal: rawEligibility.offset };
            }

            const boundary =
                process.env.NODE_ENV === "test"
                    ? createDefaultBoundarySnapshotForTests(sessionId)
                    : resolveOpenCodeProtectedTailBoundary({
                          db,
                          sessionId,
                          mode: "trigger",
                          contextLimit: resolveBoundaryContextLimit(usage, contextLimit),
                          executeThresholdPercentage,
                          usage,
                          usageSource: "live",
                      });
            const hasProtectedEligibleHead = boundary.offset < boundary.protectedTailStart;

            if (!hasProtectedEligibleHead) {
                return {
                    ...TAIL_INFO_DEFAULTS,
                    nextStartOrdinal: rawEligibility.offset,
                    hasNewRawHistory: true,
                    boundarySnapshot: boundary,
                };
            }

            const scanBudget = Math.max(
                MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE,
                triggerBudget * TAIL_SIZE_TRIGGER_MULTIPLIER,
            );
            const chunk = readSessionChunk(
                sessionId,
                scanBudget,
                rawEligibility.offset,
                boundary.protectedTailStart,
            );
            const isMeaningful =
                chunk.hasMore ||
                boundary.trueRawEligibleTokens >= MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE ||
                chunk.tokenEstimate >= MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE ||
                chunk.messageCount >= MIN_PROACTIVE_TAIL_MESSAGE_COUNT;

            return {
                nextStartOrdinal: rawEligibility.offset,
                hasNewRawHistory: true,
                hasProtectedEligibleHead,
                isMeaningful,
                tokenEstimate: chunk.tokenEstimate,
                chunkHasMore: chunk.hasMore,
                trueRawEligibleTokens: boundary.trueRawEligibleTokens,
                commitClusterCount: chunk.commitClusterCount,
                boundarySnapshot: boundary,
            };
        } catch (error) {
            sessionLog(sessionId, "compartment trigger: raw tail inspection failed:", error);
            return TAIL_INFO_DEFAULTS;
        }
    });
}

export function checkCompartmentTrigger(
    db: Database,
    sessionId: string,
    sessionMeta: SessionMeta,
    usage: ContextUsage,
    _previousPercentage: number,
    executeThresholdPercentage: number,
    triggerBudget: number,
    clearReasoningAge?: number,
    commitClusterTrigger?: { enabled: boolean; min_clusters: number },
    preloadedActiveTags?: readonly TagEntry[],
    contextLimit?: number,
    inMemoryTail?: InMemoryTailSource,
): CompartmentTriggerResult {
    if (sessionMeta.compartmentInProgress) {
        sessionLog(
            sessionId,
            `compartment trigger: skipped — historian already in progress (usage=${usage.percentage.toFixed(1)}%)`,
        );
        return { shouldFire: false };
    }

    // The in-memory tail is only usable AFTER the one-time v3 protected-tail
    // policy seed: the legacy seed (getLegacyProtectedTailStartOrdinal) must
    // scan ALL user messages of the session, which a tail slice cannot provide.
    // Mirror the DB tail-prime's gate — before the seed, fall through to the
    // full DB read (which runs the seed once); afterwards (policyVersion >= 3,
    // the steady state) the in-memory path applies. Live-capture verified: the
    // only migrationFloor divergences were on un-seeded sessions.
    if (inMemoryTail) {
        try {
            const policyVersion = loadProtectedTailMeta(db, sessionId).protectedTailPolicyVersion;
            if (policyVersion < 3) inMemoryTail = undefined;
        } catch {
            inMemoryTail = undefined;
        }
    }

    // Cheap pre-gate (avoids the full-session raw read on every message.updated).
    //
    // getUnsummarizedTailInfo's very first step reads + parses the ENTIRE raw
    // session (getRawHistoryEligibility → readRawSessionMessages) to resolve the
    // protected-tail boundary — ~3s of synchronous SQLite on a 50k-message
    // session, which freezes the whole JS event loop and is what makes every
    // parallel `tool.definition` hook measure multi-second durations. But below
    // the proactive floor, the ONLY triggers that can fire are the size-based
    // ones (commit_clusters needs eligible TC-tokens ≥ triggerBudget; tail_size
    // needs true-raw eligible ≥ triggerBudget×MULT). The active-tag token sum is
    // a cheap, conservative UPPER BOUND on the eligible-tail tokens (eligible ⊆
    // the post-compaction live tail covered by active tags; any pre-boundary
    // still-active tag only inflates it), so if even that bound is below the
    // smallest size-trigger floor, neither size trigger can possibly fire and we
    // can skip the expensive read entirely. Only trust the bound when the tag
    // store is fully backfilled (nullCount === 0); a cold/partial store
    // undercounts and could wrongly bail, so we fall through to the
    // authoritative path until the next pass backfills it.
    const proactiveFloorForGate = getProactiveCompartmentTriggerPercentage(
        executeThresholdPercentage,
    );
    // The pre-gate exists ONLY to avoid the expensive DB read; with an
    // in-memory tail the inspection is cheap, and the tag-aggregate bound can
    // under-count the newest not-yet-tagged messages (the transform trigger
    // runs BEFORE tagging) — skipping it here avoids wrongly suppressing a
    // size trigger at the budget edge.
    if (!inMemoryTail && usage.percentage < proactiveFloorForGate) {
        try {
            // Bound must include DROPPED tags: ctx_reduce/emergency drops
            // remove tool output from the wire but the raw content still
            // counts toward the historian's true-raw chunk size — an
            // active-only bound undercounts after drops and suppresses real
            // tail-size triggers.
            const { bound, nullCount } = getTriggerTagTokenUpperBound(db, sessionId);
            if (nullCount === 0) {
                const eligibleUpperBound = bound;
                // Smallest token floor any size trigger needs is triggerBudget
                // (commit_clusters). tail_size needs even more. If the upper
                // bound is under it, neither can fire.
                if (eligibleUpperBound < triggerBudget) {
                    sessionLog(
                        sessionId,
                        `compartment trigger: cheap-skip at ${usage.percentage.toFixed(1)}% (below proactive floor ${proactiveFloorForGate}%) — live-tail upper bound ${eligibleUpperBound} < triggerBudget ${triggerBudget}; no size trigger possible, skipped full raw read`,
                    );
                    return { shouldFire: false };
                }
            }
        } catch (error) {
            // Best-effort gate: any failure falls through to the authoritative
            // (expensive) path, never changing behavior — only its cost.
            sessionLog(
                sessionId,
                `compartment trigger: cheap-gate skipped (falling through to full read): ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    const tailInfo = getUnsummarizedTailInfo(
        db,
        sessionId,
        triggerBudget,
        usage,
        executeThresholdPercentage,
        contextLimit,
        inMemoryTail,
    );
    if (!tailInfo.hasNewRawHistory) {
        // Diagnostic data collection is best-effort. The helpers can throw if
        // the OpenCode session DB is unavailable (e.g. in unit-test env or
        // when the harness has not yet wired a RawMessageProvider). A throw
        // here would propagate to the caller's try/catch and prevent
        // downstream state updates (e.g. session-meta writes in event-handler
        // line 542). Swallow any failure and log without the diagnostic
        // fields so callers see no behavioral change.
        try {
            const lastCompartmentEnd = getLastCompartmentEndMessage(db, sessionId);
            sessionLog(
                sessionId,
                `compartment trigger: skipped — no new raw history (usage=${usage.percentage.toFixed(1)}% nextStartOrdinal=${tailInfo.nextStartOrdinal} lastCompartmentEnd=${lastCompartmentEnd})`,
            );
        } catch (error) {
            sessionLog(
                sessionId,
                `compartment trigger: skipped — no new raw history (usage=${usage.percentage.toFixed(1)}% nextStartOrdinal=${tailInfo.nextStartOrdinal} diagnostic-collection-failed: ${error instanceof Error ? error.message : String(error)})`,
            );
        }
        return { shouldFire: false };
    }

    const projectedPostDropPercentage = estimateProjectedPostDropPercentage(
        db,
        sessionId,
        usage,
        preloadedActiveTags ?? getActiveTagsBySession(db, sessionId),
        clearReasoningAge,
        sessionMeta.clearedReasoningThroughTag,
    );
    const relativePostDropTarget = executeThresholdPercentage * POST_DROP_TARGET_RATIO;

    // Force at 80% — only skip if drops alone bring usage well below the relative target
    if (usage.percentage >= FORCE_COMPARTMENT_PERCENTAGE) {
        if (
            projectedPostDropPercentage !== null &&
            projectedPostDropPercentage <= relativePostDropTarget
        ) {
            sessionLog(
                sessionId,
                `compartment trigger: skipping force-${FORCE_COMPARTMENT_PERCENTAGE} because projected post-drop usage is ${projectedPostDropPercentage.toFixed(1)}% (target ${relativePostDropTarget.toFixed(1)}%)`,
            );
            return { shouldFire: false };
        }

        sessionLog(
            sessionId,
            `compartment trigger: force-firing at ${usage.percentage.toFixed(1)}% (projected post-drop ${projectedPostDropPercentage?.toFixed(1) ?? "none"}%)`,
        );
        if (tailInfo.boundarySnapshot && hasRunnableCompartmentWindow(tailInfo.boundarySnapshot)) {
            return {
                shouldFire: true,
                reason: "force_80",
                boundarySnapshot: tailInfo.boundarySnapshot,
            };
        }
        const scale = usage.percentage >= BLOCK_UNTIL_DONE_PERCENTAGE ? 0.25 : 0.5;
        // Scaled re-resolution must read from the same source as the primary
        // inspection: prime from the in-memory tail when supplied (zero DB
        // reads), otherwise this rare ≥80% path does its own full read as before.
        const scaledBoundary = withRawSessionMessageCache(() => {
            if (inMemoryTail) {
                primeInMemoryTailRawMessageCache({
                    sessionId,
                    messages: inMemoryTail.messages,
                    absoluteMessageCount: inMemoryTail.absoluteMessageCount,
                });
            }
            return resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: resolveBoundaryContextLimit(usage, contextLimit),
                executeThresholdPercentage,
                usage,
                usageSource: "live",
                emergencyTailScale: scale,
            });
        });
        if (hasRunnableCompartmentWindow(scaledBoundary)) {
            return { shouldFire: true, reason: "force_80", boundarySnapshot: scaledBoundary };
        }
        sessionLog(
            sessionId,
            "compartment trigger: force_80 skipped — raw exists but protected head genuinely empty after emergency tail scale",
        );
        return { shouldFire: false };
    }

    // Commit-cluster trigger: N+ distinct work phases with commits, enough token volume
    const clusterEnabled = commitClusterTrigger?.enabled ?? true;
    const minClusters =
        commitClusterTrigger?.min_clusters ?? DEFAULT_MIN_COMMIT_CLUSTERS_FOR_TRIGGER;
    if (
        clusterEnabled &&
        tailInfo.commitClusterCount >= minClusters &&
        tailInfo.tokenEstimate >= triggerBudget
    ) {
        sessionLog(
            sessionId,
            `compartment trigger: commit-cluster fire — ${tailInfo.commitClusterCount} clusters (min=${minClusters}), ~${tailInfo.tokenEstimate} tokens in eligible prefix`,
        );
        return {
            shouldFire: true,
            reason: "commit_clusters",
            boundarySnapshot: tailInfo.boundarySnapshot,
        };
    }

    // Tail-size trigger: enough NARRATABLE material accumulated, regardless of
    // pressure or commits. Measured on the TC-chunked estimate (U:/A:/TC:
    // lines — what the historian actually condenses), NOT true-raw. NOTE: this
    // is a deliberate two-axis split, do not re-unify. True-raw (tool outputs
    // included) is the axis for the BOUNDARY and the pressure paths, because
    // it measures wire occupancy. But firing tail_size on true-raw made
    // tool-heavy sessions fire at 25% usage on a few file reads — each run
    // narrating ~700 tokens of content into a confetti compartment (observed
    // live: spans degraded 155 → 27 messages/compartment over one session).
    // Under no pressure the agent is managing its own context (drops working);
    // the historian shouldn't spawn until there's enough chunked data to make
    // a properly-sized compartment. Tool-heavy-but-thin tails are covered by
    // the pressure paths (proactive floor / force_80), which fire on occupancy.
    // The chunk scan budget IS the threshold (scanBudget = max(min-estimate,
    // budget×multiplier)), so tokenEstimate saturates at the cap — "≥ cap OR
    // the scan ran out of budget with more blocks remaining" is the complete
    // crossed-the-threshold signal.
    if (
        tailInfo.tokenEstimate >= triggerBudget * TAIL_SIZE_TRIGGER_MULTIPLIER ||
        (tailInfo.chunkHasMore && tailInfo.tokenEstimate > 0)
    ) {
        sessionLog(
            sessionId,
            `compartment trigger: tail-size fire — ~${tailInfo.tokenEstimate} TC-chunked tokens (hasMore=${tailInfo.chunkHasMore}, true-raw ~${tailInfo.trueRawEligibleTokens}) exceeds ${triggerBudget * TAIL_SIZE_TRIGGER_MULTIPLIER} budget threshold`,
        );
        return {
            shouldFire: true,
            reason: "tail_size",
            boundarySnapshot: tailInfo.boundarySnapshot,
        };
    }

    // Pressure-driven trigger: context is near threshold and drops aren't enough
    const proactiveTriggerPercentage = getProactiveCompartmentTriggerPercentage(
        executeThresholdPercentage,
    );
    if (usage.percentage < proactiveTriggerPercentage) {
        sessionLog(
            sessionId,
            `compartment trigger: not firing at ${usage.percentage.toFixed(1)}% — below proactive floor (${proactiveTriggerPercentage}%)`,
        );
        return { shouldFire: false };
    }

    if (
        projectedPostDropPercentage !== null &&
        projectedPostDropPercentage <= relativePostDropTarget
    ) {
        sessionLog(
            sessionId,
            `compartment trigger: not firing at ${usage.percentage.toFixed(1)}% because projected post-drop usage is ${projectedPostDropPercentage.toFixed(1)}% (target ${relativePostDropTarget.toFixed(1)}%)`,
        );
        return { shouldFire: false };
    }

    if (!tailInfo.hasProtectedEligibleHead || !tailInfo.isMeaningful) {
        sessionLog(
            sessionId,
            `compartment trigger: not firing at ${usage.percentage.toFixed(1)}% because unsummarized tail from ${tailInfo.nextStartOrdinal} is too small`,
        );
        return { shouldFire: false };
    }

    sessionLog(
        sessionId,
        `compartment trigger: proactive fire at ${usage.percentage.toFixed(1)}% (floor=${proactiveTriggerPercentage}% projected post-drop=${projectedPostDropPercentage?.toFixed(1) ?? "none"}% target=${relativePostDropTarget.toFixed(1)}%)`,
    );
    return {
        shouldFire: true,
        reason: "projected_headroom",
        boundarySnapshot: tailInfo.boundarySnapshot,
    };
}
