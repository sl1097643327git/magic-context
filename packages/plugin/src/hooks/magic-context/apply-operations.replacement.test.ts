/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { buildReplacementContent } from "./apply-operations";
import type { TagTarget } from "./tag-messages";

// Minimal TagTarget stub — buildReplacementContent only reads `message.info.role`
// and `getContent()`.
function userTarget(content: string): TagTarget {
    return {
        message: { info: { role: "user" } },
        getContent: () => content,
    } as unknown as TagTarget;
}

describe("buildReplacementContent — drop/truncate convergence", () => {
    // Regression: a system-injected user message that strips to empty must
    // canonicalize to `[dropped §N§]` — the exact bytes heuristic-cleanup writes
    // on the execute pass. Before the fix this replay re-derived `[truncated …]`
    // from the raw rebuilt content, flipping one block of message[0] on the next
    // defer pass and busting the prompt-cache prefix.
    it("a whole-message <system-reminder> user tag → [dropped §N§] (matches heuristic-cleanup)", () => {
        const content =
            "<system-reminder>\n~80k tokens of unreduced tool output remain. Drop them with ctx_reduce.\n</system-reminder>";
        expect(buildReplacementContent(100413, userTarget(content))).toBe(
            "[dropped \u00a7100413\u00a7]",
        );
    });

    it("a §N§-tag-prefixed system-reminder still → [dropped §N§]", () => {
        const content = "\u00a7100413\u00a7 <system-reminder>spend the budget</system-reminder>";
        expect(buildReplacementContent(100413, userTarget(content))).toBe(
            "[dropped \u00a7100413\u00a7]",
        );
    });

    it("a genuine short user message is preserved as [truncated §N§] + text", () => {
        const out = buildReplacementContent(42, userTarget("fix the embedding bug"));
        expect(out.startsWith("[truncated \u00a742\u00a7]")).toBe(true);
        expect(out).toContain("fix the embedding bug");
    });

    it("a long user message truncates to a preview with an ellipsis", () => {
        const long = `please ${"x".repeat(500)} done`;
        const out = buildReplacementContent(7, userTarget(long));
        expect(out.startsWith("[truncated \u00a77\u00a7]")).toBe(true);
        expect(out.endsWith("\u2026")).toBe(true);
        expect(out.length).toBeLessThan(long.length);
    });

    it("a non-user (assistant) tag → [dropped §N§] regardless of content", () => {
        const assistant = {
            message: { info: { role: "assistant" } },
            getContent: () => "<system-reminder>x</system-reminder>",
        } as unknown as TagTarget;
        expect(buildReplacementContent(9, assistant)).toBe("[dropped \u00a79\u00a7]");
    });

    it("a user message with a reminder BUT real text after it is NOT collapsed to [dropped]", () => {
        // Mixed content strips the reminder but leaves real text → truncate path,
        // not the empty-injection drop path.
        const content =
            "<system-reminder>housekeeping</system-reminder>\nactually do the release now";
        const out = buildReplacementContent(11, userTarget(content));
        expect(out.startsWith("[truncated \u00a711\u00a7]")).toBe(true);
        expect(out).toContain("actually do the release now");
    });
});
