import type { ContextDatabase } from "../../features/magic-context/storage";
export declare const DEFAULT_CONTEXT_LIMIT = 128000;
type CacheTtlConfig = string | Record<string, string>;
/**
 * Resolve the effective context limit for a (providerID, modelID) pair.
 *
 * Resolution order:
 *   1. Detected limit from a prior overflow error, when smaller than the
 *      configured/cache limit. Providers report the REAL limit in the error
 *      message, which is authoritative for the current deployment.
 *   2. OpenCode's models.dev cache (overlaid with user's
 *      `provider.*.models.*.limit.context`).
 *   3. Conservative default (128k).
 *
 * The session context (db + sessionID) is optional — callers that operate
 * outside a specific session (e.g. warm-up, status-bar summaries) can omit it
 * and fall back to the global cache/default.
 */
export declare function resolveContextLimit(providerID: string | undefined, modelID: string | undefined, ctx?: {
    db?: ContextDatabase;
    sessionID?: string;
}): number;
/**
 * Like resolveContextLimit, but returns a limit ONLY when it is TRUSTED for the
 * current model — i.e. it came from a real models.dev hit (or user override) or
 * a detected-overflow limit. Returns `undefined` when neither is available,
 * rather than the generic 128K `DEFAULT_CONTEXT_LIMIT`.
 *
 * The history-budget resolver needs this distinction: deriving the decay budget
 * from a bare 128K guess for an UNKNOWN model would shrink history below what
 * the live-usage back-derivation would yield for a large-context model. So the
 * budget resolver only trusts a real/detected limit and otherwise falls back to
 * live-usage. (resolveContextLimit itself must keep returning 128K for pressure
 * math, which needs a positive denominator.)
 */
export declare function resolveTrustedContextLimit(providerID: string | undefined, modelID: string | undefined, ctx?: {
    db?: ContextDatabase;
    sessionID?: string;
}): number | undefined;
export declare function resolveCacheTtl(cacheTtl: CacheTtlConfig, modelKey: string | undefined): string;
type ExecuteThresholdConfig = number | {
    default: number;
    [modelKey: string]: number;
};
type ExecuteThresholdTokensConfig = {
    default?: number;
    [modelKey: string]: number | undefined;
} | undefined;
export interface ExecuteThresholdOptions {
    /** Optional tokens-based threshold config. When matched for the given modelKey,
     *  overrides the percentage-based threshold. */
    tokensConfig?: ExecuteThresholdTokensConfig;
    /** Required when `tokensConfig` is provided — used to convert tokens → percentage
     *  and to clamp values above 80% × context_limit. */
    contextLimit?: number;
    /** Session ID for warn logs when clamping. If absent, warns to global log. */
    sessionId?: string;
}
export type ExecuteThresholdMode = "percentage" | "tokens";
export interface ExecuteThresholdDetail {
    /** Effective execute threshold as a percentage (0–80). Downstream math keys off this. */
    percentage: number;
    /** Which source was authoritative: tokens config (when matched + valid context) or percentage. */
    mode: ExecuteThresholdMode;
    /** When mode is "tokens", the absolute token value after clamping (≤ 80% × contextLimit). */
    absoluteTokens?: number;
    /** The config key that matched, if any (for display/debugging). `"default"` when default fallback. */
    matchedKey?: string;
}
/**
 * Single source of truth for execute-threshold resolution. Returns the effective
 * percentage plus which config source was authoritative. Callers that only need
 * the percentage can use `resolveExecuteThreshold` (thin wrapper below); callers
 * that surface the mode to users (`/ctx-status`, TUI, RPC) must use this directly
 * to avoid the "progressive lookup drift" bug where two call sites disagree on
 * whether tokens mode is active.
 */
export declare function resolveExecuteThresholdDetail(config: ExecuteThresholdConfig, modelKey: string | undefined, fallback: number, options?: ExecuteThresholdOptions): ExecuteThresholdDetail;
/**
 * Backward-compatible wrapper around `resolveExecuteThresholdDetail`.
 * Use the detail version when you also need the mode or absolute token value.
 */
export declare function resolveExecuteThreshold(config: ExecuteThresholdConfig, modelKey: string | undefined, fallback: number, options?: ExecuteThresholdOptions): number;
export declare function resolveModelKey(providerID: string | undefined, modelID: string | undefined): string | undefined;
export declare function resolveSessionId(properties: {
    info?: unknown;
    sessionID?: string;
} | undefined): string | undefined;
export {};
//# sourceMappingURL=event-resolvers.d.ts.map