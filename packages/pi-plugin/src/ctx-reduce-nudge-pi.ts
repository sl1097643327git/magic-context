// Pi parity for the ctx_reduce nudge redesign (Channels 1 & 2).
//
// The metric math is fully shared from `@magic-context/core` — only the
// harness-specific I/O differs:
//
//   Channel 1 (in-turn tool-output nudge): OpenCode appends to a tool's
//   `output.output` string in `tool.execute.after`; Pi appends a TextContent
//   block to a `toolResult.content[]` in `pi.on("tool_result")`. Both persist
//   (OpenCode→DB, Pi→JSONL via `appendMessage` on `message_end`) and replay
//   verbatim, so both are "free sticky" with no anchor/CAS/replay machinery.
//
//   Channel 2 (ceiling nudge): OpenCode must use a live-server `promptAsync`
//   with a `/session` probe to dodge the plugin runner-split bug
//   (anomalyco/opencode#28202). Pi is single-process, so it just calls the
//   native `pi.sendUserMessage(..., { deliverAs: "followUp" })` — no probe, no
//   live-server client, no #28202 workaround. The `channel2_nudge_state` lease
//   is kept purely for the one-ceiling-per-lifetime cap + the
//   record-in-pipeline / deliver-on-`agent_end` split.

import {
	casChannel2NudgeState,
	getChannel2NudgeState,
	getLastNudgeUndropped,
	setLastNudgeUndropped,
} from "@magic-context/core/features/magic-context/storage";
import {
	buildChannel1Reminder,
	buildChannel2Reminder,
	CHANNEL1_SENTINEL,
	CHANNEL2_CEIL_UNDROPPED,
	type Channel1State,
	computePressure,
	decideChannel1,
	tailToolTokensFromStrings,
	toolOutputTokens,
} from "@magic-context/core/hooks/magic-context/ctx-reduce-nudge";
import type { Database } from "@magic-context/core/shared/sqlite";

export type { Channel1State };

// Per-session Channel 1 metric baseline. Written at the end of each pipeline
// pass (post-drop), read in the `tool_result` handler. Primary-only: subagents
// never get a baseline, which is how Channel 1 stays off for them (matches
// OpenCode's `channel1StateBySession` gating).
const channel1StateBySession = new Map<string, Channel1State>();

export function setPiChannel1Baseline(
	sessionId: string,
	state: Channel1State,
): void {
	channel1StateBySession.set(sessionId, state);
}

export function getPiChannel1Baseline(
	sessionId: string,
): Channel1State | undefined {
	return channel1StateBySession.get(sessionId);
}

export function clearPiChannel1State(sessionId: string): void {
	channel1StateBySession.delete(sessionId);
}

/** Mark that the agent ran ctx_reduce since the last baseline refresh (suppress self-nag). */
export function markPiChannel1Reduced(sessionId: string): void {
	const state = channel1StateBySession.get(sessionId);
	if (state) state.reducedSinceRefresh = true;
}

interface PiTextContent {
	type: "text";
	text: string;
}

function isPiTextContent(c: unknown): c is PiTextContent {
	return (
		c !== null &&
		typeof c === "object" &&
		(c as { type?: unknown }).type === "text" &&
		typeof (c as { text?: unknown }).text === "string"
	);
}

/** Concatenated text of a `toolResult.content[]` (image blocks ignored). */
function toolResultText(content: readonly unknown[]): string {
	let text = "";
	for (const c of content) {
		if (isPiTextContent(c)) text += c.text;
	}
	return text;
}

/**
 * Sum approximate tokens of non-dropped tool output across Pi messages. Pi tool
 * output lives in `toolResult.content[].text` (not OpenCode's
 * `parts[].state.output`); the math is the shared `tailToolTokensFromStrings`.
 * `messages` is the post-injection wire array, already trimmed to the live tail.
 */
export function computeTailToolTokensPi(messages: readonly unknown[]): number {
	const outputs: string[] = [];
	for (const m of messages) {
		if (
			m !== null &&
			typeof m === "object" &&
			(m as { role?: unknown }).role === "toolResult"
		) {
			const content = (m as { content?: unknown }).content;
			if (Array.isArray(content)) outputs.push(toolResultText(content));
		}
	}
	return tailToolTokensFromStrings(outputs);
}

/**
 * Channel 1 decision for a just-finished tool result. Returns the reminder
 * TextContent block to append (so the caller's `tool_result` handler can return
 * `{ content: [...event.content, block] }`), or null when no nudge should fire.
 * `toolName` of `ctx_reduce` short-circuits to suppression (the agent is
 * actively managing context) — mirrors OpenCode's `tool.execute.after` branch.
 */
export function maybeChannel1ReminderForToolResult(args: {
	db: Database;
	sessionId: string;
	toolName: string;
	content: readonly unknown[];
}): PiTextContent | null {
	const { db, sessionId, toolName } = args;
	const state = channel1StateBySession.get(sessionId);
	if (!state) return null; // primary-only: no baseline ⇒ subagent ⇒ off

	if (toolName === "ctx_reduce") {
		state.reducedSinceRefresh = true;
		return null;
	}

	const text = toolResultText(args.content);
	if (text.length === 0) return null;
	// Content-based idempotency (bare `<system-reminder>` opener is the marker).
	if (text.includes(CHANNEL1_SENTINEL)) return null;

	// Accumulate this tool's tokens into the per-turn accumulator (prospective:
	// not yet reflected in the baseline tail snapshot).
	state.turnToolTokens += toolOutputTokens(text);

	if (state.reducedSinceRefresh) return null;

	const undroppedTokens = state.tailToolTokens + state.turnToolTokens;
	const pressure = computePressure({
		lastInputTokens: state.lastInputTokens,
		turnToolTokens: state.turnToolTokens,
		contextLimit: state.contextLimit,
		executeThresholdPercentage: state.executeThresholdPercentage,
	});

	const decision = decideChannel1({
		undroppedTokens,
		pressure,
		historyBudgetTokens: state.historyBudgetTokens,
		lastNudgeUndropped: getLastNudgeUndropped(db, sessionId),
		hasRecentReduce: false, // handled by reducedSinceRefresh above
	});

	setLastNudgeUndropped(db, sessionId, decision.nextLastNudge);
	if (!decision.fire) return null;

	return {
		type: "text",
		text: buildChannel1Reminder(decision.level, decision.undroppedTokens),
	};
}

/** Minimal shape of the Pi API needed to deliver a Channel 2 ceiling nudge. */
interface PiSendUserMessage {
	sendUserMessage: (
		content: string,
		options?: { deliverAs?: "steer" | "followUp" },
	) => void;
}

/**
 * Deliver a pending Channel 2 ceiling nudge for `sessionId`, if any. Safe to
 * call on every `agent_end`; no-ops unless a `pending` intent exists. Pi is
 * single-process so `sendUserMessage` coalesces natively — no #28202 workaround.
 * Lease: pending → claimed → delivered (revert to pending on failure so a
 * transient error doesn't burn the one-shot cap). Returns true on delivery.
 */
export function maybeDeliverChannel2Pi(
	pi: PiSendUserMessage,
	db: Database,
	sessionId: string,
): boolean {
	let state: string;
	try {
		state = getChannel2NudgeState(db, sessionId);
	} catch {
		return false;
	}
	if (state !== "pending") return false;

	// Revalidate before delivering (parity with OpenCode channel2-delivery).
	// The `pending` intent was recorded at high pressure during a context pass;
	// by this agent_end the agent may have run ctx_reduce (markPiChannel1Reduced
	// + the next pass refreshes the baseline), so the ceiling condition no longer
	// holds. Firing anyway injects a stale follow-up AND burns the one-per-session
	// cap. When the current undropped tail is known and below the trigger floor,
	// reset to '' (re-armable) instead — NOT 'delivered' — preserving the cap.
	const baseline = channel1StateBySession.get(sessionId);
	const undropped = baseline
		? baseline.tailToolTokens + baseline.turnToolTokens
		: CHANNEL2_CEIL_UNDROPPED;
	if (baseline && undropped < CHANNEL2_CEIL_UNDROPPED) {
		try {
			casChannel2NudgeState(db, sessionId, "pending", "");
		} catch {
			// best-effort; next pass re-evaluates.
		}
		return false;
	}

	if (!casChannel2NudgeState(db, sessionId, "pending", "claimed")) return false;

	try {
		pi.sendUserMessage(buildChannel2Reminder(undropped), {
			deliverAs: "followUp",
		});
		casChannel2NudgeState(db, sessionId, "claimed", "delivered");
		return true;
	} catch {
		casChannel2NudgeState(db, sessionId, "claimed", "pending");
		return false;
	}
}
