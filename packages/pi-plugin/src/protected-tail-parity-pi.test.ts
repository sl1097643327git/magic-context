/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import {
	buildToolArcs,
	buildTrueRawTokenIndex,
} from "@magic-context/core/hooks/magic-context/read-session-true-raw-tokens";

describe("Pi protected-tail true-raw parity", () => {
	test("matches OpenCode text and tool-I/O totals for folded Pi shape", () => {
		const opencode: RawMessage[] = [
			{
				ordinal: 1,
				id: "u1",
				role: "user",
				parts: [{ type: "text", text: "please inspect" }],
			},
			{
				ordinal: 2,
				id: "a1",
				role: "assistant",
				parts: [
					{
						type: "tool",
						callID: "read:1",
						tool: "read",
						state: { input: { file: "a.ts" } },
					},
				],
			},
			{
				ordinal: 3,
				id: "u2",
				role: "user",
				parts: [
					{
						type: "tool",
						callID: "read:1",
						tool: "read",
						state: { output: "const a = 1;" },
					},
				],
			},
		];
		const piFolded: RawMessage[] = [
			{
				ordinal: 1,
				id: "u1",
				role: "user",
				parts: [{ type: "text", text: "please inspect" }],
			},
			{
				ordinal: 2,
				id: "a1",
				role: "assistant",
				parts: [
					{
						type: "tool",
						callID: "read:1",
						tool: "read",
						state: { input: { file: "a.ts" } },
					},
				],
			},
			{
				ordinal: 3,
				id: "synth-user-read-1",
				role: "user",
				parts: [
					{
						type: "tool",
						callID: "read:1",
						tool: "read",
						state: { output: "const a = 1;" },
					},
				],
			},
		];

		const ocIndex = buildTrueRawTokenIndex("ses-oc", opencode, {
			providerShapeVersion: "opencode-v1",
			cacheNamespace: "test:oc",
		});
		const piIndex = buildTrueRawTokenIndex("ses-pi", piFolded, {
			providerShapeVersion: "pi-folded-v1",
			cacheNamespace: "test:pi",
		});

		expect(piIndex.rangeTokens(1, 4)).toBe(ocIndex.rangeTokens(1, 4));
		expect(buildToolArcs(piFolded)).toEqual([
			{ callId: "read:1", invOrdinal: 2, resOrdinal: 3 },
		]);
	});

	test("documents Pi thinking/image undercount as an intentional provider-shape divergence", () => {
		const opencode: RawMessage[] = [
			{
				ordinal: 1,
				id: "a-thinking",
				role: "assistant",
				parts: [
					{ type: "thinking", thinking: "private chain of thought" },
					{ type: "image", width: 1024, height: 768 },
				],
			},
		];
		const piFolded: RawMessage[] = [
			{ ordinal: 1, id: "a-thinking", role: "assistant", parts: [] },
		];

		const ocTotal = buildTrueRawTokenIndex("ses-oc-divergence", opencode, {
			providerShapeVersion: "opencode-v1",
			cacheNamespace: "test:oc-divergence",
		}).rangeTokens(1, 2);
		const piTotal = buildTrueRawTokenIndex("ses-pi-divergence", piFolded, {
			providerShapeVersion: "pi-folded-v1",
			cacheNamespace: "test:pi-divergence",
		}).rangeTokens(1, 2);

		expect(piTotal).toBeLessThan(ocTotal);
	});
});
