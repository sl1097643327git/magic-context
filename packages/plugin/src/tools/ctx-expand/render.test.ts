import { describe, expect, test } from "bun:test";

import { setRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import { renderMessageById, renderVerboseRange } from "./render";

const SESSION = "ses-render-test";

function provide(messages: RawMessage[]): () => void {
    return setRawMessageProvider(SESSION, {
        readMessages: () => messages,
        readMessageById: (id) => messages.find((m) => m.id === id) ?? null,
    });
}

// OpenCode-shaped tool part: { type:"tool", tool, callID, state:{input,output} }
function ocTool(tool: string, callID: string, input: unknown, output: unknown): unknown {
    return { type: "tool", tool, callID, state: { input, output } };
}

describe("renderVerboseRange", () => {
    test("lists each message separately with id + per-part preview", () => {
        const cleanup = provide([
            {
                ordinal: 10,
                id: "msg_a",
                role: "user",
                parts: [{ type: "text", text: "please read the config" }],
            },
            {
                ordinal: 11,
                id: "msg_b",
                role: "assistant",
                parts: [
                    { type: "text", text: "Reading it now." },
                    ocTool("read", "read:1", { filePath: "config.ts" }, "line1\nline2\nline3"),
                ],
            },
        ]);
        try {
            const out = renderVerboseRange(SESSION, 10, 11, 15_000);
            // Each message rendered separately, with its id in the header.
            expect(out.text).toContain("[10] msg_a U (user)");
            expect(out.text).toContain("[11] msg_b A (assistant)");
            // Tool call shown with its name+arg and output size, not raw output.
            expect(out.text).toContain("tool read(config.ts)");
            expect(out.text).toMatch(/→ output ~\d+ tok/);
            // Preview is a preview — the raw multi-line output isn't dumped here.
            expect(out.text).not.toContain("line2");
            expect(out.lastOrdinal).toBe(11);
            expect(out.truncated).toBe(false);
        } finally {
            cleanup();
        }
    });

    test("only includes messages within [start,end]", () => {
        const cleanup = provide([
            { ordinal: 5, id: "msg_before", role: "user", parts: [{ type: "text", text: "x" }] },
            { ordinal: 10, id: "msg_in", role: "user", parts: [{ type: "text", text: "y" }] },
            { ordinal: 99, id: "msg_after", role: "user", parts: [{ type: "text", text: "z" }] },
        ]);
        try {
            const out = renderVerboseRange(SESSION, 10, 20, 15_000);
            expect(out.text).toContain("msg_in");
            expect(out.text).not.toContain("msg_before");
            expect(out.text).not.toContain("msg_after");
        } finally {
            cleanup();
        }
    });

    test("token budget truncates across many messages and reports continuation", () => {
        // Verbose previews are capped per-part, so truncation is driven by the
        // NUMBER of messages, not one giant message. Each block here is ~tens of
        // tokens; a tight budget fits the first but not the second.
        const text = "word ".repeat(40);
        const cleanup = provide([
            { ordinal: 1, id: "m1", role: "user", parts: [{ type: "text", text }] },
            { ordinal: 2, id: "m2", role: "user", parts: [{ type: "text", text }] },
            { ordinal: 3, id: "m3", role: "user", parts: [{ type: "text", text }] },
        ]);
        try {
            const out = renderVerboseRange(SESSION, 1, 3, 30);
            // First block always emitted (never an empty result), then truncates.
            expect(out.text).toContain("[1] m1");
            expect(out.truncated).toBe(true);
            expect(out.lastOrdinal).toBe(1);
        } finally {
            cleanup();
        }
    });
});

describe("renderMessageById", () => {
    test("recovers the FULL untruncated tool output (the ctx_reduce way-back)", () => {
        const fullOutput = "ERROR at line 42\n".repeat(50);
        const cleanup = provide([
            {
                ordinal: 7,
                id: "msg_tool",
                role: "assistant",
                parts: [ocTool("bash", "bash:9", { description: "run tests" }, fullOutput)],
            },
        ]);
        try {
            const out = renderMessageById(SESSION, "msg_tool");
            expect(out).toContain("[7] msg_tool A (assistant)");
            expect(out).toContain("[tool: bash #bash:9]");
            // FULL output present, not a preview/size.
            expect(out).toContain(fullOutput.trim().slice(0, 30));
            expect(out).toContain("input:");
        } finally {
            cleanup();
        }
    });

    test("recovers a non-tool user message in full (any role)", () => {
        const paste = "a very long pasted log\n".repeat(20);
        const cleanup = provide([
            { ordinal: 3, id: "msg_paste", role: "user", parts: [{ type: "text", text: paste }] },
        ]);
        try {
            const out = renderMessageById(SESSION, "msg_paste");
            expect(out).toContain("[3] msg_paste U (user)");
            expect(out).toContain("[text]");
            expect(out).toContain(paste.trim().slice(0, 30));
        } finally {
            cleanup();
        }
    });

    test("missing id reports deleted, does not throw", () => {
        const cleanup = provide([
            { ordinal: 1, id: "exists", role: "user", parts: [{ type: "text", text: "hi" }] },
        ]);
        try {
            const out = renderMessageById(SESSION, "msg_gone");
            expect(out).toContain("not in this session's stored history");
            expect(out).toContain("deleted");
        } finally {
            cleanup();
        }
    });
});
