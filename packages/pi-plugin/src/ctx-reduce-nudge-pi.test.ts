import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getChannel2NudgeState,
	setChannel2NudgeState,
} from "@magic-context/core/features/magic-context/storage";
import {
	clearPiChannel1State,
	computeTailToolTokensPi,
	maybeChannel1ReminderForToolResult,
	maybeDeliverChannel2Pi,
	setPiChannel1Baseline,
} from "./ctx-reduce-nudge-pi";
import { createTestDb } from "./test-utils.test";

function toolResultMsg(text: string) {
	return { role: "toolResult", content: [{ type: "text", text }] };
}

describe("computeTailToolTokensPi", () => {
	it("sums non-dropped toolResult text, excludes sentinels", () => {
		const big = "x".repeat(40_000); // ~10k tokens
		const msgs = [
			toolResultMsg(big),
			toolResultMsg("[dropped §5§]"),
			toolResultMsg("[truncated]"),
			{
				role: "assistant",
				content: [{ type: "text", text: "x".repeat(40_000) }],
			},
		];
		const tokens = computeTailToolTokensPi(msgs);
		expect(tokens).toBeGreaterThan(9_000);
		expect(tokens).toBeLessThan(11_000);
	});
});

describe("maybeChannel1ReminderForToolResult", () => {
	const SESSION = "ses-ch1";

	function seedBaseline(tailTokens: number): void {
		setPiChannel1Baseline(SESSION, {
			tailToolTokens: tailTokens,
			historyBudgetTokens: 100_000,
			contextLimit: 200_000,
			executeThresholdPercentage: 65,
			lastInputTokens: 150_000, // pressure ≈ (75 / 65) ≈ 1.15
			turnToolTokens: 0,
			reducedSinceRefresh: false,
		});
	}

	it("returns null when no baseline exists (subagent / off)", () => {
		const db = createTestDb();
		clearPiChannel1State(SESSION);
		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(80_000) }],
		});
		expect(block).toBeNull();
	});

	it("fires a system-reminder block when pressure + undropped warrant it", () => {
		const db = createTestDb();
		seedBaseline(90_000);
		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "some bash output" }],
		});
		expect(block).not.toBeNull();
		expect(block?.type).toBe("text");
		expect(block?.text).toContain("<system-reminder>");
		expect(block?.text).toContain("ctx_reduce");
		clearPiChannel1State(SESSION);
	});

	it("suppresses on a ctx_reduce tool result and marks reduced", () => {
		const db = createTestDb();
		seedBaseline(90_000);
		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "ctx_reduce",
			content: [{ type: "text", text: "dropped 5 tags" }],
		});
		expect(block).toBeNull();
		// After a reduce, a subsequent tool result is also suppressed this turn.
		const next = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "more output" }],
		});
		expect(next).toBeNull();
		clearPiChannel1State(SESSION);
	});

	it("is idempotent — does not double-append to a result already carrying the marker", () => {
		const db = createTestDb();
		seedBaseline(90_000);
		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "out <system-reminder> already here" }],
		});
		expect(block).toBeNull();
		clearPiChannel1State(SESSION);
	});
});

describe("maybeDeliverChannel2Pi", () => {
	const SESSION = "ses-ch2-pi";

	it("no-ops when no pending intent exists", () => {
		const db = createTestDb();
		let sent = 0;
		const delivered = maybeDeliverChannel2Pi(
			{
				sendUserMessage: () => {
					sent += 1;
				},
			},
			db,
			SESSION,
		);
		expect(delivered).toBe(false);
		expect(sent).toBe(0);
	});

	it("delivers via sendUserMessage(followUp) and consumes the one-shot cap", () => {
		const db = createTestDb();
		setChannel2NudgeState(db, SESSION, "pending");
		let capturedContent = "";
		let capturedDeliverAs = "";
		const delivered = maybeDeliverChannel2Pi(
			{
				sendUserMessage: (content, options) => {
					capturedContent = content;
					capturedDeliverAs = options?.deliverAs ?? "";
				},
			},
			db,
			SESSION,
		);
		expect(delivered).toBe(true);
		expect(capturedDeliverAs).toBe("followUp");
		expect(capturedContent).toContain("<system-reminder>");
		expect(capturedContent).toContain("ctx_reduce");
		expect(getChannel2NudgeState(db, SESSION)).toBe("delivered");
	});

	it("reverts to pending on send failure (cap not burned)", () => {
		const db = createTestDb();
		setChannel2NudgeState(db, SESSION, "pending");
		const delivered = maybeDeliverChannel2Pi(
			{
				sendUserMessage: () => {
					throw new Error("transient");
				},
			},
			db,
			SESSION,
		);
		expect(delivered).toBe(false);
		expect(getChannel2NudgeState(db, SESSION)).toBe("pending");
	});

	it("does not re-deliver after success (one nudge per lifetime)", () => {
		const db = createTestDb();
		setChannel2NudgeState(db, SESSION, "delivered");
		let sent = 0;
		const delivered = maybeDeliverChannel2Pi(
			{
				sendUserMessage: () => {
					sent += 1;
				},
			},
			db,
			SESSION,
		);
		expect(delivered).toBe(false);
		expect(sent).toBe(0);
	});
});

describe("Channel 2 delivery wiring (regression)", () => {
	// The helper is well-tested above, but the bug it guards against is that
	// `index.ts` never CALLED it — Pi recorded `pending` and never delivered.
	// Assert the agent_end handler actually invokes the delivery.
	const INDEX_SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

	it("index.ts imports maybeDeliverChannel2Pi", () => {
		expect(INDEX_SRC).toContain("maybeDeliverChannel2Pi");
	});

	it("the agent_end handler calls maybeDeliverChannel2Pi", () => {
		const handler = INDEX_SRC.match(/pi\.on\("agent_end",[\s\S]*?\n\t\}\);/);
		expect(handler).not.toBeNull();
		expect(handler?.[0] ?? "").toContain(
			"maybeDeliverChannel2Pi(pi, db, sessionId)",
		);
	});
});
