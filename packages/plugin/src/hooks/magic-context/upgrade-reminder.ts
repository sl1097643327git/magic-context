import { clearRecompStaging } from "../../features/magic-context/compartment-storage";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta-session";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";

/**
 * E5 — Session upgrade reminder (v2).
 *
 * When a session still holds pre-v2 (legacy) compartments, those render in a
 * degraded title-only/P4 form until the user runs `/ctx-session-upgrade`. This
 * surfaces a ONE-TIME, model-invisible reminder pointing at the command.
 *
 * Cache-safety (locked design): the reminder is delivered as an IGNORED message
 * (user-visible, never sent to the model), NOT appended to a user message — so it
 * has zero effect on the cacheable prompt prefix. No anchor/replay machinery needed.
 *
 * Fires at most once per session via two guards (locked decision 47661):
 *  1. Durable `upgrade_reminded_at` stamp — survives restart, prevents re-nudging.
 *  2. Per-process in-memory set — prevents a double-fire within one process before
 *     the durable stamp is read back.
 *
 * Skip-forever model: there is no 4-state machine. A session is either "has legacy
 * compartments and not yet reminded" (remind once) or not. Running the upgrade
 * clears the legacy rows, so the condition naturally stops being true.
 */

const remindedThisProcess = new Set<string>();

// Non-TUI (Desktop/Web/headless) reminder text. Mirrors the TUI dialog copy but,
// since there is no clickable button here, it ends with the explicit slash command.
const UPGRADE_REMINDER_TEXT = [
    "🎆 Historian V2 is released!",
    "",
    "This session's compartments are written by the old historian. The session is still usable with its old compartments, however it's strongly advised to upgrade them to the new format. This means every compartment needs to be reprocessed by the new historian, which might take a while depending on how big your session is.",
    "",
    "Running the upgrade will:",
    "• Rebuild this session's compartments into the new layered format",
    "• Re-organize this project's memories into the new taxonomy (once per project)",
    "",
    "The historian runs in the background and you can keep working while older compartments are reprocessed.",
    "",
    "Run `/ctx-session-upgrade` to upgrade now.",
].join("\n");

/** A compartment needs upgrading when it lacks usable v2 tiers — either a pre-v2
 *  `legacy=1` row, OR a malformed "pseudo-v2" row flagged `legacy=0` but with no
 *  `p1` tier (e.g. from an interrupted/crashed recomp, or an older partial-v2
 *  build). The `legacy=0 ⟹ has tiers` invariant can break from any partial state,
 *  which would otherwise TRAP the session — the old gate said "already upgraded"
 *  and refused to re-run (dogfood 2026-05-30, AFT session with 541 tierless rows).
 *  Single source of truth shared with the upgrade gate in recomp-orchestrator. */
export const NEEDS_UPGRADE_SQL = "(legacy = 1 OR p1 IS NULL OR p1 = '')";

function hasLegacyCompartments(db: Database, sessionId: string): boolean {
    try {
        const row = db
            .prepare(
                `SELECT COUNT(*) AS count FROM compartments WHERE session_id = ? AND ${NEEDS_UPGRADE_SQL}`,
            )
            .get(sessionId) as { count?: number } | undefined;
        return typeof row?.count === "number" && row.count > 0;
    } catch {
        return false;
    }
}

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

function getResumeInfo(db: Database, sessionId: string): ResumeInfo | null {
    try {
        const row = db
            .prepare(
                "SELECT COUNT(*) AS count, COALESCE(MAX(end_message), 0) AS through FROM recomp_compartments WHERE session_id = ?",
            )
            .get(sessionId) as { count?: number; through?: number } | undefined;
        if (typeof row?.count === "number" && row.count > 0) {
            return { stagedCount: row.count, stagedThrough: Number(row.through ?? 0) };
        }
        return null;
    } catch {
        return null;
    }
}

/** Resume-flavored reminder copy for the non-TUI (Desktop/headless) path. */
function buildResumeReminderText(resume: ResumeInfo): string {
    return [
        "🎆 Resume the interrupted upgrade?",
        "",
        `An earlier upgrade to the new historian format was interrupted. ${resume.stagedCount} compartment${resume.stagedCount === 1 ? " was" : "s were"} already rebuilt (through message ${resume.stagedThrough}). Resuming continues from where it left off — nothing already rebuilt is reprocessed.`,
        "",
        "Run `/ctx-session-upgrade` to resume now.",
    ].join("\n");
}

export interface UpgradeReminderDeps {
    client: unknown;
    db: Database;
    /** Delivers a model-invisible ignored message to the session (non-TUI path:
     *  Desktop/headless, where it persists in scrollback). */
    sendIgnoredMessage: (
        client: unknown,
        sessionId: string,
        text: string,
        params: Record<string, unknown>,
    ) => Promise<void>;
    /** Live notification params (model/variant/agent) for the active session. */
    getNotificationParams: (sessionId: string) => Record<string, unknown>;
    /** True when a TUI client is actively polling (decides dialog vs ignored msg).
     *  Optional: harnesses without an OpenCode-style TUI dialog system (e.g. Pi,
     *  which delivers via `ctx.ui.notify`) omit this and always take the
     *  `sendIgnoredMessage` path. */
    isTuiConnected?: () => boolean;
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
export async function maybeSendUpgradeReminder(
    deps: UpgradeReminderDeps,
    sessionId: string,
): Promise<void> {
    if (remindedThisProcess.has(sessionId)) return;

    let meta: ReturnType<typeof getOrCreateSessionMeta>;
    try {
        meta = getOrCreateSessionMeta(deps.db, sessionId);
    } catch {
        return;
    }
    if (meta.isSubagent) {
        remindedThisProcess.add(sessionId);
        return;
    }

    // MASTER GATE: a reminder (fresh OR resume) is only warranted when the
    // session still holds legacy/tierless compartments that need upgrading.
    // This must gate BOTH paths. Keying the resume prompt off staging-rows
    // ALONE is wrong: a fully-upgraded session can still carry orphan
    // `recomp_compartments` rows left by a superseded/interrupted-then-completed
    // recomp (the "already upgraded" early-return in runManagedUpgrade doesn't
    // clear staging), which would falsely show "Resume the interrupted upgrade?"
    // with stale counts on every restart (dogfood 2026-05-31, AFT session:
    // 443 v2 compartments, 0 legacy, yet 489 orphan staging rows triggered it).
    if (!hasLegacyCompartments(deps.db, sessionId)) {
        // Fully upgraded → nothing to remind. Garbage-collect any orphan staging
        // so it can't trigger a false resume prompt later. Do NOT stamp
        // upgradeRemindedAt: a future pre-v2 session restored into this DB could
        // still need reminding.
        const orphan = getResumeInfo(deps.db, sessionId);
        if (orphan) {
            try {
                clearRecompStaging(deps.db, sessionId);
                sessionLog(
                    sessionId,
                    `upgrade-reminder: cleared ${orphan.stagedCount} orphan staging row(s) on fully-upgraded session`,
                );
            } catch {
                /* best-effort GC */
            }
        }
        return;
    }

    // The session genuinely needs upgrade. An INTERRUPTED upgrade (partial recomp
    // staging present AND legacy compartments remaining) re-prompts even when the
    // durable stamp is set — otherwise a user who started a long upgrade, closed
    // mid-run, and reopened would get NO signal to resume. The per-process
    // `remindedThisProcess` guard still caps this at one prompt per `opencode
    // serve` lifetime (re-prompts on the next reopen, which is correct).
    const resume = getResumeInfo(deps.db, sessionId);

    // The durable `upgrade_reminded_at` stamp is meaningful only when delivery
    // persists in scrollback. For transient delivery (Pi toast) the stamp is
    // never written, so it must not be read as a gate either — otherwise a stale
    // stamp from a pre-fix build would suppress forever. Pi relies on the
    // per-process guard, re-prompting each start until the session is upgraded.
    const durableStampActive = deps.deliveryPersists !== false;

    if (!resume && durableStampActive) {
        // Fresh-upgrade path: gated by the one-shot durable stamp.
        if (meta.upgradeRemindedAt !== null) {
            remindedThisProcess.add(sessionId);
            return;
        }
    }

    // In-memory guard prevents same-process re-fire regardless of path.
    remindedThisProcess.add(sessionId);

    const kind = resume ? "resume" : "fresh";

    // TUI path: show a persistent, INTERACTIVE dialog with a "Run upgrade now"
    // action — not a 5-second toast that's trivially missed for a one-time,
    // actionable notice. Non-TUI (Desktop/headless) path: a persisted ignored
    // message that stays visible in scrollback.
    try {
        if (deps.isTuiConnected?.() && deps.pushTuiDialogAction) {
            // Do NOT durably stamp on mere display. The durable stamp is set only
            // when the user makes an EXPLICIT choice (Confirm/Cancel) via the
            // `dismiss-upgrade-reminder` RPC. Stamping on display would permanently
            // suppress the dialog if the user closed / ctrl-c'd before acting,
            // trapping a never-upgraded session with no way to be reminded again
            // (dogfood 2026-05-30). The per-process guard still prevents spam
            // within this process; a new process re-shows until the user decides.
            deps.pushTuiDialogAction(sessionId, resume ?? undefined);
            sessionLog(sessionId, `upgrade-reminder: TUI dialog action enqueued (${kind})`);
        } else {
            // Non-TUI (Desktop/headless): no interactive buttons, so the persisted
            // ignored message IS the one-shot delivery. Stamp on send so we don't
            // re-post a duplicate every restart. (Resume re-fires via staging
            // regardless of the stamp.) Skip the stamp for TRANSIENT delivery
            // (Pi toast) — see deliveryPersists: stamping a toast that leaves no
            // scrollback would permanently suppress after one missed toast.
            if (durableStampActive && meta.upgradeRemindedAt === null) {
                try {
                    updateSessionMeta(deps.db, sessionId, { upgradeRemindedAt: Date.now() });
                } catch {
                    // best-effort — still avoid a same-process re-fire (guard set above)
                }
            }
            await deps.sendIgnoredMessage(
                deps.client,
                sessionId,
                resume ? buildResumeReminderText(resume) : UPGRADE_REMINDER_TEXT,
                deps.getNotificationParams(sessionId),
            );
            sessionLog(sessionId, `upgrade-reminder: ignored message delivered (${kind}, non-TUI)`);
        }
    } catch (error) {
        sessionLog(sessionId, `upgrade-reminder: delivery failed: ${String(error)}`);
    }
}

/** Test-only: reset the per-process guard. */
export function __resetUpgradeReminderProcessGuard(): void {
    remindedThisProcess.clear();
}

export { UPGRADE_REMINDER_TEXT };
