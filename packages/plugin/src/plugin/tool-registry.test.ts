/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MagicContextPluginConfig } from "../config";
import { closeDatabase } from "../features/magic-context/storage";
import { createToolRegistry } from "./tool-registry";
import type { PluginContext } from "./types";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* ignore */
        }
    }
    tempDirs.length = 0;
});

function isolateDb(): void {
    const dir = mkdtempSync(join(tmpdir(), "tool-registry-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

// createToolRegistry only reads ctx.directory; the rest of PluginContext is
// unused, so a minimal stub is sufficient.
const ctx = { directory: process.cwd() } as unknown as PluginContext;

function buildRegistry(config: Partial<MagicContextPluginConfig>): Record<string, unknown> {
    return createToolRegistry({
        ctx,
        pluginConfig: { enabled: true, ...config } as MagicContextPluginConfig,
    });
}

describe("createToolRegistry — memory gating", () => {
    it("registers ctx_memory when memory is enabled (default)", () => {
        isolateDb();
        const tools = buildRegistry({});
        expect(Object.keys(tools)).toContain("ctx_memory");
        expect(Object.keys(tools)).toContain("ctx_search");
    });

    it("omits ctx_memory when memory.enabled is false, but keeps ctx_search", () => {
        isolateDb();
        const tools = buildRegistry({ memory: { enabled: false } as never });
        expect(Object.keys(tools)).not.toContain("ctx_memory");
        expect(Object.keys(tools)).toContain("ctx_search");
        // ctx_note / ctx_expand are unaffected by the memory gate.
        expect(Object.keys(tools)).toContain("ctx_note");
        expect(Object.keys(tools)).toContain("ctx_expand");
    });
});
