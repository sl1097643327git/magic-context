import type { Database } from "../../shared/sqlite";
import type { NotificationDeliveryDisposition } from "./send-session-notification";
declare const UPGRADE_REMINDER_TEXT: string;
/** A compartment needs upgrading when it lacks usable v2 tiers — either a pre-v2
 *  `legacy=1` row, OR a malformed "pseudo-v2" row flagged `legacy=0` but with no
 *  `p1` tier (e.g. from an interrupted/crashed recomp, or an older partial-v2
 *  build). The `legacy=0 ⟹ has tiers` invariant can break from any partial state,
 *  which would otherwise TRAP the session — the old gate said "already upgraded"
 *  and refused to re-run (dogfood 2026-05-30, AFT session with 541 tierless rows).
 *  Single source of truth shared with the upgrade gate in recomp-orchestrator. */
export declare const NEEDS_UPGRADE_SQL = "(legacy = 1 OR p1 IS NULL OR p1 = '')";
/**
 * Count compartments that still need a v2 upgrade (pre-v2 `legacy=1` rows OR
 * tierless `p1 IS NULL/''` rows from an interrupted/old partial build). Shared
 * with the Pi /ctx-status dialog (Pi has no sidebar, so it surfaces upgrade
 * status here) and the OpenCode upgrade gate. Returns 0 on any error.
 */
export declare function countCompartmentsNeedingUpgrade(db: Database, sessionId: string): number;
/** Partial recomp staging from an INTERRUPTED upgrade — completed historian
 *  passes are committed to `recomp_compartments` per-pass and only promoted to
 *  the real tables at the very end, so a mid-upgrade close leaves staged progress
 *  there that the next run resumes from (it does NOT restart from scratch). */
export interface ResumeInfo {
    /** Compartments already rebuilt and staged. */
    stagedCount: number;
    /** Raw message ordinal the staged work covers through. */
    stagedThrough: number;
}
export interface UpgradeReminderDeps {
    client: unknown;
    db: Database;
    /** Delivers a model-invisible ignored message to the session (non-TUI path:
     *  Desktop/headless, where it persists in scrollback). */
    sendIgnoredMessage: (client: unknown, sessionId: string, text: string, params: Record<string, unknown>) => Promise<NotificationDeliveryDisposition>;
    /** Live notification params (model/variant/agent) for the active session. */
    getNotificationParams: (sessionId: string) => Record<string, unknown>;
    /** True when a TUI client is actively polling FOR THIS SESSION (decides
     *  dialog vs ignored msg). Must be session-scoped: a TUI on a different
     *  session in the same process must not make this session take the dialog
     *  path. Optional: harnesses without an OpenCode-style TUI dialog system
     *  (e.g. Pi, which delivers via `ctx.ui.notify`) omit this and always take
     *  the `sendIgnoredMessage` path. */
    isTuiConnected?: (sessionId?: string) => boolean;
    /** Enqueue a server→TUI action so the TUI shows an interactive upgrade dialog
     *  ("Run upgrade now"/"Later") instead of a transient toast. TUI path only;
     *  omitted on harnesses without a dialog system. When `resume` is set, the
     *  dialog shows resume-flavored copy. */
    pushTuiDialogAction?: (sessionId: string, resume?: ResumeInfo) => void;
    /** Whether the non-TUI `sendIgnoredMessage` delivery PERSISTS in the user's
     *  scrollback. Default true (OpenCode Desktop ignored messages persist).
     *
     *  Pi delivers via `ctx.ui.notify`, a TRANSIENT toast that vanishes and
     *  leaves no scrollback. Stamping `upgrade_reminded_at` on a transient toast
     *  permanently suppresses the reminder after a single missed toast (dogfood
     *  2026-05-31, Pi session 019de471: one 10:36 toast stamped the session and
     *  it never re-prompted). When false, the durable stamp is neither written
     *  NOR read as a gate — the per-process guard alone dedups, so the reminder
     *  re-fires on each process start until the session is actually upgraded
     *  (legacy compartments cleared) — mirroring the TUI "don't stamp on mere
     *  display" principle. */
    deliveryPersists?: boolean;
}
/**
 * Send the one-time upgrade reminder if this session needs it. Safe to call on
 * every `chat.message`; it self-gates and is a no-op once reminded or once the
 * session has no legacy compartments.
 *
 * Subagent sessions are skipped — they're short-lived and not user-facing.
 */
export declare function maybeSendUpgradeReminder(deps: UpgradeReminderDeps, sessionId: string): Promise<void>;
/** Test-only: reset the per-process guard. */
export declare function __resetUpgradeReminderProcessGuard(): void;
export { UPGRADE_REMINDER_TEXT };
//# sourceMappingURL=upgrade-reminder.d.ts.map