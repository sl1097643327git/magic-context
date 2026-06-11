// Channel 2 delivery: the synthetic-user-message ceiling nudge.
//
// The transform records a one-shot `pending` intent in `session_meta`
// (`channel2_nudge_state`) when pressure is near the execute threshold and a
// large pile of reclaimable tool output remains. This module DELIVERS that
// intent from the event handler (`message.updated`, both mid-turn
// "tool-calls" and final "stop" events), because `promptAsync` must run on an
// event boundary, not mid-transform. Mid-turn delivery is deliberate: the
// queued user message is picked up by OpenCode's run loop at the next step
// boundary, warning the agent WHILE the reclaimable pile is growing instead
// of after the turn already ballooned.
//
// Lease state machine (cross-process CAS): pending -> claimed -> delivered.
//   - claim `pending -> claimed` before send (so two processes can't both send)
//   - on confirmed success: `claimed -> delivered` (cap consumed, terminal)
//   - on send failure: revert `claimed -> pending` (don't burn the one ceiling
//     nudge on a transient transport error)
//   - after a successful send: never revert to pending, even if confirmation
//     fails; the user message may already exist and re-arming duplicates it.
//
// Delivery transport is the live-server client ONLY (no in-process fallback):
// plain TUI's listener 404s the probe, so Channel 2 is disabled there and the
// 85% force-materialization remains the backstop. MC will not knowingly trigger
// the duplicate-runner bug (anomalyco/opencode#28202).

import {
    casChannel2NudgeState,
    getChannel2NudgeState,
    setChannel2NudgeState,
} from "../../features/magic-context/storage-meta-persisted";
import {
    getLiveServerClient,
    hasFreshProbe,
    probeServerReachable,
    useLiveServerWake,
} from "../../shared/live-server-client";
import { sessionLog } from "../../shared/logger";
import { resolvePromptContext } from "../../shared/prompt-context";
import type { Database } from "../../shared/sqlite";
import { buildChannel2Reminder, shouldTriggerChannel2 } from "./ctx-reduce-nudge";

export interface Channel2DeliveryDeps {
    db: Database;
    serverUrl?: string;
    directory: string;
    /** Reclaimable tool-output tokens for the wording + stale-intent revalidation. */
    reclaimableTokens?: number;
    /**
     * The usable working range measured at the same Channel-1 baseline refresh
     * (see Channel1State.usableTokens). Required to re-run the FULL trigger
     * predicate at delivery time.
     */
    usableTokens?: number;
}

/**
 * Attempt to deliver a pending Channel 2 ceiling nudge for `sessionId`. Safe to
 * call on every final-stop `message.updated` — it no-ops unless a `pending`
 * intent exists and the live server is reachable. Returns true only when a
 * delivery was confirmed (intent moved to `delivered`).
 */
export async function maybeDeliverChannel2(
    sessionId: string,
    deps: Channel2DeliveryDeps,
): Promise<boolean> {
    // Cheap pre-check: only proceed if an intent is pending.
    let state: string;
    try {
        state = getChannel2NudgeState(deps.db, sessionId);
    } catch {
        return false;
    }
    if (state !== "pending") return false;

    // Revalidate before delivering. The `pending` intent was recorded at high
    // pressure during a transform pass; between then and this terminal
    // message.updated the agent may have run ctx_reduce (or a later turn shrank
    // the reclaimable tail), so the ceiling condition may no longer hold.
    // Firing the synthetic nudge anyway would inject a stale "you have N tokens
    // to drop" message AND consume the one-per-session cap for nothing.
    //
    // Two rules, both cap-preserving:
    // - UNKNOWN baseline (no fresh measurement at this event) → do NOT deliver
    //   and do NOT touch the lease: leave `pending` for a later final-stop that
    //   has a real measurement. Never substitute a default and burn the cap on
    //   an unvalidated condition.
    // - KNOWN baseline → re-run the FULL trigger predicate (floor AND the
    //   reclaimable ≥ usable/3 ratio — the same one that armed the intent),
    //   not just the floor. Predicate false → cancel to '' (re-armable).
    if (deps.reclaimableTokens === undefined || deps.usableTokens === undefined) {
        return false;
    }
    if (
        !shouldTriggerChannel2({
            reclaimableTokens: deps.reclaimableTokens,
            usableTokens: deps.usableTokens,
        })
    ) {
        try {
            casChannel2NudgeState(deps.db, sessionId, "pending", "");
            sessionLog(
                sessionId,
                `channel2 intent cleared pre-delivery (reclaimable ${deps.reclaimableTokens}, usable ${deps.usableTokens} — trigger no longer holds; re-armable)`,
            );
        } catch {
            // best-effort; if the CAS fails the next pass re-evaluates.
        }
        return false;
    }

    const { serverUrl } = deps;
    if (!serverUrl) return false;

    // Probe the live listener if we don't have a fresh decision. Plain TUI 404s
    // here -> Channel 2 stays disabled (no in-process fallback).
    if (!hasFreshProbe(serverUrl)) {
        await probeServerReachable(serverUrl);
    }
    if (!useLiveServerWake(serverUrl)) return false;

    // Claim the intent before sending so a sibling process can't double-deliver.
    if (!casChannel2NudgeState(deps.db, sessionId, "pending", "claimed")) {
        return false;
    }

    try {
        const client = getLiveServerClient(serverUrl, deps.directory);
        const promptContext = await resolvePromptContext(client, sessionId);
        // reclaimableTokens is guaranteed defined here (unknown-baseline path
        // returned above), so the wording always reflects a real measurement.
        const reminder = buildChannel2Reminder(deps.reclaimableTokens);

        const body: Record<string, unknown> = {
            noReply: false,
            parts: [{ type: "text", text: reminder }],
        };
        if (promptContext?.agent) body.agent = promptContext.agent;
        if (promptContext?.model) {
            body.model = {
                providerID: promptContext.model.providerID,
                modelID: promptContext.model.modelID,
            };
        }
        if (promptContext?.variant) body.variant = promptContext.variant;

        const session = (client as { session?: { promptAsync?: (i: unknown) => Promise<unknown> } })
            .session;
        if (typeof session?.promptAsync !== "function") {
            throw new Error("live-server client has no session.promptAsync");
        }
        await session.promptAsync({ path: { id: sessionId }, body });
    } catch (error) {
        // Revert only when the send itself failed. Once promptAsync returns, the
        // synthetic user message may already exist; re-arming can duplicate it.
        casChannel2NudgeState(deps.db, sessionId, "claimed", "pending");
        sessionLog(sessionId, "channel2 ceiling nudge delivery failed (will retry):", error);
        return false;
    }

    try {
        // Confirmed: consume the one-shot cap (terminal). The CAS result is
        // authoritative; a stolen/expired claim must not be treated as delivered.
        const confirmed = casChannel2NudgeState(deps.db, sessionId, "claimed", "delivered");
        if (confirmed) {
            sessionLog(sessionId, "channel2 ceiling nudge delivered");
            return true;
        }
        try {
            // The send happened. If another process rewound the row before our
            // confirm, seal the one-shot cap rather than leaving a re-deliverable
            // pending intent behind. Return false because OUR claim was not the
            // authoritative terminal transition.
            setChannel2NudgeState(deps.db, sessionId, "delivered");
        } catch {
            // Best-effort; if storage is unavailable we still must not revert.
        }
        sessionLog(sessionId, "channel2 ceiling nudge sent but claim confirmation was lost");
        return false;
    } catch (error) {
        // Post-send DB failure: do NOT revert to pending, because the send already
        // happened and retrying risks a duplicate ceiling nudge.
        try {
            setChannel2NudgeState(deps.db, sessionId, "delivered");
        } catch {
            // Best-effort; the important invariant is never re-arming here.
        }
        sessionLog(sessionId, "channel2 ceiling nudge sent but confirm failed:", error);
        return false;
    }
}
