// Channel 2 delivery: the synthetic-user-message ceiling nudge.
//
// The transform records a one-shot `pending` intent in `session_meta`
// (`channel2_nudge_state`) when pressure is near the execute threshold and a
// large pile of reclaimable tool output remains. This module DELIVERS that
// intent from the event handler (`message.updated`), because `promptAsync`
// must run on an event boundary, not mid-transform.
//
// Lease state machine (cross-process CAS): pending -> claimed -> delivered.
//   - claim `pending -> claimed` before send (so two processes can't both send)
//   - on confirmed success: `claimed -> delivered` (cap consumed, terminal)
//   - on failure: revert `claimed -> pending` (don't burn the one ceiling nudge
//     on a transient error)
//
// Delivery transport is the live-server client ONLY (no in-process fallback):
// plain TUI's listener 404s the probe, so Channel 2 is disabled there and the
// 85% force-materialization remains the backstop. MC will not knowingly trigger
// the duplicate-runner bug (anomalyco/opencode#28202).

import {
    casChannel2NudgeState,
    getChannel2NudgeState,
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
import { buildChannel2Reminder, CHANNEL2_CEIL_UNDROPPED } from "./ctx-reduce-nudge";

export interface Channel2DeliveryDeps {
    db: Database;
    serverUrl?: string;
    directory: string;
    /** Undropped tool tokens for the wording; falls back to the trigger floor. */
    undroppedTokens?: number;
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
    // the reclaimable tail), so the ceiling condition no longer holds. Firing
    // the synthetic nudge anyway would inject a stale "you have N tokens to
    // drop" message AND consume the one-per-session cap for nothing. When the
    // current undropped-tool count is known and has fallen below the trigger
    // floor, cancel the intent by resetting to '' — NOT 'delivered' — so the
    // cap is preserved and a genuinely high-pressure later turn can re-arm it.
    if (deps.undroppedTokens !== undefined && deps.undroppedTokens < CHANNEL2_CEIL_UNDROPPED) {
        try {
            casChannel2NudgeState(deps.db, sessionId, "pending", "");
            sessionLog(
                sessionId,
                `channel2 intent cleared pre-delivery (undropped ${deps.undroppedTokens} < ${CHANNEL2_CEIL_UNDROPPED}; re-armable)`,
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
        const reminder = buildChannel2Reminder(deps.undroppedTokens ?? CHANNEL2_CEIL_UNDROPPED);

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

        // Confirmed: consume the one-shot cap (terminal).
        casChannel2NudgeState(deps.db, sessionId, "claimed", "delivered");
        sessionLog(sessionId, "channel2 ceiling nudge delivered");
        return true;
    } catch (error) {
        // Revert so the single ceiling nudge isn't permanently burned on a
        // transient failure; a later event re-attempts.
        casChannel2NudgeState(deps.db, sessionId, "claimed", "pending");
        sessionLog(sessionId, "channel2 ceiling nudge delivery failed (will retry):", error);
        return false;
    }
}
