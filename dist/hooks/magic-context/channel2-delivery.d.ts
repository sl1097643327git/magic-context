import type { Database } from "../../shared/sqlite";
import { type ToolReclaimHint } from "./ctx-reduce-nudge";
export interface Channel2DeliveryDeps {
    db: Database;
    /**
     * The in-process client OpenCode hands the plugin (`input.client`). Channel 2
     * delivers the synthetic-user ceiling nudge through `client.session.promptAsync`.
     * No-op when absent (e.g. a context with no client wired).
     */
    client?: unknown;
    /** Reclaimable tool-output tokens for the wording + stale-intent revalidation. */
    reclaimableTokens?: number;
    /**
     * The usable working range measured at the same Channel-1 baseline refresh
     * (see Channel1State.usableTokens). Required to re-run the FULL trigger
     * predicate at delivery time.
     */
    usableTokens?: number;
    oldestReclaimableToolTags?: readonly ToolReclaimHint[];
}
/**
 * Attempt to deliver a pending Channel 2 ceiling nudge for `sessionId`. Safe to
 * call on every step-boundary `message.updated`: it no-ops unless a `pending`
 * intent exists and a client is wired. Returns true only when a delivery was
 * confirmed (intent moved to `delivered`).
 */
export declare function maybeDeliverChannel2(sessionId: string, deps: Channel2DeliveryDeps): Promise<boolean>;
//# sourceMappingURL=channel2-delivery.d.ts.map