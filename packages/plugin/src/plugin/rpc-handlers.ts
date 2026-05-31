/**
 * Server-side RPC handlers. Queries the server's own SQLite DB
 * and returns typed responses for TUI consumption.
 */
import type { MagicContextConfig } from "../config/schema/magic-context";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import { getMemoriesByProject } from "../features/magic-context/memory/storage-memory";
import { type ContextDatabase as Database, openDatabase } from "../features/magic-context/storage";
import { getMeasuredToolDefinitionTokens } from "../features/magic-context/tool-definition-tokens";
import {
    resolveContextLimit,
    resolveExecuteThresholdDetail,
} from "../hooks/magic-context/event-resolvers";
import { getLiveNotificationParams } from "../hooks/magic-context/hook-handlers";
import {
    renderMemoryBlockV2,
    trimMemoriesToBudgetV2,
} from "../hooks/magic-context/inject-compartments";
import type { LiveSessionState } from "../hooks/magic-context/live-session-state";
import { findLastAssistantModelFromOpenCodeDb } from "../hooks/magic-context/read-session-db";
import { estimateTokens } from "../hooks/magic-context/read-session-formatting";
import type { ManagedRecompContext } from "../hooks/magic-context/recomp-orchestrator";
import {
    calibrateBuckets,
    resolveModelCalibration,
} from "../hooks/magic-context/tokenizer-calibration";
import {
    ANNOUNCEMENT_FEATURES,
    ANNOUNCEMENT_FOOTER,
    ANNOUNCEMENT_VERSION,
    markAnnouncementSeen,
    shouldShowAnnouncement,
} from "../shared/announcement";
import { log } from "../shared/logger";
import { drainNotifications } from "../shared/rpc-notifications";
import type { MagicContextRpcServer } from "../shared/rpc-server";
import type { SidebarSnapshot, StatusDetail } from "../shared/rpc-types";
import { applyStickySnapshotCache } from "./sidebar-snapshot-cache";

function getDb(): Database | null {
    try {
        return openDatabase();
    } catch {
        return null;
    }
}

function parseTtlString(ttl: string): number {
    const match = ttl.match(/^(\d+)(s|m|h)$/);
    if (!match) return 5 * 60 * 1000;
    const val = Number.parseInt(match[1], 10);
    const unit = match[2];
    switch (unit) {
        case "s":
            return val * 1000;
        case "m":
            return val * 60 * 1000;
        case "h":
            return val * 3600 * 1000;
        default:
            return 5 * 60 * 1000;
    }
}

function resolveConfigValue<T>(
    cfg: Record<string, unknown> | undefined,
    key: string,
    modelKey: string | undefined,
    defaultValue: T,
): T {
    if (!cfg) return defaultValue;
    const val = cfg[key];
    if (typeof val === typeof defaultValue) return val as T;
    if (val && typeof val === "object") {
        const obj = val as Record<string, T>;
        if (modelKey && obj[modelKey] !== undefined) return obj[modelKey];
        if (modelKey) {
            const bare = modelKey.split("/").slice(1).join("/");
            if (bare && obj[bare] !== undefined) return obj[bare];
        }
        if (obj.default !== undefined) return obj.default;
    }
    return defaultValue;
}

// Exported for test access. Production code reaches this via the
// "sidebar-snapshot" RPC handler registered below.
export function buildSidebarSnapshot(
    db: Database,
    sessionId: string,
    directory: string,
    liveSessionState?: LiveSessionState,
    injectionBudgetTokens?: number,
    // Optional config so the sidebar can show the effective execute threshold
    // alongside `usagePercentage` (e.g. "47.5% / 65%"). Resolved per-model from
    // `liveSessionState.liveModelBySession`. When omitted (e.g. legacy test
    // callers), the snapshot falls back to the runtime default of 65%.
    config?: Record<string, unknown>,
): SidebarSnapshot {
    const empty: SidebarSnapshot = {
        sessionId,
        usagePercentage: 0,
        inputTokens: 0,
        contextLimit: 0,
        systemPromptTokens: 0,
        compartmentCount: 0,
        factCount: 0,
        memoryCount: 0,
        memoryBlockCount: 0,
        pendingOpsCount: 0,
        historianRunning: false,
        compartmentInProgress: false,
        sessionNoteCount: 0,
        readySmartNoteCount: 0,
        cacheTtl: "5m",
        lastDreamerRunAt: null,
        projectIdentity: null,
        compartmentTokens: 0,
        factTokens: 0,
        memoryTokens: 0,
        docsTokens: 0,
        profileTokens: 0,
        conversationTokens: 0,
        toolCallTokens: 0,
        toolDefinitionTokens: 0,
        executeThreshold: 65,
        newWorkTokens: null,
        totalInputTokens: null,
    };

    try {
        const projectIdentity = resolveProjectIdentity(directory);

        const meta = db
            .prepare<[string], Record<string, unknown>>(
                "SELECT * FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId);

        const usagePercentage = meta
            ? Number(meta.last_context_percentage ?? meta.last_usage_percentage ?? 0)
            : 0;
        const inputTokens = meta ? Number(meta.last_input_tokens ?? 0) : 0;
        const newWorkTokens = meta ? Number(meta.new_work_tokens ?? 0) : 0;
        const totalInputTokens = meta ? Number(meta.total_input_tokens ?? 0) : 0;
        const systemPromptTokens = meta ? Number(meta.system_prompt_tokens ?? 0) : 0;
        // messagesBlockTokens = token estimate of text/reasoning/image parts
        // in output.messages[] after transform, persisted by transform.ts.
        // Includes injected compartments/facts/memories (they're in message[0]).
        const messagesBlockTokens = meta ? Number(meta.conversation_tokens ?? 0) : 0;
        // toolCallTokensRaw = token estimate of tool_use/tool_result/tool/
        // tool-invocation parts in output.messages[], persisted by transform.
        // These are tool call I/O inside conversation (not tool schemas).
        const toolCallTokensRaw = meta ? Number(meta.tool_call_tokens ?? 0) : 0;
        const compartmentInProgress = meta ? Boolean(meta.compartment_in_progress) : false;
        const cacheTtl = meta ? String(meta.cache_ttl ?? "5m") : "5m";
        const memoryBlockCount = meta ? Number(meta.memory_block_count ?? 0) : 0;

        const compartmentRow = db
            .prepare<[string], { count: number }>(
                "SELECT COUNT(*) as count FROM compartments WHERE session_id = ?",
            )
            .get(sessionId);
        const compartmentCount = compartmentRow?.count ?? 0;

        // v2: facts are retired as a render source (promoted to memories), so the
        // sidebar reports 0 facts rather than counting the vestigial session_facts
        // table — a non-zero count would mislead operators into thinking facts
        // still render in <session-history>.
        const factCount = 0;

        let memoryCount = 0;
        if (projectIdentity) {
            const memRow = db
                .prepare<[string], { count: number }>(
                    "SELECT COUNT(*) as count FROM memories WHERE project_path = ? AND status = 'active'",
                )
                .get(projectIdentity);
            memoryCount = memRow?.count ?? 0;
        }

        let pendingOpsCount = 0;
        try {
            const pendingRow = db
                .prepare<[string], { count: number }>(
                    "SELECT COUNT(*) as count FROM pending_ops WHERE session_id = ?",
                )
                .get(sessionId);
            pendingOpsCount = pendingRow?.count ?? 0;
        } catch {
            // pending_ops table may not exist
        }

        let sessionNoteCount = 0;
        try {
            const noteRow = db
                .prepare<[string], { count: number }>(
                    "SELECT COUNT(*) as count FROM notes WHERE session_id = ? AND type = 'session' AND status = 'active'",
                )
                .get(sessionId);
            sessionNoteCount = noteRow?.count ?? 0;
        } catch {
            // notes table may not exist
        }

        let readySmartNoteCount = 0;
        if (projectIdentity) {
            try {
                const smartRow = db
                    .prepare<[string], { count: number }>(
                        "SELECT COUNT(*) as count FROM notes WHERE project_path = ? AND type = 'smart' AND status = 'ready'",
                    )
                    .get(projectIdentity);
                readySmartNoteCount = smartRow?.count ?? 0;
            } catch {
                // notes table may not exist
            }
        }

        // Token estimates via real Claude tokenizer (ai-tokenizer).
        let compartmentTokens = 0;
        const factTokens = 0;
        let memoryTokens = 0;
        // v2: compartments are DECAY-RENDERED — most render at a lower tier
        // (p2/p3/p4) or drop past the archive boundary, so the actual injected
        // <session-history> is far smaller than Σ(full p1 content). The true
        // on-wire size is the <session-history> slice of the persisted m[0]
        // snapshot (cached_m0_bytes). Measuring Σp1 instead overcounts the
        // Compartments bucket AND starves Conversation to 0 via the
        // `max(0, messagesBlockTokens − compartmentTokens)` clamp below
        // (dogfood 2026-05-30, AFT: 545 compartments → Σp1 157K > 135K stream).
        const m0Bytes = meta?.cached_m0_bytes;
        const m0Text =
            m0Bytes instanceof Uint8Array
                ? Buffer.from(m0Bytes).toString("utf8")
                : typeof m0Bytes === "string"
                  ? (m0Bytes as string)
                  : "";
        // <project-docs> and <user-profile> also live in m[0] (stable
        // scaffolding moved out of the system prompt in v2). They are part of
        // messagesBlockTokens but are NOT conversation — surface them as their
        // own buckets so they don't silently inflate Conversation.
        let docsTokens = 0;
        let profileTokens = 0;
        const docsMatch = m0Text.match(/<project-docs>([\s\S]*?)<\/project-docs>/);
        if (docsMatch) docsTokens = estimateTokens(docsMatch[0]);
        const profileMatch = m0Text.match(/<user-profile>([\s\S]*?)<\/user-profile>/);
        if (profileMatch) profileTokens = estimateTokens(profileMatch[0]);
        // Memory bucket: measure the ACTUAL <project-memory> slice in m[0] (the v2
        // wire render with id/category/importance attributes), not the legacy
        // memory_block_cache (v1 "- content" shape, which under-counts the real
        // injected cost). Falls back below to an on-demand v2 render when m[0]
        // has no slice yet (cold start / pre-first-materialization).
        let memoryFromM0 = false;
        const memMatch = m0Text.match(/<project-memory>([\s\S]*?)<\/project-memory>/);
        if (memMatch) {
            memoryTokens = estimateTokens(memMatch[0]);
            memoryFromM0 = true;
        }
        const histMatch = m0Text.match(/<session-history>([\s\S]*?)<\/session-history>/);
        if (histMatch) {
            // Real decayed render — count exactly what's on the wire.
            compartmentTokens = estimateTokens(histMatch[0]);
        } else {
            // No materialized m[0] yet (brand-new / pre-first-materialization).
            // Fall back to the Σp1 estimate so the bucket isn't blank on a cold
            // session; it self-corrects to the decayed size on first render.
            try {
                const compRows = db
                    .prepare<
                        [string],
                        {
                            content: string;
                            title: string;
                            start_message: number;
                            end_message: number;
                        }
                    >(
                        "SELECT content, title, start_message, end_message FROM compartments WHERE session_id = ?",
                    )
                    .all(sessionId);
                for (const c of compRows) {
                    compartmentTokens += estimateTokens(
                        `<compartment start="${c.start_message}" end="${c.end_message}" title="${c.title}">\n${c.content}\n</compartment>\n`,
                    );
                }
            } catch {
                /* compartments table may not exist */
            }
        }
        // v2: facts are retired as a render source (promoted to memories), so
        // they contribute 0 render tokens. factTokens stays 0 — kept in the
        // breakdown shape for dashboard back-compat, not recomputed from the
        // vestigial session_facts table.
        // Fallback when m[0] has no <project-memory> slice yet (cold start /
        // pre-first-materialization). Render on-demand with the SAME v2 path the
        // injection uses (renderMemoryBlockV2 + trimMemoriesToBudgetV2) so the
        // sidebar reading matches what WILL be injected, not the legacy v1 shape.
        if (!memoryFromM0 && memoryBlockCount > 0 && projectIdentity) {
            try {
                const memories = getMemoriesByProject(db, projectIdentity, ["active", "permanent"]);
                const selected = injectionBudgetTokens
                    ? trimMemoriesToBudgetV2(sessionId, memories, injectionBudgetTokens).renderOrder
                    : memories;
                const block = renderMemoryBlockV2(selected);
                memoryTokens = block ? estimateTokens(block) : 0;
            } catch {
                // Defensive: memory tables may not exist yet on a brand-new DB.
                memoryTokens = 0;
            }
        }

        let lastDreamerRunAt: number | null = null;
        if (projectIdentity) {
            try {
                const dreamRow = db
                    .prepare<[string], { value: string }>(
                        "SELECT value FROM dream_state WHERE key = ?",
                    )
                    .get(`last_dream_at:${projectIdentity}`);
                if (dreamRow?.value) {
                    lastDreamerRunAt = Number(dreamRow.value) || null;
                }
            } catch {
                // dream_state may not exist
            }
        }

        // Display-layer attribution.
        //
        // Local raw counts come from ai-tokenizer. Per-model calibration in
        // tokenizer-calibration.ts captures the empirically-measured drift
        // between local raw counts and the API's actual token counts (varies
        // significantly across providers and model generations). We:
        //   1. scale stable buckets (system, tool defs) by per-model ratios,
        //   2. compute the dynamic remainder as inputTokens - calibrated_stable,
        //   3. proportionally distribute the remainder to dynamic buckets so
        //      they sum to exactly inputTokens. Overhead becomes 0.
        //
        // messagesBlockTokens persisted by transform.ts includes the injected
        // <session-history> block (compartments + facts + memories live in
        // message[0]). Subtract those so "conversationLocal" reflects real
        // user/assistant dialog only.
        const injectedInMessages =
            compartmentTokens + factTokens + memoryTokens + docsTokens + profileTokens;
        const conversationLocal = Math.max(0, messagesBlockTokens - injectedInMessages);
        const toolCallsLocal = Math.max(0, toolCallTokensRaw);

        // Measured tool schema cost. Resolved via the live-session-state latch
        // (session → agent/model). When the in-memory map is empty (post-restart,
        // before this session's first chat.message has fired in this process)
        // fall back to OpenCode's SQLite DB to recover provider/model/agent
        // from the last assistant message, mirroring the model-recovery path
        // already in place for hook.ts. Populate the cache so subsequent reads
        // hit memory directly. This eliminates the "Tool Defs shows 0 until
        // next chat.message" cold-start gap.
        let measuredToolDefTokens = 0;
        let activeProviderID: string | undefined;
        let activeModelID: string | undefined;
        if (liveSessionState) {
            let model = liveSessionState.liveModelBySession.get(sessionId);
            let agent = liveSessionState.agentBySession.get(sessionId);
            if (!model || !agent) {
                const recovered = findLastAssistantModelFromOpenCodeDb(sessionId);
                if (recovered) {
                    if (!model) {
                        model = {
                            providerID: recovered.providerID,
                            modelID: recovered.modelID,
                        };
                        liveSessionState.liveModelBySession.set(sessionId, model);
                    }
                    if (!agent && recovered.agent) {
                        agent = recovered.agent;
                        liveSessionState.agentBySession.set(sessionId, agent);
                    }
                }
            }
            if (model) {
                activeProviderID = model.providerID;
                activeModelID = model.modelID;
                measuredToolDefTokens =
                    getMeasuredToolDefinitionTokens(model.providerID, model.modelID, agent) ?? 0;
            }
        }

        const contextLimit =
            activeProviderID && activeModelID
                ? resolveContextLimit(activeProviderID, activeModelID, { db, sessionID: sessionId })
                : 0;

        // Resolve the effective execute-threshold percentage for this
        // session's active model so the sidebar header can show
        // "47.5% / 65%" alongside the absolute "475K / 1.0M". Falls back
        // to 65% (the runtime default) when no live model is known yet
        // or when no config was passed in. Mirrors the resolution flow
        // used by `buildStatusDetail` so the dialog and sidebar agree.
        let executeThreshold = 65;
        if (config) {
            const modelKey =
                activeProviderID && activeModelID
                    ? `${activeProviderID}/${activeModelID}`
                    : undefined;
            const pctCfg = config.execute_threshold_percentage as
                | number
                | { default: number; [k: string]: number }
                | undefined;
            const tokensCfg = config.execute_threshold_tokens as
                | { default?: number; [k: string]: number | undefined }
                | undefined;
            const thresholdDetail = resolveExecuteThresholdDetail(pctCfg ?? 65, modelKey, 65, {
                tokensConfig: tokensCfg,
                contextLimit: contextLimit || undefined,
                sessionId,
            });
            executeThreshold = thresholdDetail.percentage;
        }

        const calibration = resolveModelCalibration(activeProviderID, activeModelID);
        const calibrated = calibrateBuckets({
            inputTokens,
            systemLocal: systemPromptTokens,
            toolDefsLocal: measuredToolDefTokens,
            compartmentsLocal: compartmentTokens,
            factsLocal: factTokens,
            memoriesLocal: memoryTokens,
            docsLocal: docsTokens,
            profileLocal: profileTokens,
            conversationLocal,
            toolCallsLocal,
            calibration,
        });

        const fresh: SidebarSnapshot = {
            sessionId,
            usagePercentage,
            inputTokens,
            contextLimit,
            systemPromptTokens: calibrated.systemTokens,
            compartmentCount,
            factCount,
            memoryCount,
            memoryBlockCount,
            pendingOpsCount,
            historianRunning: compartmentInProgress,
            compartmentInProgress,
            sessionNoteCount,
            readySmartNoteCount,
            cacheTtl,
            lastDreamerRunAt,
            projectIdentity,
            compartmentTokens: calibrated.compartmentTokens,
            factTokens: calibrated.factTokens,
            memoryTokens: calibrated.memoryTokens,
            docsTokens: calibrated.docsTokens,
            profileTokens: calibrated.profileTokens,
            conversationTokens: calibrated.conversationTokens,
            toolCallTokens: calibrated.toolCallTokens,
            toolDefinitionTokens: calibrated.toolDefinitionTokens,
            executeThreshold,
            newWorkTokens,
            totalInputTokens,
            recompProgress: (() => {
                const p = liveSessionState?.recompProgressBySession.get(sessionId);
                if (!p) return null;
                return {
                    phase: p.phase,
                    processedMessages: p.processedMessages,
                    totalMessages: p.totalMessages,
                    passCount: p.passCount,
                    compartmentsCreated: p.compartmentsCreated,
                    message: p.message,
                    note: p.note,
                };
            })(),
        };
        // Defensive sticky cache: if `inputTokens` briefly drops to 0 mid-turn
        // (intermittent — possibly streaming events with empty token shape, or
        // first-pass reset firing on existing-session messages), serve the
        // last good breakdown instead of letting the bar flicker.
        return applyStickySnapshotCache(sessionId, fresh);
    } catch (err) {
        log("[rpc] sidebar-snapshot error:", err);
        // Preserve live recomp/upgrade progress even when the full snapshot build
        // throws (e.g. a concurrent BEGIN-IMMEDIATE publish makes a DB read hit
        // SQLITE_BUSY mid-recomp). Without this, a transient build failure emits a
        // progress-less snapshot and the TUI's recomp poll would lose the bar
        // (dogfood 2026-05-30).
        const p = liveSessionState?.recompProgressBySession.get(sessionId);
        if (!p) return empty;
        return {
            ...empty,
            recompProgress: {
                phase: p.phase,
                processedMessages: p.processedMessages,
                totalMessages: p.totalMessages,
                passCount: p.passCount,
                compartmentsCreated: p.compartmentsCreated,
                message: p.message,
                note: p.note,
            },
        };
    }
}

export function buildStatusDetail(
    db: Database,
    sessionId: string,
    directory: string,
    modelKey?: string,
    config?: Record<string, unknown>,
    liveSessionState?: LiveSessionState,
    injectionBudgetTokens?: number,
): StatusDetail {
    const base = buildSidebarSnapshot(
        db,
        sessionId,
        directory,
        liveSessionState,
        injectionBudgetTokens,
        config,
    );
    const detail: StatusDetail = {
        ...base,
        tagCounter: 0,
        activeTags: 0,
        droppedTags: 0,
        totalTags: 0,
        activeBytes: 0,
        lastResponseTime: 0,
        lastNudgeTokens: 0,
        lastNudgeBand: "",
        lastTransformError: null,
        isSubagent: false,
        pendingOps: [],
        contextLimit: 0,
        cacheTtlMs: 0,
        cacheRemainingMs: 0,
        cacheExpired: false,
        executeThreshold: 65,
        executeThresholdMode: "percentage",
        protectedTagCount: 20,
        nudgeInterval: 20000,
        historyBudgetPercentage: 0.15,
        nextNudgeAfter: 0,
        historyBlockTokens: 0,
        compressionBudget: null,
        compressionUsage: null,
    };

    try {
        const meta = db
            .prepare<[string], Record<string, unknown>>(
                "SELECT * FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId);
        if (meta) {
            detail.tagCounter = Number(meta.counter ?? 0);
            detail.lastResponseTime = Number(meta.last_response_time ?? 0);
            detail.lastNudgeTokens = Number(meta.last_nudge_tokens ?? 0);
            detail.lastNudgeBand = String(meta.last_nudge_band ?? "");
            detail.lastTransformError = meta.last_transform_error
                ? String(meta.last_transform_error)
                : null;
            detail.isSubagent = Boolean(meta.is_subagent);
        }

        // Tags
        try {
            const activeRow = db
                .prepare<[string], { count: number; bytes: number }>(
                    "SELECT COUNT(*) as count, COALESCE(SUM(byte_size), 0) as bytes FROM tags WHERE session_id = ? AND status = 'active'",
                )
                .get(sessionId);
            detail.activeTags = activeRow?.count ?? 0;
            detail.activeBytes = activeRow?.bytes ?? 0;
            const droppedRow = db
                .prepare<[string], { count: number }>(
                    "SELECT COUNT(*) as count FROM tags WHERE session_id = ? AND status = 'dropped'",
                )
                .get(sessionId);
            detail.droppedTags = droppedRow?.count ?? 0;
            detail.totalTags = detail.activeTags + detail.droppedTags;
        } catch {
            // tags table might have different schema
        }

        // Pending ops
        try {
            const ops = db
                .prepare<[string], { tag_id: number; operation: string }>(
                    "SELECT tag_id, operation FROM pending_ops WHERE session_id = ?",
                )
                .all(sessionId);
            detail.pendingOps = ops.map((o) => ({ tagId: o.tag_id, operation: o.operation }));
        } catch {
            // pending_ops may not exist
        }

        // Derived context limit needed for tokens-based threshold resolution.
        const contextLimitForTokens =
            base.contextLimit > 0
                ? base.contextLimit
                : base.usagePercentage > 0
                  ? Math.round(base.inputTokens / (base.usagePercentage / 100))
                  : 0;

        // Config values (resolve per-model)
        if (config) {
            const pctCfg = config.execute_threshold_percentage as
                | number
                | { default: number; [k: string]: number }
                | undefined;
            const tokensCfg = config.execute_threshold_tokens as
                | { default?: number; [k: string]: number | undefined }
                | undefined;
            // Use the detail resolver so we can surface mode + absolute tokens
            // consistently with /ctx-status. Avoids the "progressive lookup drift"
            // where RPC and status-text disagreed on whether tokens mode was active.
            const thresholdDetail = resolveExecuteThresholdDetail(pctCfg ?? 65, modelKey, 65, {
                tokensConfig: tokensCfg,
                contextLimit: contextLimitForTokens || undefined,
                sessionId,
            });
            detail.executeThreshold = thresholdDetail.percentage;
            detail.executeThresholdMode = thresholdDetail.mode;
            if (thresholdDetail.absoluteTokens !== undefined) {
                detail.executeThresholdTokens = thresholdDetail.absoluteTokens;
            }

            const ct = resolveConfigValue<string>(config, "cache_ttl", modelKey, "5m");
            detail.cacheTtl = ct;

            if (typeof config.protected_tag_count === "number") {
                detail.protectedTagCount = config.protected_tag_count;
            }
            if (typeof config.nudge_interval_tokens === "number") {
                detail.nudgeInterval = config.nudge_interval_tokens;
            }
            if (typeof config.history_budget_percentage === "number") {
                detail.historyBudgetPercentage = config.history_budget_percentage;
            }
        }

        // Derived values
        if (base.contextLimit > 0) {
            detail.contextLimit = base.contextLimit;
        } else if (base.usagePercentage > 0) {
            detail.contextLimit = Math.round(base.inputTokens / (base.usagePercentage / 100));
        }
        detail.cacheTtlMs = parseTtlString(detail.cacheTtl);
        if (detail.lastResponseTime > 0) {
            const elapsed = Date.now() - detail.lastResponseTime;
            detail.cacheRemainingMs = Math.max(0, detail.cacheTtlMs - elapsed);
            detail.cacheExpired = detail.cacheRemainingMs === 0;
        }
        detail.nextNudgeAfter = detail.lastNudgeTokens + detail.nudgeInterval;

        // History compression
        try {
            const histTokens = base.compartmentTokens + base.factTokens;
            detail.historyBlockTokens = histTokens;

            if (detail.contextLimit > 0) {
                const budget = Math.floor(
                    detail.contextLimit *
                        (Math.min(detail.executeThreshold, 80) / 100) *
                        detail.historyBudgetPercentage,
                );
                detail.compressionBudget = budget;
                detail.compressionUsage = `${((histTokens / budget) * 100).toFixed(0)}%`;
            }
        } catch {
            // history-token derivation failure
        }
    } catch (err) {
        log("[rpc] status-detail error:", err);
    }

    return detail;
}

/**
 * Register all RPC handlers on the server.
 */
export function registerRpcHandlers(
    rpcServer: MagicContextRpcServer,
    args: {
        directory: string;
        config: MagicContextConfig;
        client: unknown;
        liveSessionState: LiveSessionState;
    },
): void {
    const { directory, config, liveSessionState } = args;

    // Read config as raw object for per-model resolution
    const rawConfig = config as unknown as Record<string, unknown>;
    const getNotificationParams = (sessionId: string) =>
        getLiveNotificationParams(
            sessionId,
            liveSessionState.liveModelBySession,
            liveSessionState.variantBySession,
            liveSessionState.agentBySession,
        );

    const injectionBudgetTokens = config.memory?.injection_budget_tokens;

    rpcServer.handle("sidebar-snapshot", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        const dir = String(params.directory ?? directory);
        const db = getDb();
        if (!db || !sessionId) return { error: "unavailable" };
        return buildSidebarSnapshot(
            db,
            sessionId,
            dir,
            liveSessionState,
            injectionBudgetTokens,
            rawConfig,
        ) as unknown as Record<string, unknown>;
    });

    rpcServer.handle("status-detail", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        const dir = String(params.directory ?? directory);
        const modelKey = params.modelKey ? String(params.modelKey) : undefined;
        const db = getDb();
        if (!db || !sessionId) return { error: "unavailable" };
        return buildStatusDetail(
            db,
            sessionId,
            dir,
            modelKey,
            rawConfig,
            liveSessionState,
            injectionBudgetTokens,
        ) as unknown as Record<string, unknown>;
    });

    rpcServer.handle("compartment-count", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        const db = getDb();
        if (!db || !sessionId) return { count: 0 };
        try {
            const row = db
                .prepare<[string], { count: number }>(
                    "SELECT COUNT(*) as count FROM compartments WHERE session_id = ?",
                )
                .get(sessionId);
            return { count: row?.count ?? 0 };
        } catch {
            return { count: 0 };
        }
    });

    // ── Recomp / session-upgrade: delegate to the shared orchestrator ───────
    // The RPC dialog paths ("/ctx-recomp" + "Run upgrade now") run through the
    // SAME runManagedRecomp/runManagedUpgrade as the /ctx-* command paths, so
    // they get identical model fallback, live progress, terminal state, and
    // clean messaging. Dogfood 2026-05-30: the old RPC upgrade handler lacked
    // model fallback (failed when the primary historian model returned empty,
    // while /ctx-session-upgrade succeeded via fallback) and the command path
    // lacked progress (left the sidebar stuck on a stale "failed"). One runner
    // closes both gaps permanently.
    const buildManagedCtx = async (
        sessionId: string,
        db: NonNullable<ReturnType<typeof getDb>>,
    ): Promise<ManagedRecompContext> => {
        const { deriveHistorianChunkTokens, resolveHistorianContextLimit } = await import(
            "../hooks/magic-context/derive-budgets"
        );
        const { resolveFallbackChain } = await import("../shared/resolve-fallbacks");
        const { HISTORIAN_AGENT } = await import("../agents/historian");
        const DEFAULT_HISTORIAN_TIMEOUT_MS = 10 * 60 * 1000;
        return {
            client: args.client as ManagedRecompContext["client"],
            db,
            liveSessionState,
            directory,
            historianChunkTokens: deriveHistorianChunkTokens(
                resolveHistorianContextLimit(config.historian?.model),
            ),
            historianTimeoutMs: config.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
            memoryEnabled: config.memory?.enabled ?? true,
            autoPromote: config.memory?.auto_promote ?? true,
            fallbackModels: resolveFallbackChain(
                HISTORIAN_AGENT,
                config.historian?.fallback_models,
            ),
            runMigration: config.memory?.enabled !== false && !!config.historian?.model,
            userMemoriesEnabled: config.dreamer?.user_memories?.enabled === true,
            historianTwoPass: config.historian?.two_pass === true,
            getNotificationParams,
        };
    };

    rpcServer.handle("recomp", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        if (!sessionId) return { ok: false, error: "no session" };
        const db = getDb();
        if (!db) return { ok: false, error: "db unavailable" };

        const { runManagedRecomp } = await import("../hooks/magic-context/recomp-orchestrator");
        const { sendIgnoredMessage } = await import(
            "../hooks/magic-context/send-session-notification"
        );
        log(`[rpc] recomp requested for session ${sessionId}`);
        const ctx = await buildManagedCtx(sessionId, db);
        // Fire-and-forget; outcome is force-persisted so a multi-minute recomp's
        // result stays visible in scrollback instead of a 5s toast.
        void runManagedRecomp(ctx, sessionId)
            .then((message) => {
                void sendIgnoredMessage(
                    args.client,
                    sessionId,
                    message,
                    getNotificationParams(sessionId),
                    true,
                ).catch(() => {});
            })
            .catch((error: unknown) => log("[rpc] recomp failed:", error));
        return { ok: true };
    });

    // TUI-triggered `/ctx-session-upgrade`: full recomp + once-per-project memory
    // migration. Fired from the upgrade dialog's "Run upgrade now" action.
    rpcServer.handle("upgrade", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        if (!sessionId) return { ok: false, error: "no session" };
        const db = getDb();
        if (!db) return { ok: false, error: "db unavailable" };

        const { runManagedUpgrade } = await import("../hooks/magic-context/recomp-orchestrator");
        const { sendIgnoredMessage } = await import(
            "../hooks/magic-context/send-session-notification"
        );
        log(`[rpc] session-upgrade requested for session ${sessionId}`);
        const ctx = await buildManagedCtx(sessionId, db);
        void runManagedUpgrade(ctx, sessionId)
            .then((message) => {
                void sendIgnoredMessage(
                    args.client,
                    sessionId,
                    message,
                    getNotificationParams(sessionId),
                    true, // force-persist: a multi-minute upgrade's outcome must stay visible
                ).catch(() => {});
            })
            .catch((error: unknown) => log("[rpc] session-upgrade failed:", error));
        return { ok: true };
    });

    // The user made an explicit choice on the upgrade dialog (Confirm or Cancel).
    // Set the durable stamp so the FRESH reminder won't re-show. We deliberately
    // do NOT stamp when the dialog is merely displayed — a display that the user
    // closed/ctrl-c'd before acting must re-show on the next process (dogfood
    // 2026-05-30). Resume prompts are staging-driven and unaffected by this stamp.
    rpcServer.handle("dismiss-upgrade-reminder", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        if (!sessionId) return { ok: false, error: "no session" };
        const db = getDb();
        if (!db) return { ok: false, error: "db unavailable" };
        try {
            const { updateSessionMeta } = await import(
                "../features/magic-context/storage-meta-session"
            );
            updateSessionMeta(db, sessionId, { upgradeRemindedAt: Date.now() });
            return { ok: true };
        } catch (error) {
            log("[rpc] dismiss-upgrade-reminder failed:", error);
            return { ok: false, error: String(error) };
        }
    });

    rpcServer.handle("pending-notifications", async (params) => {
        const lastReceivedId = Number(params.lastReceivedId ?? 0);
        const notifications = drainNotifications(
            Number.isFinite(lastReceivedId) ? lastReceivedId : 0,
        );
        return { messages: notifications } as unknown as Record<string, unknown>;
    });

    // Startup announcement — called by the TUI plugin once per session to decide
    // whether to show the "What's new" dialog. We deliberately read state via
    // the file in getMagicContextStorageDir() (not an SQLite table) so that
    // both OpenCode and Pi share one source of truth and a dismissal in either
    // harness suppresses the dialog in the other for the same announcement.
    rpcServer.handle("get-announcement", async () => {
        // shouldShowAnnouncement already covers the empty-version / empty-features
        // case as "nothing to show", so this is the single gate.
        if (!shouldShowAnnouncement()) {
            return { show: false } as unknown as Record<string, unknown>;
        }
        return {
            show: true,
            version: ANNOUNCEMENT_VERSION,
            features: [...ANNOUNCEMENT_FEATURES],
            footer: ANNOUNCEMENT_FOOTER,
        } as unknown as Record<string, unknown>;
    });

    rpcServer.handle("mark-announced", async () => {
        if (ANNOUNCEMENT_VERSION) {
            markAnnouncementSeen(ANNOUNCEMENT_VERSION);
        }
        return { ok: true } as unknown as Record<string, unknown>;
    });
}
