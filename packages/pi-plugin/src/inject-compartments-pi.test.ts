import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { __test, injectM0M1Pi } from "./inject-compartments-pi";
import { createTestDb, textOf, userMessage } from "./test-utils.test";
function user(text: string, timestamp = 1) {
	return { role: "user" as const, content: text, timestamp };
}

function assistant(callIds: string[], text = "") {
	return {
		role: "assistant" as const,
		content: [
			...(text ? [{ type: "text" as const, text }] : []),
			...callIds.map((id) => ({
				type: "toolCall" as const,
				id,
				name: "read",
				arguments: {},
			})),
		],
		timestamp: 1,
	};
}

function result(toolCallId: string) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "read",
		content: [{ type: "text" as const, text: `out-${toolCallId}` }],
		isError: false,
		timestamp: 1,
	};
}

describe("trimPiMessagesToBoundary", () => {
	it("sweeps non-contiguous toolResults whose assistant toolCall was trimmed", () => {
		const messages = [
			assistant(["call-a"]),
			user("interleaved"),
			result("call-a"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "u1", "r", "u2"],
			"a",
		);

		expect(removed).toBe(2);
		expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
		expect((messages[0] as { content: string }).content).toBe("interleaved");
	});

	it("sweeps split multi-toolCall results after an intervening user", () => {
		const messages = [
			assistant(["call-a", "call-b"]),
			user("gap"),
			result("call-a"),
			result("call-b"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "gap", "ra", "rb", "keep"],
			"a",
		);

		expect(removed).toBe(3);
		expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
	});

	it("sweeps kept assistant toolCalls when their toolResult was trimmed", () => {
		const messages = [
			user("old"),
			result("call-a"),
			assistant(["call-a"]),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["u", "r", "a", "keep"],
			"r",
		);

		expect(removed).toBe(3);
		expect(messages).toEqual([user("keep")]);
	});
});


function piState(sessionId: string, cwd: string) {
	return {
		sessionId,
		projectIdentity: resolveProjectIdentity(cwd),
		projectDirectory: cwd,
		injectionBudgetTokens: 10_000,
	};
}

describe("injectM0M1Pi", () => {
	it("renders first-pass m[0] with no inner content and m[1] placeholder", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-empty-"));
		try {
			const messages = [userMessage("hello", 10)];
			injectM0M1Pi(piState("ses-pi-empty", cwd), db, messages as never);

			expect(textOf(messages[0] as never)).toBe(
				"<session-history></session-history>",
			);
			expect(textOf(messages[1] as never)).toBe(
				"<session-history-since>(no new content since last materialization)</session-history-since>",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("replays byte-stable cached m[0]/m[1] for identical state", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-stable-"));
		try {
			const state = piState("ses-pi-stable", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never);
			const firstM0 = textOf(first[0] as never);
			const firstM1 = textOf(first[1] as never);

			const second = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, second as never);

			expect(textOf(second[0] as never)).toBe(firstM0);
			expect(textOf(second[1] as never)).toBe(firstM1);
		} finally {
			closeQuietly(db);
		}
	});

	it("rematerializes m[0] when a new compartment appears", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-compartment-"));
		try {
			const state = piState("ses-pi-compartment", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never);
			expect(textOf(first[0] as never)).not.toContain("Compacted setup");

			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Setup",
					content: "Compacted setup",
				},
			]);
			const second = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, second as never, ["entry-1"]);

			expect(textOf(second[0] as never)).toContain("Compacted setup");
			expect(textOf(second[1] as never)).toContain(
				"no new content since last materialization",
			);
		} finally {
			closeQuietly(db);
		}
	});
});
