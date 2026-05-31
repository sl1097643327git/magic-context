import { describe, expect, it } from "bun:test";
import { renderDecayedCompartments, type DecayRenderCompartment } from "./decay-render";

function legacyCompartment(i: number): DecayRenderCompartment {
    return {
        startMessage: i,
        endMessage: i,
        title: `legacy ${i}`,
        content: "legacy summary",
        legacy: 1,
    };
}

describe("decay-render", () => {
    it("excludes legacy rows from v2 pressure and age indexing", () => {
        const v2: DecayRenderCompartment = {
            startMessage: 1,
            endMessage: 1,
            title: "v2 oldest",
            content: "content fallback",
            p1: "P1_KEEP",
            p2: "P2_LOWER",
            p3: "P3_LOWER",
            p4: "P4_LOWER",
            importance: 50,
        };
        const compartments = [
            v2,
            ...Array.from({ length: 80 }, (_, i) => legacyCompartment(i + 2)),
        ];

        const rendered = renderDecayedCompartments({
            compartments,
            historyBudgetTokens: 3000,
        });

        expect(rendered).toContain("P1_KEEP");
        expect(rendered).not.toContain("P2_LOWER");
        expect(rendered).not.toContain("P3_LOWER");
        expect(rendered).not.toContain("P4_LOWER");
    });
});
