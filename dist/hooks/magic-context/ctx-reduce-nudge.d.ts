import type { MessageLike } from "./tag-messages";
export type Channel1Level = "gentle" | "firm" | "urgent";
export interface ToolReclaimHint {
    tagNumber: number;
    toolName: string | null;
}
/**
 * Per-session metric baseline, snapshotted at the END of each transform pass
 * (post-drop, so `tailToolTokens` reflects the actually-rendered tail) and read
 * by Channel 1 in `tool.execute.after`. `turnToolTokens` accumulates this turn's
 * tool outputs since the last snapshot; it is zeroed when the snapshot is
 * refreshed (a proven turn transition), NOT on `chat.message` — chat.message
 * fires mid-turn for queued messages and would erase live-turn bytes.
 * Only written for full-feature (primary) sessions; its absence is how Channel 1
 * stays off for subagents in Phase 1.
 */
export interface Channel1State {
    tailToolTokens: number;
    historyBudgetTokens: number;
    contextLimit: number;
    executeThresholdPercentage: number;
    lastInputTokens: number;
    turnToolTokens: number;
    /**
     * The usable working range (executeThresholdTokens − inputTokens +
     * liveTail) measured at the same baseline refresh. Carried so Channel-2
     * delivery can revalidate the FULL trigger predicate (reclaimable ≥
     * usable/3), not just the 10k floor — a floor-only recheck let a stale
     * intent deliver and permanently burn the one-per-session ceiling cap.
     */
    usableTokens: number;
    /**
     * True once the agent calls `ctx_reduce` after the last baseline refresh.
     * Suppresses Channel 1 until the next transform recomputes `tailToolTokens`
     * from the now-reduced messages (the in-flight baseline still shows the
     * pre-reduce high value, so without this we'd nag on the very next tool).
     * Reset to false on each baseline refresh.
     */
    reducedSinceRefresh: boolean;
    oldestReclaimableToolTags: ToolReclaimHint[];
}
export declare const CHANNEL1_SENTINEL = "<system-reminder>";
export declare const TOKENS_PER_BYTE = 0.25;
export declare const CHANNEL1_FLOOR_TOKENS = 10000;
export declare const CHANNEL1_REFIRE_FLOOR_TOKENS = 10000;
export declare function channel1RefireTokens(workingWindowTokens: number): number;
export declare const CHANNEL1_PRESSURE_FLOOR = 0.8;
/**
 * Whether a tool output string is a drop/truncation sentinel (so it should NOT
 * count toward reclaimable `undropped` tokens). Exported so the Pi harness — whose
 * tool output lives in `toolResult.content[].text`, not OpenCode's
 * `parts[].state.output` — can reuse the exact same sentinel detection.
 */
export declare function isDroppedToolOutput(output: string): boolean;
/**
 * Sum approximate tokens of non-dropped tool output from a list of already-
 * extracted output strings. Harness-agnostic core shared by OpenCode
 * (`computeTailToolTokens`) and Pi (`toolResult.content[].text` extraction).
 */
export declare function tailToolTokensFromStrings(outputs: readonly string[]): number;
/**
 * Sum approximate tokens of non-dropped tool output across the visible
 * messages. The compartment-injection step has already trimmed everything
 * before the last compartment boundary, so `messages` IS the live tail —
 * walking it gives the post-boundary undropped tool tokens without any tag
 * query or boundary filter.
 */
export declare function computeTailToolTokens(messages: MessageLike[]): number;
/** Approximate tokens for a single tool output string (prospective per-turn accounting). */
export declare function toolOutputTokens(output: string): number;
export interface TailTokenEstimate {
    /** Non-dropped tool-output tokens: reclaimable by ctx_reduce. */
    tailToolTokens: number;
    /** Approximate full live-tail tokens: conversation + tool calls/results. */
    liveTailTokens: number;
}
/**
 * Fallback when the tag-token aggregate is temporarily unavailable. It estimates
 * both reclaimable tool output and the full live tail; using only tool output for
 * liveTail makes usableTokens look too small and can arm Channel 2 prematurely.
 */
export declare function computeTailTokenEstimate(messages: MessageLike[]): TailTokenEstimate;
export interface Channel1Decision {
    fire: boolean;
    level: Channel1Level;
    undroppedTokens: number;
    /** Value to persist into `last_nudge_undropped` (caller writes it). */
    nextLastNudge: number;
    /** Value to persist into `last_nudge_level` (caller writes it). */
    nextLastNudgeLevel: Channel1Level | "";
}
/**
 * Pure decision: should Channel 1 fire, and at what level? Caller supplies the
 * already-computed `undroppedTokens` (tail baseline + this turn's accumulator)
 * and `pressure`. No DB access here — fully unit-testable.
 */
export declare function decideChannel1(input: {
    undroppedTokens: number;
    /**
     * Raw usage% / executeThreshold% (unclamped at the call site). Used here only
     * as a GATE after clamping to [0,1]; it no longer multiplies severity.
     */
    pressure: number;
    /**
     * The whole prompt's input tokens this turn (lastInputTokens +
     * turnToolTokens): the severity DENOMINATOR. severity = undropped / this =
     * the share of what we're about to send that is unreduced tool output.
     */
    estimatedInputTokens: number;
    /**
     * The agent's working window (contextLimit × executeThreshold%). Used ONLY
     * to scale the re-fire cadence interval, no longer in the severity formula.
     */
    workingWindowTokens: number;
    lastNudgeUndropped: number;
    lastNudgeLevel: Channel1Level | "";
    hasRecentReduce: boolean;
}): Channel1Decision;
/** Compute pressure from prospective per-turn token estimates. */
export declare function computePressure(input: {
    lastInputTokens: number;
    turnToolTokens: number;
    contextLimit: number;
    executeThresholdPercentage: number;
}): number;
export declare const CHANNEL2_USABLE_FRACTION: number;
export declare const CHANNEL2_MIN_RECLAIMABLE = 10000;
/** Pure decision: should the Channel 2 ceiling intent be recorded this pass? */
export declare function shouldTriggerChannel2(input: {
    reclaimableTokens: number;
    usableTokens: number;
}): boolean;
/** The synthetic user `<system-reminder>` body delivered by Channel 2. */
export declare function buildChannel2Reminder(undroppedTokens: number, hint?: readonly ToolReclaimHint[]): string;
/** Build the `<system-reminder name="mc-ctx-reduce">…</system-reminder>` body for a level. */
export declare function buildChannel1Reminder(level: Channel1Level, undroppedTokens: number, hint?: readonly ToolReclaimHint[]): string;
//# sourceMappingURL=ctx-reduce-nudge.d.ts.map