import { describe, expect, it } from "bun:test";

import { stripUnsafeProjectConfigFields } from "@magic-context/core/config/project-security";

describe("Pi project config security", () => {
	it("strips language from project config", () => {
		const raw: Record<string, unknown> = {
			language: "Turkish",
			dreamer: { model: "x" },
		};
		const warnings = stripUnsafeProjectConfigFields(raw);

		expect(raw.language).toBeUndefined();
		expect(raw.dreamer).toEqual({ model: "x" });
		expect(warnings.join("\n")).toContain(
			"Ignoring language from project config",
		);
	});
});
