// Channel 1 of the ctx_reduce nudge redesign: an in-turn `<system-reminder>`
// appended to a tool's `output.output` in `tool.execute.after`. OpenCode
// persists the mutated tool output to its DB and replays it verbatim on every
// later transform, so this is "free sticky" — no anchor store, no CAS, no
// replay machinery (unlike the deleted assistant/user-anchored nudges).
//
// The metric is `severity = (undropped / historyBudget) × pressure`:
//   - `undropped` = approximate tokens of NON-dropped tool output in the live
//     tail (dropped outputs are `[dropped …]` / `[truncated]` sentinels, so a
//     simple tail walk excludes them — no agent-vs-heuristic attribution).
//   - `pressure`  = current usage% / execute-threshold%.
// Either factor low ⇒ quiet, so a disciplined agent and an early-exploring
// agent are both spared; only "lots of reclaimable space AND near compaction"
// escalates. This is behavioral, not positional (the old %-band nudges nagged
// disciplined agents merely for approaching the threshold).

import { byteSize } from "./tag-content-primitives";
import type { MessageLike } from "./tag-messages";

export type Channel1Level = "gentle" | "firm" | "urgent";

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
}

// Content-based idempotency guard (robust to callID reuse on retries). The bare
// `<system-reminder>` opener doubles as the marker — no extra attribute, so the
// model sees no wasted tokens. A re-fire still detects our prior injection
// because the appended text contains this opener. The only cost is a rare
// false-skip when a tool output already contains the literal `<system-reminder>`
// (e.g. reading MC's own source) — harmless for a nudge.
export const CHANNEL1_SENTINEL = "<system-reminder>";

// Approximate tokens-per-byte. Bytes are cheap to measure in the hot
// `tool.execute.after` path; the gating only needs an order-of-magnitude
// estimate, not an exact tokenizer count. Exported as the ONE canonical
// byte→token estimator reused by the emergency-drop selection
// (`emergency-drop.ts`) so reclaim accounting and nudge accounting agree.
export const TOKENS_PER_BYTE = 0.25;

export const CHANNEL1_FLOOR_TOKENS = 10_000;
export const CHANNEL1_REFIRE_FLOOR_TOKENS = 10_000;

export function channel1RefireTokens(historyBudgetTokens: number): number {
    const scaled = Math.round(0.05 * Math.max(0, historyBudgetTokens));
    return Math.max(CHANNEL1_REFIRE_FLOOR_TOKENS, scaled);
}
// severity = (undropped/budget) × pressure, both ∈ [0,1], so severity ∈ [0,1].
// undropped and pressure are naturally correlated (a large tail dump raises
// input → raises pressure), so the metric self-corrects: large pile at genuinely
// low pressure is impossible. No absolute-undropped override is needed (it would
// only mask the gentle band). The 10k token floor handles "tiny amounts never fire".
const S_GENTLE = 0.2;
const S_FIRM = 0.4;
const S_URGENT = 0.65;
const LEVEL_RANK: Record<Channel1Level, number> = { gentle: 1, firm: 2, urgent: 3 };

const DROP_SENTINELS = ["[dropped", "[truncated"];

/**
 * Whether a tool output string is a drop/truncation sentinel (so it should NOT
 * count toward reclaimable `undropped` tokens). Exported so the Pi harness — whose
 * tool output lives in `toolResult.content[].text`, not OpenCode's
 * `parts[].state.output` — can reuse the exact same sentinel detection.
 */
export function isDroppedToolOutput(output: string): boolean {
    const head = output.slice(0, 16);
    return DROP_SENTINELS.some((s) => head.startsWith(s));
}

/**
 * Sum approximate tokens of non-dropped tool output from a list of already-
 * extracted output strings. Harness-agnostic core shared by OpenCode
 * (`computeTailToolTokens`) and Pi (`toolResult.content[].text` extraction).
 */
export function tailToolTokensFromStrings(outputs: readonly string[]): number {
    let bytes = 0;
    for (const output of outputs) {
        if (isDroppedToolOutput(output)) continue;
        bytes += byteSize(output);
    }
    return Math.round(bytes * TOKENS_PER_BYTE);
}

function isToolPartWithStringOutput(
    part: unknown,
): part is { type: string; state: { output: string } } {
    if (part === null || typeof part !== "object") return false;
    const p = part as { type?: unknown; state?: unknown };
    if (p.type !== "tool" && p.type !== "tool-invocation") return false;
    const state = p.state as { output?: unknown } | undefined;
    return typeof state?.output === "string";
}

/**
 * Sum approximate tokens of non-dropped tool output across the visible
 * messages. The compartment-injection step has already trimmed everything
 * before the last compartment boundary, so `messages` IS the live tail —
 * walking it gives the post-boundary undropped tool tokens without any tag
 * query or boundary filter.
 */
export function computeTailToolTokens(messages: MessageLike[]): number {
    const outputs: string[] = [];
    for (const message of messages) {
        for (const part of message.parts) {
            if (!isToolPartWithStringOutput(part)) continue;
            outputs.push(part.state.output);
        }
    }
    return tailToolTokensFromStrings(outputs);
}

/** Approximate tokens for a single tool output string (prospective per-turn accounting). */
export function toolOutputTokens(output: string): number {
    return Math.round(byteSize(output) * TOKENS_PER_BYTE);
}

export interface TailTokenEstimate {
    /** Non-dropped tool-output tokens: reclaimable by ctx_reduce. */
    tailToolTokens: number;
    /** Approximate full live-tail tokens: conversation + tool calls/results. */
    liveTailTokens: number;
}

function stringTokens(value: string): number {
    return Math.round(byteSize(value) * TOKENS_PER_BYTE);
}

function unknownJsonTokens(value: unknown): number {
    if (value === undefined || value === null) return 0;
    try {
        return stringTokens(JSON.stringify(value));
    } catch {
        return 0;
    }
}

function textFromPart(part: unknown): string {
    if (part === null || typeof part !== "object") return "";
    const p = part as { text?: unknown; content?: unknown; thinking?: unknown };
    if (typeof p.text === "string") return p.text;
    if (typeof p.content === "string") return p.content;
    if (typeof p.thinking === "string") return p.thinking;
    return "";
}

/**
 * Fallback when the tag-token aggregate is temporarily unavailable. It estimates
 * both reclaimable tool output and the full live tail; using only tool output for
 * liveTail makes usableTokens look too small and can arm Channel 2 prematurely.
 */
export function computeTailTokenEstimate(messages: MessageLike[]): TailTokenEstimate {
    let toolOutputTokensTotal = 0;
    let toolCallTokensTotal = 0;
    let conversationTokens = 0;

    for (const message of messages) {
        for (const part of message.parts) {
            if (isToolPartWithStringOutput(part)) {
                const outputTokens = isDroppedToolOutput(part.state.output)
                    ? 0
                    : toolOutputTokens(part.state.output);
                const inputTokens = unknownJsonTokens(
                    (part as { state?: { input?: unknown } }).state?.input,
                );
                toolOutputTokensTotal += outputTokens;
                toolCallTokensTotal += outputTokens + inputTokens;
                continue;
            }
            conversationTokens += stringTokens(textFromPart(part));
        }
    }

    return {
        tailToolTokens: toolOutputTokensTotal,
        liveTailTokens: conversationTokens + toolCallTokensTotal,
    };
}

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
export function decideChannel1(input: {
    undroppedTokens: number;
    pressure: number;
    historyBudgetTokens: number;
    lastNudgeUndropped: number;
    lastNudgeLevel: Channel1Level | "";
    hasRecentReduce: boolean;
}): Channel1Decision {
    const { undroppedTokens, pressure, historyBudgetTokens, hasRecentReduce } = input;

    // Re-arm: once the agent has reduced (or the measured tail fell below the
    // last-fire mark), clear BOTH cadence and band state so the next accumulation
    // starts a fresh gentle→firm→urgent cycle instead of suppressing new signal.
    const resetCycle = hasRecentReduce || undroppedTokens < input.lastNudgeUndropped;
    const lastNudge = resetCycle ? 0 : input.lastNudgeUndropped;
    const lastLevel = resetCycle ? "" : input.lastNudgeLevel;
    const quiet = (): Channel1Decision => ({
        fire: false,
        level: "gentle",
        undroppedTokens,
        nextLastNudge: lastNudge,
        nextLastNudgeLevel: lastLevel,
    });

    // Post-ctx_reduce self-nag suppression: never nudge on a turn where the
    // agent just reduced — it's actively managing context.
    if (hasRecentReduce) return quiet();

    // Floor: below this much reclaimable space, never fire (working room).
    if (undroppedTokens < CHANNEL1_FLOOR_TOKENS) return quiet();

    const budget = historyBudgetTokens > 0 ? historyBudgetTokens : undroppedTokens || 1;
    const severity = (undroppedTokens / budget) * pressure;

    if (severity < S_GENTLE) return quiet();

    let level: Channel1Level;
    if (severity >= S_URGENT) level = "urgent";
    else if (severity >= S_FIRM) level = "firm";
    else level = "gentle";

    if (lastLevel === "") {
        // Initial fire cadence scales with the history budget so wide-context
        // sessions don't hear a reminder every tiny 10k-token increment.
        if (undroppedTokens < lastNudge + channel1RefireTokens(historyBudgetTokens)) {
            return quiet();
        }
    } else if (LEVEL_RANK[level] <= LEVEL_RANK[lastLevel]) {
        // Once a band has fired, repetition at that same band is noise; only an
        // escalation carries new information before the next ctx_reduce reset.
        return quiet();
    }

    return {
        fire: true,
        level,
        undroppedTokens,
        nextLastNudge: undroppedTokens,
        nextLastNudgeLevel: level,
    };
}

/** Compute pressure from prospective per-turn token estimates. */
export function computePressure(input: {
    lastInputTokens: number;
    turnToolTokens: number;
    contextLimit: number;
    executeThresholdPercentage: number;
}): number {
    const { lastInputTokens, turnToolTokens, contextLimit, executeThresholdPercentage } = input;
    if (contextLimit <= 0 || executeThresholdPercentage <= 0) return 0;
    const estimatedInput = lastInputTokens + turnToolTokens;
    const usagePercentage = (estimatedInput / contextLimit) * 100;
    return usagePercentage / executeThresholdPercentage;
}

function approxThousands(tokens: number): string {
    return `${Math.round(tokens / 1000)}k`;
}

// ---- Channel 2 (synthetic-user-message ceiling) ----
// The ceiling fires when reclaimable tool output is at least a THIRD of the
// agent's usable working range — the span between the fixed overhead floor
// (system + tool defs + m[0] + m[1]) and the execute-threshold ceiling, i.e.
// "the range the agent is actually moving in". Scaling to usable (instead of an
// absolute token count) is what makes one rule correct across context sizes: on
// a 1M-context session 54k reclaimable is noise, on a 200k session it's a third
// of the room. usable also shrinks as pressure rises (headroom→0 near
// threshold), so the single ratio encodes BOTH "near comparting" and "sitting
// on a big reclaimable pile" without a separate pressure gate.
export const CHANNEL2_USABLE_FRACTION = 1 / 3;
// Floor: never escalate to a synthetic-user interrupt for a trivially small
// pile, even if usable is tiny (e.g. a small-context session already near
// threshold) — Channel 1's in-turn reminder covers that case.
export const CHANNEL2_MIN_RECLAIMABLE = 10_000;

/** Pure decision: should the Channel 2 ceiling intent be recorded this pass? */
export function shouldTriggerChannel2(input: {
    reclaimableTokens: number;
    usableTokens: number;
}): boolean {
    if (input.reclaimableTokens < CHANNEL2_MIN_RECLAIMABLE) return false;
    if (input.usableTokens <= 0) return true; // at/over threshold with a real pile → escalate
    return input.reclaimableTokens >= input.usableTokens * CHANNEL2_USABLE_FRACTION;
}

/** The synthetic user `<system-reminder>` body delivered by Channel 2. */
export function buildChannel2Reminder(undroppedTokens: number): string {
    const amount = approxThousands(undroppedTokens);
    return (
        `<system-reminder>\n` +
        `Routine context housekeeping is near: a large span of this session will be comparted soon, ` +
        `and ~${amount} tokens of tool output remain unreduced. Drop spent outputs with ctx_reduce ` +
        `first so the archived span is the part that matters.\n` +
        `</system-reminder>`
    );
}

/** Build the `<system-reminder name="mc-ctx-reduce">…</system-reminder>` body for a level. */
export function buildChannel1Reminder(level: Channel1Level, undroppedTokens: number): string {
    const amount = approxThousands(undroppedTokens);
    let body: string;
    switch (level) {
        case "gentle":
            body =
                `You have ~${amount} tokens of tool output you have not reduced. ` +
                `Once you are done with earlier outputs, drop them with ctx_reduce to keep context lean.`;
            break;
        case "firm":
            body =
                `~${amount} tokens of unreduced tool output is accumulating. ` +
                `Drop what you have already processed with ctx_reduce before continuing.`;
            break;
        case "urgent":
            body =
                `~${amount} tokens of unreduced tool output remain. ` +
                `A large span of this session will be comparted soon; drop spent outputs with ctx_reduce first so the archived span is the part that matters.`;
            break;
    }
    return `\n\n<system-reminder>\n${body}\n</system-reminder>`;
}
