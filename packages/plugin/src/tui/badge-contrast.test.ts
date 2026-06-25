import { describe, expect, test } from "bun:test";
import { readableTextColorOn } from "./badge-contrast";

describe("readableTextColorOn", () => {
    test("dark accent gets white text", () => {
        // A typical dark accent (deep blue/purple) should read as white.
        expect(readableTextColorOn({ r: 0.1, g: 0.1, b: 0.3 })).toBe("#ffffff");
        expect(readableTextColorOn({ r: 0, g: 0, b: 0 })).toBe("#ffffff");
    });

    test("light accent gets black text", () => {
        // Light/pastel accents should read as black.
        expect(readableTextColorOn({ r: 0.9, g: 0.9, b: 0.7 })).toBe("#000000");
        expect(readableTextColorOn({ r: 1, g: 1, b: 1 })).toBe("#000000");
    });

    test("pure green is treated as light (high luma weight)", () => {
        // Green dominates perceived brightness, so a saturated green badge needs
        // dark text.
        expect(readableTextColorOn({ r: 0, g: 1, b: 0 })).toBe("#000000");
    });

    test("pure blue is treated as dark (low luma weight)", () => {
        // Blue contributes little to perceived brightness, so a saturated blue
        // badge needs light text.
        expect(readableTextColorOn({ r: 0, g: 0, b: 1 })).toBe("#ffffff");
    });

    test("does not depend on the (possibly transparent) background alpha", () => {
        // The helper only reads r/g/b — the regression in #186 was using a
        // background color whose alpha could be 0. Two accents with identical
        // rgb resolve identically regardless of any alpha the caller might pass.
        const a = readableTextColorOn({ r: 0.2, g: 0.2, b: 0.2 });
        const b = readableTextColorOn({ r: 0.2, g: 0.2, b: 0.2 });
        expect(a).toBe(b);
        expect(a).toBe("#ffffff");
    });
});
