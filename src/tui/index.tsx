/** @jsxImportSource @opentui/solid */
// @ts-nocheck
import { createMemo } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { createSidebarContentSlot, kickRecompProgressRefresh } from "./slots/sidebar-content"
import packageJson from "../../package.json"
import { closeRpc, dismissUpgradeReminder, getAnnouncement, getCompartmentCount, getRpcGeneration, initRpcClient, loadEmbedDetail, loadStatusDetail, loadToastDurationMs, markAnnounced, requestRecomp, requestUpgrade, type EmbedDetail, type StatusDetail } from "./data/context-db"
import { startNotificationSocket, stopNotificationSocket, type SocketNotification } from "./data/notification-socket"
import { formatThresholdPercent } from "../shared/format-threshold"
import { detectConflicts } from "../shared/conflict-detector"
import { fixConflicts } from "../shared/conflict-fixer"

const DEFAULT_TOAST_DURATION_MS = 5000
let unifiedToastDurationMs = DEFAULT_TOAST_DURATION_MS

async function refreshToastDurationMs(): Promise<void> {
    try {
        const resolved = await loadToastDurationMs()
        if (typeof resolved === "number" && Number.isFinite(resolved)) {
            unifiedToastDurationMs = resolved
        }
    } catch {
        // Keep the current value; the next poll/startup can retry.
    }
}

function getToastDurationMs(): number {
    return unifiedToastDurationMs
}

function showToast(
    api: TuiPluginApi,
    input: {
        message: string
        variant: "info" | "warning" | "error" | "success"
        durationOverrideMs?: number
    },
): void {
    const duration =
        typeof input.durationOverrideMs === "number" && Number.isFinite(input.durationOverrideMs)
            ? input.durationOverrideMs
            : getToastDurationMs()
    // toast_duration_ms = 0 disables Magic Context toasts entirely. An explicit
    // positive per-call override (e.g. restart-required) still shows; only a
    // non-positive effective duration suppresses the toast.
    if (!(duration > 0)) {
        return
    }
    api.ui.toast({
        message: input.message,
        variant: input.variant,
        duration,
    })
}

function showConflictDialog(api: TuiPluginApi, directory: string, reasons: string[], conflicts: ReturnType<typeof detectConflicts>["conflicts"]) {
    api.ui.dialog.replace(() => (
        <api.ui.DialogConfirm
            title="⚠️ Magic Context 已禁用"
            message={`${reasons.join("\n")}\n\n是否自动修复这些冲突？`}
            onConfirm={() => {
                const actions = fixConflicts(directory, conflicts)
                const actionSummary = actions.length > 0
                    ? actions.map(a => `• ${a}`).join("\n")
                    : "无需更改"
                // DialogConfirm calls dialog.clear() after onConfirm, so defer the next dialog
                setTimeout(() => {
                    api.ui.dialog.replace(() => (
                        <api.ui.DialogAlert
                            title="✅ 配置已修复"
                            message={`${actionSummary}\n\n请重启 OpenCode 使更改生效。`}
                            onConfirm={() => {
                                showToast(api, {
                                    message: "重启 OpenCode 以启用 Magic Context",
                                    variant: "warning",
                                    durationOverrideMs: 10_000,
                                })
                            }}
                        />
                    ))
                }, 50)
            }}
            onCancel={() => {
                showToast(api, { message: "Magic Context 仍处于禁用状态。请运行: npx @cortexkit/opencode-magic-context@latest doctor", variant: "warning" })
            }}
        />
    ))
}

function fmt(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${Math.round(n / 1_000)}K`
    return String(n)
}

function fmtBytes(n: number): string {
    if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`
    if (n >= 1_024) return `${Math.round(n / 1_024)} KB`
    return `${n} B`
}

function relTime(ms: number): string {
    const d = Date.now() - ms
    if (d < 60_000) return "just now"
    if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`
    return `${Math.floor(d / 86_400_000)}d ago`
}

function getSessionId(api: TuiPluginApi): string | null {
    try {
        const route = api.route.current
        if (route?.name === "session" && route.params?.sessionID) {
            return route.params.sessionID
        }
    } catch {
        // ignore
    }
    return null
}

const R = (props: { t: TuiThemeCurrent; l: string; v: string; fg?: string }) => (
    <box width="100%" flexDirection="row" justifyContent="space-between">
        <text fg={props.t.textMuted}>{props.l}</text>
        <text fg={props.fg ?? props.t.text}>{props.v}</text>
    </box>
)

const StatusDialog = (props: { api: TuiPluginApi; s: StatusDetail }) => {
    const theme = createMemo(() => (props.api as any).theme.current)
    const t = () => theme()
    const s = () => props.s

    // Prefer the RPC-provided model context limit (what the sidebar shows) so the
    // two surfaces never disagree. Fall back to deriving from usage% only when the
    // RPC limit is absent (0) — and that derivation is itself undefined at 0%, so
    // it stays "?" rather than showing a number inconsistent with the sidebar.
    const contextLimit = () =>
        s().contextLimit > 0
            ? s().contextLimit
            : s().usagePercentage > 0
              ? Math.round(s().inputTokens / (s().usagePercentage / 100))
              : 0

    const elapsed = () => (s().lastResponseTime > 0 ? Date.now() - s().lastResponseTime : 0)

    // Token breakdown segments — same colors as sidebar. Kept in sync with
    // slots/sidebar-content.tsx so the status dialog and sidebar read identically.
    const COLORS = {
        // Cool / structured — injected by the plugin into message[0]
        system: "#c084fc",
        docs: "#22d3ee",
        compartments: "#60a5fa",
        facts: "#fbbf24",
        memories: "#34d399",
        profile: "#a3e635",
        // Warm / user-facing — chat and tool traffic
        conversation: "#f87171",
        toolCalls: "#fb923c",
        toolDefs: "#f472b6",
    }

    const breakdownSegments = () => {
        const d = s()
        const total = d.inputTokens || 1
        const segs: Array<{ label: string; tokens: number; color: string; detail?: string }> = []

        if (d.systemPromptTokens > 0)
            segs.push({ label: "System", tokens: d.systemPromptTokens, color: COLORS.system })
        if (d.docsTokens > 0)
            segs.push({ label: "Docs", tokens: d.docsTokens, color: COLORS.docs })
        if (d.compartmentTokens > 0)
            segs.push({
                label: "Compartments",
                tokens: d.compartmentTokens,
                color: COLORS.compartments,
                detail: `(${d.compartmentCount})`,
            })
        if (d.factTokens > 0)
            segs.push({
                label: "Facts",
                tokens: d.factTokens,
                color: COLORS.facts,
                detail: `(${d.factCount})`,
            })
        if (d.memoryTokens > 0)
            segs.push({
                label: "Memories",
                tokens: d.memoryTokens,
                color: COLORS.memories,
                detail: `(${d.memoryBlockCount})`,
            })
        if (d.profileTokens > 0)
            segs.push({ label: "User Profile", tokens: d.profileTokens, color: COLORS.profile })

        if (d.conversationTokens > 0)
            segs.push({ label: "Conversation", tokens: d.conversationTokens, color: COLORS.conversation })
        if (d.toolCallTokens > 0)
            segs.push({ label: "Tool Calls", tokens: d.toolCallTokens, color: COLORS.toolCalls })
        if (d.toolDefinitionTokens > 0)
            segs.push({ label: "Tool Defs", tokens: d.toolDefinitionTokens, color: COLORS.toolDefs })

        return { segs, total }
    }

    // The status-dialog breakdown bar uses flex layout (same approach as the
    // sidebar breakdown). Each segment becomes a colored box with
    // flexGrow=tokens and flexBasis=0, parent has width="100%", so opentui
    // distributes the dialog's full width proportionally regardless of the
    // dialog's actual rendered width.
    const barSegments = () => breakdownSegments().segs.filter((seg) => seg.tokens > 0)

    return (
        <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
            {/* Title */}
            <box justifyContent="center" width="100%" marginBottom={1} flexDirection="row" gap={2}>
                <text fg={t().accent}><b>⚡ Magic Context 状态</b></text>
                <text fg={t().textMuted}>v{packageJson.version}</text>
            </box>

            {/* Context summary line. Mirrors the sidebar header layout
                ("47.5% / 65%   475K / 1.0M") so users can recognize the
                same shape in the status dialog. The execute threshold tells
                them how close they are to compaction triggering. */}
            <box flexDirection="row" justifyContent="space-between" width="100%">
                <text fg={s().usagePercentage >= 80 ? t().error : s().usagePercentage >= 65 ? t().warning : t().accent}>
                    <b>{s().usagePercentage.toFixed(1)}%</b> / {formatThresholdPercent(s().executeThreshold)}%
                </text>
                <text fg={s().usagePercentage >= 80 ? t().error : s().usagePercentage >= 65 ? t().warning : t().accent}>
                    {fmt(s().inputTokens)} / {contextLimit() > 0 ? fmt(contextLimit()) : "?"} 令牌
                </text>
            </box>

            {/* Segmented breakdown bar: flex row of colored boxes filling
                the dialog width. See barSegments comment above. */}
            <box width="100%" flexDirection="row" height={1}>
                {barSegments().map((seg) => (
                    <box
                        key={seg.label}
                        flexGrow={Math.max(1, seg.tokens)}
                        flexBasis={0}
                        height={1}
                        backgroundColor={seg.color}
                    />
                ))}
            </box>

            {/* Breakdown legend */}
            <box flexDirection="column">
                {breakdownSegments().segs.map((seg) => {
                    const pct = ((seg.tokens / breakdownSegments().total) * 100).toFixed(1)
                    return (
                        <box key={seg.label} width="100%" flexDirection="row" justifyContent="space-between">
                            <text fg={seg.color}>{seg.label} {seg.detail ?? ""}</text>
                            <text fg={t().textMuted}>{fmt(seg.tokens)} ({pct}%)</text>
                        </box>
                    )
                })}
            </box>

            {/* Recomp / session-upgrade live progress (full width, only while
                running or just finished — dogfood 2026-05-30). */}
            {s().recompProgress && (() => {
                const p = s().recompProgress!
                // Label follows the flow that started the run, so a plain
                // /ctx-recomp never reads as an "Upgrade" (dogfood 2026-06-04).
                const verb = p.kind === "upgrade" ? "升级" : p.kind === "embed" ? "嵌入" : "重编译"
                return (
                <box marginTop={1} width="100%" flexDirection="column">
                    <text fg={t().text}><b>{verb}</b></text>
                    {(() => {
                        if (p.phase === "recomp") {
                            const frac = p.totalMessages > 0 ? p.processedMessages / p.totalMessages : 0
                            const width = 24
                            const filled = Math.round(Math.max(0, Math.min(1, frac)) * width)
                            const bar = p.totalMessages > 0
                                ? `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`
                                : "(启动中…)"
                            const activeLabel = p.kind === "upgrade" ? "升级中" : p.kind === "embed" ? "嵌入中" : "整理中"
                            return (
                                <>
                                    <R t={t()} l={activeLabel} v={p.totalMessages > 0 ? `${bar} ${Math.round(frac * 100)}%` : bar} fg={t().warning} />
                                    {p.note ? <R t={t()} l="状态" v={p.note} fg={t().textMuted} /> : null}
                                    {p.kind === "embed"
                                        ? <R t={t()} l="隔间" v={`${p.processedMessages}/${p.totalMessages} 已嵌入`} fg={t().textMuted} />
                                        : <R t={t()} l="隔间" v={`${p.compartmentsCreated} (${p.passCount} 遍)`} fg={t().textMuted} />}
                                </>
                            )
                        }
                        if (p.phase === "migration") return <R t={t()} l="状态" v={p.note ?? "迁移记忆中 ⟳"} fg={t().warning} />
                        if (p.phase === "done") return <R t={t()} l="状态" v={`✓ ${verb} 完成`} fg={t().accent} />
                        if (p.phase === "skipped") return <R t={t()} l="状态" v={p.message ?? `${verb} 提前停止`} fg={t().textMuted} />
                        return <R t={t()} l="状态" v={`✗ ${verb} 失败${p.message ? `: ${p.message}` : ""}`} fg={t().error} />
                    })()}
                </box>
                )
            })()}

            {/* 2-column layout */}
            <box flexDirection="row" width="100%" marginTop={1} gap={4}>
                {/* Left column */}
                <box flexDirection="column" flexGrow={1} flexBasis={0}>
                    <text fg={t().text}><b>标签</b></text>
                    <R t={t()} l="活跃" v={`${s().activeTags} (~${fmtBytes(s().activeBytes)})`} />
                    <R t={t()} l="已丢弃" v={String(s().droppedTags)} />
                    <R t={t()} l="总计" v={String(s().totalTags)} fg={t().textMuted} />
                    <box marginTop={1}>
                        <text fg={t().text}><b>待处理队列</b></text>
                    </box>
                    <R t={t()} l="丢弃数" v={String(s().pendingOpsCount)} fg={s().pendingOpsCount > 0 ? t().warning : t().textMuted} />
                    <box marginTop={1}>
                        <text fg={t().text}><b>缓存 TTL</b></text>
                    </box>
                    <R t={t()} l="已配置" v={s().cacheTtl} />
                    <R t={t()} l="上次响应" v={s().lastResponseTime > 0 ? `${Math.round(elapsed() / 1000)}秒前` : "从未"} />
                    <R t={t()} l="剩余" v={s().cacheExpired ? "已过期" : `${Math.round(s().cacheRemainingMs / 1000)}秒`} fg={s().cacheExpired ? t().warning : t().textMuted} />
                    <R t={t()} l="自动执行" v={s().cacheExpired ? "是（已过期）" : `在 TTL 或 ≥${formatThresholdPercent(s().executeThreshold)}% 时`} fg={t().textMuted} />
                    <box marginTop={1}>
                        <text fg={t().text}><b>记忆</b></text>
                    </box>
                    <R t={t()} l="活跃" v={String(s().memoryCount)} fg={t().accent} />\n                    <R t={t()} l="已注入" v={String(s().memoryBlockCount)} fg={t().textMuted} />
                </box>
                {/* Right column */}
                <box flexDirection="column" flexGrow={1} flexBasis={0}>
                    <text fg={t().text}><b>缩减</b></text>
                    <R t={t()} l="执行阈值" v={`${formatThresholdPercent(s().executeThreshold)}%`} />
                    <R t={t()} l="上次缩减锚点" v={`${fmt(s().lastNudgeTokens)} 令牌`} />
                    <box marginTop={1}>
                        <text fg={t().text}><b>上下文详情</b></text>
                    </box>
                    <R t={t()} l="受保护标签" v={String(s().protectedTagCount)} fg={t().textMuted} />\n                    <R t={t()} l="子代理" v={s().isSubagent ? "是" : "否"} fg={t().textMuted} />
                    <box marginTop={1}>
                        <text fg={t().text}><b>历史压缩</b></text>
                    </box>
                    <R t={t()} l="历史块" v={`~${fmt(s().historyBlockTokens)} 个令牌`} />
                    {s().compressionBudget != null && (
                        <R t={t()} l="预算" v={`~${fmt(s().compressionBudget!)} 令牌 (${s().compressionUsage} 已使用)`} />
                    )}
                    {s().lastDreamerRunAt && (
                        <R t={t()} l="梦想家" v={`上次 ${relTime(s().lastDreamerRunAt!)}`} fg={t().textMuted} />
                    )}
                </box>
            </box>

            {/* Error (full width, conditional) */}
            {s().lastTransformError && (
                <box marginTop={1} width="100%">
                    <text fg={t().error}>⚠ {s().lastTransformError}</text>
                </box>
            )}

            {/* Footer */}
            <box marginTop={1} justifyContent="flex-end" width="100%">
                <text fg={t().textMuted}>按 Esc 关闭</text>
            </box>
        </box>
    )
}

function getModelKeyFromMessages(api: TuiPluginApi, sessionId: string): string | undefined {
    try {
        const msgs = api.state.session.messages(sessionId)
        // Find the last assistant message with model info
        // AssistantMessage has providerID/modelID as top-level fields
        // UserMessage has model: { providerID, modelID }
        for (let i = msgs.length - 1; i >= 0; i--) {
            const msg = msgs[i] as Record<string, unknown>
            if (msg.role === "assistant" && msg.providerID && msg.modelID) {
                return `${msg.providerID}/${msg.modelID}`
            }
            if (msg.role === "user") {
                const model = msg.model as Record<string, unknown> | undefined
                if (model?.providerID && model?.modelID) {
                    return `${model.providerID}/${model.modelID}`
                }
            }
        }
    } catch {
        // messages not available
    }
    return undefined
}

async function showRecompDialog(api: TuiPluginApi, targetSessionId = getSessionId(api)): Promise<boolean> {
    const sessionId = targetSessionId
    if (!sessionId) {
        showToast(api, { message: "无活跃会话", variant: "warning" })
        return false
    }

    const count = await getCompartmentCount(sessionId)
    // Ack only after the dialog is actually shown for the same active session;
    // route switches while the RPC detail load is in flight must leave it pending.
    if (getSessionId(api) !== sessionId) return false

    api.ui.dialog.replace(() => (
        <api.ui.DialogConfirm
            title="⚠️ 重编译确认"
            message={[
                count === 0
                    ? "此会话尚无隔间 — 重编译将从原始历史构建。"
                    : `您有 ${count} 个隔间。`,
                "",
                "重编译将从原始历史重新生成所有隔间和事实。",
                "此操作可能耗时较长并消耗大量令牌。",
                "",
                "是否继续？",
            ].join("\n")}
            onConfirm={() => {
                void requestRecomp(sessionId)
                kickRecompProgressRefresh()
                showToast(api, { message: "已请求重编译 — 历史学家即将启动", variant: "info" })
            }}
            onCancel={() => {
                showToast(api, { message: "重编译已取消", variant: "info", durationOverrideMs: 3000 })
            }}
        />
    ))
    return true
}

function showUpgradeDialog(
    api: TuiPluginApi,
    resume?: { stagedCount: number; stagedThrough: number },
    targetSessionId = getSessionId(api),
): boolean {
    const sessionId = targetSessionId
    if (!sessionId) {
        // No active session — nothing to upgrade. Silently skip (the server only
        // enqueues this for sessions with legacy compartments, but the TUI may
        // have switched sessions before the poller fired).
        return false
    }

    if (getSessionId(api) !== sessionId) return false

    const title = resume ? "🎆 恢复中断的升级？" : "🎆 历史学家 V2 已发布！"
    const message = resume
        ? [
              `之前对新历史学家格式的升级被中断。${resume.stagedCount} 个隔间已重建（到消息 ${resume.stagedThrough}）。恢复将从中断处继续 — 已重建的部分不会重复处理。`,
              "",
              "恢复将会：",
              "• 将剩余隔间重建为新的分层格式",
              "• 将本项目的记忆重新组织为新的分类体系（每个项目一次）",
              "",
              "历史学家在后台运行，您可以继续工作。也可以稍后通过 /ctx-session-upgrade 恢复。",
              "",
              "现在恢复升级？",
          ].join("\n")
        : [
              "此会话的隔间由旧版历史学家生成。会话仍可使用旧隔间，但强烈建议升级到新格式。这意味着每个隔间都需要由新历史学家重新处理，耗时取决于会话大小。",
              "",
              "运行升级将会：",
              "• 将本会话的隔间重建为新的分层格式",
              "• 将本项目的记忆重新组织为新的分类体系（每个项目一次）",
              "",
              "历史学家在后台运行，旧隔间处理期间您可以继续工作。也可以稍后通过 /ctx-session-upgrade 升级。",
              "",
              "现在运行升级？",
          ].join("\n")

    api.ui.dialog.replace(
        () => (
            <api.ui.DialogConfirm
                title={title}
                message={message}
                onConfirm={() => {
                    // Start the sidebar's recomp self-poll immediately — the RPC
                    // call fires no message event, so without this the progress
                    // bar wouldn't appear until the upgrade finished.
                    kickRecompProgressRefresh()
                    showToast(api, {
                        message: resume
                            ? "恢复会话升级 — 后台运行中"
                            : "会话升级已启动 — 后台运行中",
                        variant: "info",
                    })
                    // Dismiss the durable reminder ONLY after the upgrade request
                    // actually started. If requestUpgrade() returns false (RPC /
                    // server / db / auth failure, restart race), the session stays
                    // legacy — dismissing first would set upgradeRemindedAt and
                    // suppress all future reminders for a session that never
                    // upgraded. (Resume prompts are staging-driven and unaffected.)
                    void requestUpgrade(sessionId).then((started) => {
                        if (started) void dismissUpgradeReminder(sessionId)
                    })
                }}
                onCancel={() => {
                    // Explicit decline → set the durable stamp so we don't re-prompt
                    // on every restart. The fix for stamp-on-display trapping a
                    // never-upgraded session (dogfood 2026-05-30) relies on THIS
                    // being the only place the TUI path stamps.
                    void dismissUpgradeReminder(sessionId)
                    showToast(api, {
                        message: "升级已跳过 — 可随时运行 /ctx-session-upgrade",
                        variant: "info",
                        durationOverrideMs: 4000,
                    })
                }}
            />
        ),
    )
    return true
}

async function showStatusDialog(api: TuiPluginApi, targetSessionId = getSessionId(api)): Promise<boolean> {
    const sessionId = targetSessionId
    if (!sessionId) {
        showToast(api, { message: "无活跃会话", variant: "warning" })
        return false
    }

    const directory = api.state.path.directory ?? ""
    const modelKey = getModelKeyFromMessages(api, sessionId)
    const detail = await loadStatusDetail(sessionId, directory, modelKey)
    if (getSessionId(api) !== sessionId) return false

    api.ui.dialog.replace(() => <StatusDialog api={api} s={detail} />)
    return true
}

const EmbedDialog = (props: { api: TuiPluginApi; detail: EmbedDetail }) => {
    const theme = createMemo(() => (props.api as any).theme.current)
    const t = () => theme()
    const lines = () => props.detail.statusText.split("\n")
    return (
        <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
            <box justifyContent="center" width="100%" marginBottom={1}>
                <text fg={t().accent}><b>嵌入中</b></text>
            </box>
            {lines().map((line) => (
                <text fg={t().text}>{line}</text>
            ))}
        </box>
    )
}

async function showEmbedDialog(api: TuiPluginApi, targetSessionId = getSessionId(api)): Promise<boolean> {
    const sessionId = targetSessionId
    if (!sessionId) {
        api.ui.toast({ message: "无活跃会话", variant: "warning" })
        return false
    }
    const directory = api.state.path.directory ?? ""
    const detail = await loadEmbedDetail(sessionId, directory)
    if (getSessionId(api) !== sessionId) return false
    api.ui.dialog.replace(() => <EmbedDialog api={api} detail={detail} />)
    return true
}

function showResultDialog(api: TuiPluginApi, title: string, message: string): boolean {
    api.ui.dialog.replace(() => (
        <api.ui.DialogAlert
            title={title}
            message={message}
            onConfirm={() => {}}
        />
    ))
    return true
}


/**
 * Register Magic Context command palette entries, preferring the v1.14.42+
 * `keymap.registerLayer` API and falling back to the legacy
 * `api.command.register` for older hosts.
 *
 * The `keymap.registerLayer` shape uses `name`/`title`/`run`/`namespace`
 * (see `@opencode-ai/plugin/tui` types) and is what the host's own legacy
 * command-shim translates into. Calling it directly skips the deprecation
 * warning and works without depending on the (now-deprecated) `api.command`
 * namespace existing at all.
 *
 * Version coverage:
 *   1.14.0–1.14.41 — `api.command.register` only
 *   1.14.42–1.14.43 — both surfaces broken (api.command removed, keymap landed
 *                     but with bugs); plugins crash on init either way
 *   1.14.44+        — `api.keymap.registerLayer` canonical, `api.command` shim
 */
function registerCommandPaletteEntries(api: TuiPluginApi): void {
    type ApiAny = {
        keymap?: {
            registerLayer?: (layer: {
                commands: Array<Record<string, unknown>>
                bindings: Array<Record<string, unknown>>
            }) => unknown
        }
        command?: {
            register?: (cb: () => Array<Record<string, unknown>>) => unknown
        }
    }
    const apiAny = api as unknown as ApiAny

    if (typeof apiAny.keymap?.registerLayer === "function") {
        // Audit Finding #2 hardening: even when registerLayer exists as a
        // function, the underlying keymap implementation in OpenCode TUI
        // 1.14.42-1.14.43 can throw at call time. Without the try-catch the
        // `return` below would propagate the throw and the legacy
        // `command.register` fallback path (~20 lines down) would be
        // unreachable. The cost is one debug log on the rare broken-TUI
        // build; the benefit is that older command.register-only TUIs
        // running alongside a partially-broken keymap surface still get
        // their command palette entries.
        try {
            apiAny.keymap.registerLayer({
                commands: [
                    {
                        namespace: "palette",
                        name: "magic-context.status",
                        title: "Magic Context: 状态",
                        category: "Magic Context",
                        run() {
                            showStatusDialog(api)
                        },
                    },
                    {
                        namespace: "palette",
                        name: "magic-context.recomp",
                        title: "Magic Context: 重编译",
                        category: "Magic Context",
                        run() {
                            showRecompDialog(api)
                        },
                    },
                ],
                bindings: [],
            })
            return
        } catch (err) {
            console.debug(
                "[magic-context-tui] keymap.registerLayer threw; falling back to command.register",
                err,
            )
            // Fall through to legacy registration.
        }
    }

    if (typeof apiAny.command?.register === "function") {
        apiAny.command.register(() => [
            {
                title: "Magic Context: Status",
                value: "magic-context.status",
                category: "Magic Context",
                onSelect() {
                    showStatusDialog(api)
                },
            },
            {
                title: "Magic Context: Recomp",
                value: "magic-context.recomp",
                category: "Magic Context",
                onSelect() {
                    showRecompDialog(api)
                },
            },
        ])
        return
    }

    // Neither API surface is present. The TUI host can still load — we only
    // lose the command palette entry points. The sidebar (registered above
    // via api.slots.register) remains visible. Status/Recomp are still
    // reachable through the server-side `/ctx-status` and `/ctx-recomp`
    // slash commands, which the server handler bridges to the TUI dialogs
    // via RPC.
}

/**
 * Show the one-shot "What's new" dialog on TUI startup if the server tells us
 * to. The server is the source of truth: it has the version + features
 * constants AND owns the persistence file. We just render and report back.
 *
 * Failure-tolerant by design — if the server isn't ready or the RPC fails,
 * we silently skip (the next TUI launch will retry).
 */
/**
 * URLs render as plain text. Modern terminals (iTerm2, kitty, WezTerm, Ghostty,
 * recent macOS Terminal) auto-detect URLs and let users Cmd-click; older
 * terminals require manual copy. We tried opentui's `<a href>` JSX intrinsic
 * for application-level OSC 8 clickability, but it's a span-like element that
 * forced text out of opentui's word-wrap mode, causing bullets to bleed past
 * the dialog border. Pure-string children of `<text>` wrap correctly, so the
 * AFT-style DialogAlert + plain string is the right surface here.
 */
async function showStartupAnnouncement(api: TuiPluginApi): Promise<void> {
    try {
        const ann = await getAnnouncement()
        if (!ann.show || !ann.version || !ann.features || ann.features.length === 0) return

        const title = `Magic Context v${ann.version}`
        const lines: string[] = [
            "更新内容：",
            "",
            ...ann.features.map((line) => `  • ${line}`),
        ]
        if (ann.footer && ann.footer.trim().length > 0) {
            // Blank-line separator keeps the persistent footer (Discord invite,
            // etc.) visually distinct from the version-specific bullets.
            lines.push("", ann.footer)
        }
        const message = lines.join("\n")

        api.ui.dialog.replace(
            () => (
                <api.ui.DialogAlert
                    title={title}
                    message={message}
                    onConfirm={() => {
                        void markAnnounced()
                    }}
                />
            ),
            () => {
                // User dismissed via Escape rather than confirming. Mark
                // dismissed anyway — they saw the dialog, that's the contract.
                void markAnnounced()
            },
        )
    } catch {
        // RPC not ready yet (port file missing or transient HTTP failure) —
        // silently skip. The next TUI start re-checks.
    }
}

const tui: TuiPlugin = async (api, _options, meta) => {
    // Initialize RPC client for server communication
    const directory = api.state.path.directory ?? ""
    initRpcClient(directory)
    await refreshToastDurationMs()

    // Register sidebar slot
    api.slots.register(createSidebarContentSlot(api))

    // Register TUI command palette entries (no slash field — slash commands
    // are registered server-side so there's only one /ctx-* registration).
    // The server detects TUI mode and sends dialog requests via RPC instead
    // of sendIgnoredMessage.
    //
    // OpenCode 1.14.42 removed `api.command.register` entirely
    // (anomalyco/opencode#26053). A later patch (1.14.44+) reinstated it as
    // a deprecated shim that translates to `api.keymap.registerLayer`. To
    // work across all hosts (1.14.0–1.14.41 with command-only, the broken
    // 1.14.42–1.14.43, and 1.14.44+ where both exist), we prefer
    // `api.keymap.registerLayer` and fall back to `api.command.register`
    // only when keymap is missing.
    registerCommandPaletteEntries(api)

    // Receive server→TUI notifications (toasts + dialog requests) over a single
    // persistent WebSocket, pushed the instant the server queues them. This
    // replaces the old 500ms HTTP poll whose new-connection-per-tick cost was the
    // source of idle TUI CPU (#200). The socket carries the active session in its
    // hello so the server scopes delivery; here we re-check the active session per
    // notification (it can change between queue and delivery) before acting.
    const handleNotification = async (n: SocketNotification): Promise<boolean> => {
        const requestedSessionId = getSessionId(api)
        const generation = getRpcGeneration()
        // A session-scoped notification only applies while we're viewing that
        // session; global (session-less) ones always apply. Returning false leaves
        // it unacked so a TUI on the right session (or a later switch back) still
        // gets it.
        if (n.sessionId && requestedSessionId && n.sessionId !== requestedSessionId) {
            return false
        }
        if (n.type === "toast") {
            const p = n.payload
            showToast(api, {
                message: String(p.message ?? ""),
                variant: (p.variant as "info" | "warning" | "error" | "success") ?? "info",
                durationOverrideMs:
                    typeof p.duration === "number" && Number.isFinite(p.duration)
                        ? p.duration
                        : undefined,
            })
            return true
        }
        if (n.type !== "action") return false
        const action = n.payload?.action
        const stillActive = () =>
            getRpcGeneration() === generation && getSessionId(api) === requestedSessionId
        if (action === "show-status-dialog") {
            return stillActive() && (await showStatusDialog(api, requestedSessionId))
        }
        if (action === "show-recomp-dialog") {
            return stillActive() && (await showRecompDialog(api, requestedSessionId))
        }
        if (action === "show-upgrade-dialog") {
            const resume =
                n.payload?.resume === true
                    ? {
                          stagedCount: Number(n.payload?.stagedCount ?? 0),
                          stagedThrough: Number(n.payload?.stagedThrough ?? 0),
                      }
                    : undefined
            return stillActive() && showUpgradeDialog(api, resume, requestedSessionId)
        }
        if (action === "show-embed-dialog") {
            return stillActive() && (await showEmbedDialog(api, requestedSessionId))
        }
        if (action === "show-flush-dialog") {
            const flushMsg = String(n.payload?.message ?? "已刷新。")
            return stillActive() && showResultDialog(api, "刷新", flushMsg)
        }
        if (action === "show-result-dialog") {
            const title = String(n.payload?.title ?? "Magic Context")
            const body = String(n.payload?.message ?? "")
            return stillActive() && showResultDialog(api, title, body)
        }
        return false
    }

    startNotificationSocket({
        getSessionId: () => getSessionId(api),
        onNotification: handleNotification,
    })

    // Clean up on dispose
    api.lifecycle.onDispose(() => {
        stopNotificationSocket()
        closeRpc()
    })

    const conflictResult = detectConflicts(directory)
    if (conflictResult.hasConflict) {
        showConflictDialog(api, directory, conflictResult.reasons, conflictResult.conflicts)
        return
    }

    // Show one-shot release announcement after conflict gate.
    // Fire-and-forget: if the server isn't ready or RPC fails, the next TUI
    // launch will retry. Dialog only appears once per ANNOUNCEMENT_VERSION
    // (persisted via mark-announced RPC writing last_announced_version).
    void showStartupAnnouncement(api)
}

const id = "opencode-magic-context"

export default {
    id,
    tui,
}
