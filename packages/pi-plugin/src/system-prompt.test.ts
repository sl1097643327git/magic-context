import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertUserMemory } from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	MAGIC_CONTEXT_GUIDANCE_MARKER,
	SYSTEM_PROMPT_DATA_MARKERS,
	buildMagicContextBlock,
} from "./system-prompt";
import { createTestDb } from "./test-utils.test";

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("buildMagicContextBlock v2 system-prompt parity", () => {
	it("keeps Magic Context guidance in the system prompt", () => {
		const db = createTestDb();
		try {
			const block = buildMagicContextBlock({
				db,
				cwd: tempDir("pi-guidance-"),
				sessionId: "ses-guidance",
				memoryEnabled: true,
				injectDocs: true,
				includeGuidance: true,
			});

			expect(block).not.toBeNull();
			expect(block).toContain(MAGIC_CONTEXT_GUIDANCE_MARKER);
			expect(block).toContain("ctx_search");
			expect(block).toContain("ctx_memory");
			expect(block).toContain("ctx_note");
		} finally {
			closeQuietly(db);
		}
	});

	it("does not render project-docs, user-profile, or key-files in the system prompt", () => {
		const db = createTestDb();
		const cwd = tempDir("pi-system-v2-");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, "ARCHITECTURE.md"), "# Architecture", "utf8");
		try {
			insertUserMemory(db, "Stable profile should move to m[0]", []);

			const block = buildMagicContextBlock({
				db,
				cwd,
				sessionId: "ses-v2-system",
				memoryEnabled: true,
				injectDocs: true,
				includeGuidance: true,
				userMemoriesEnabled: true,
				pinKeyFilesEnabled: true,
			});

			expect(block).not.toContain(SYSTEM_PROMPT_DATA_MARKERS.projectDocs);
			expect(block).not.toContain(SYSTEM_PROMPT_DATA_MARKERS.userProfile);
			expect(block).not.toContain(SYSTEM_PROMPT_DATA_MARKERS.keyFiles);
			expect(block).not.toContain("Stable profile should move to m[0]");
		} finally {
			closeQuietly(db);
		}
	});

	it("returns null when guidance is disabled because data blocks moved to m[0]/m[1]", () => {
		const db = createTestDb();
		const cwd = tempDir("pi-no-guidance-");
		writeFileSync(join(cwd, "STRUCTURE.md"), "# Structure", "utf8");
		try {
			insertUserMemory(db, "Profile", []);
			const block = buildMagicContextBlock({
				db,
				cwd,
				sessionId: "ses-no-guidance",
				memoryEnabled: true,
				injectDocs: true,
				includeGuidance: false,
				userMemoriesEnabled: true,
				pinKeyFilesEnabled: true,
			});

			expect(block).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("deduplicates guidance when the base prompt already contains it", () => {
		const db = createTestDb();
		try {
			const block = buildMagicContextBlock({
				db,
				cwd: tempDir("pi-guidance-dedup-"),
				sessionId: "ses-guidance-dedup",
				memoryEnabled: false,
				injectDocs: false,
				includeGuidance: true,
				existingSystemPrompt: "base\n## Magic Context\nalready present",
			});

			expect(block).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("emits no-reduce guidance variant when ctxReduceEnabled is false", () => {
		const db = createTestDb();
		try {
			const block = buildMagicContextBlock({
				db,
				cwd: tempDir("pi-noreduce-"),
				sessionId: "ses-noreduce",
				memoryEnabled: false,
				injectDocs: false,
				includeGuidance: true,
				ctxReduceEnabled: false,
			});

			expect(block).toContain(MAGIC_CONTEXT_GUIDANCE_MARKER);
			expect(block).not.toContain("ctx_reduce");
			expect(block).toContain("ctx_search");
		} finally {
			closeQuietly(db);
		}
	});
});
