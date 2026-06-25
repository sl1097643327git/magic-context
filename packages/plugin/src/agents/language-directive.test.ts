import { describe, expect, it } from "bun:test";

import {
    buildContentLanguageDirective,
    buildMigrationLanguageDirective,
    buildPrimaryLanguageDirective,
    withContentLanguageDirective,
    withMigrationLanguageDirective,
} from "./language-directive";

const EXHAUSTIVE_STRUCTURAL_TOKENS = [
    "summary",
    "symptom",
    "model_or_provider_involved",
    "ord_span",
    "provider_sdk",
    "model_behavior",
    "tool_protocol",
    "host_integration",
    "historian_pipeline",
    "edit_pipeline",
    "environment",
    "undocumented_internal",
    "other",
    "fixed",
    "workaround",
    "external_blocker",
    "contained_failure",
    "deferred",
    "unknown_but_bounded",
    "user",
    "test_result",
    "tool_result",
    "self_review",
    "unprocessed_from",
    "verified",
    "update",
    "archive",
    "candidate_ids",
    "update_existing",
    "memory_id",
    "dismiss_existing",
    "consume_candidate_ids",
    "migrated",
    "user_observations",
    "answer",
] as const;

describe("language directives", () => {
    it("emits the content directive with the structural rule", () => {
        const directive = buildContentLanguageDirective("Turkish");
        expect(directive).toContain("Write human-readable prose you author in: Turkish.");
        expect(directive).toContain("Copy required output schemas exactly");
        expect(directive).toContain("No relevant memories found");
    });

    it("emits the preserve-user-quotes variant", () => {
        const directive = buildContentLanguageDirective("Español", {
            preserveUserQuotes: true,
        });
        expect(directive).toContain(
            "Preserve U: lines and directly quoted user text in their original source language; write the surrounding summary prose in Español.",
        );
    });

    it("emits the retrospective no-quote variant", () => {
        const directive = buildContentLanguageDirective("Türkçe", { retrospective: true });
        expect(directive).toContain(
            "Write the lesson text in Türkçe; paraphrase source text and never quote the user.",
        );
        expect(directive).not.toContain("directly quoted user text");
    });

    it("emits the migration preserve-language variant", () => {
        const directive = buildMigrationLanguageDirective("Português (Brasil)");
        expect(directive).toContain("Preserve each migrated memory's existing language");
        expect(directive).toContain(
            "do NOT translate a memory just because an output language is set",
        );
        expect(directive).not.toContain("Write human-readable prose you author");
    });

    it("emits the primary one-liner", () => {
        expect(buildPrimaryLanguageDirective("中文（简体）")).toBe(
            "Use 中文（简体） for your natural-language replies to the user unless the user explicitly asks for another language. Keep code, identifiers, file paths, commands, logs, and quoted text verbatim.",
        );
    });

    it("returns empty or unchanged for blank language", () => {
        expect(buildContentLanguageDirective()).toBe("");
        expect(buildContentLanguageDirective("   ")).toBe("");
        expect(buildMigrationLanguageDirective()).toBe("");
        expect(buildPrimaryLanguageDirective()).toBe("");
        expect(withContentLanguageDirective("base", "")).toBe("base");
        expect(withMigrationLanguageDirective("base", " ")).toBe("base");
    });

    it("does not inline the exhaustive structural token inventory", () => {
        const directive = buildContentLanguageDirective("Turkish");
        for (const token of EXHAUSTIVE_STRUCTURAL_TOKENS) {
            const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            expect(directive, token).not.toMatch(
                new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`),
            );
        }
    });
});
