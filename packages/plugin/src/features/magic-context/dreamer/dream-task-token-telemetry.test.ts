import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guard for dream-task token telemetry.
//
// The dashboard enriches each dream-run task row by grouping
// `subagent_invocations` WHERE subagent='dreamer' GROUP BY task, then matching
// `task` to the phase `name` pushed in the dreamer runner. Two phases record
// their LLM token usage OUTSIDE the runner's main task loop, so they must
// (a) call recordChildInvocation at all, and (b) use subagent:"dreamer" with a
// `task` string that EXACTLY matches the phase name — otherwise the dashboard
// shows "—" tokens for a real LLM call (and keep_subagents data has a hole).
//
// These two phases previously regressed: key-files (the v6 runKeyFilesTask)
// never recorded, and user-memory review recorded as subagent:"user_memory_review"
// with no task. This static source-text guard fails if either reverts.

const HERE = import.meta.dir;

function read(relFromFeatures: string): string {
    return readFileSync(join(HERE, "..", relFromFeatures), "utf-8");
}

describe("dream-task token telemetry mapping", () => {
    it('key-files task records a dreamer invocation tagged task:"key files"', () => {
        const src = read("key-files/identify-key-files.ts");
        expect(src.includes("recordChildInvocation")).toBe(true);
        expect(src.includes('subagent: "dreamer"')).toBe(true);
        // Must match the phase name pushed by the runner (name: "key files").
        expect(src.includes('task: "key files"')).toBe(true);
    });

    it('user-memory review records a dreamer invocation tagged task:"user memories"', () => {
        const src = read("user-memory/review-user-memories.ts");
        expect(src.includes("recordChildInvocation")).toBe(true);
        expect(src.includes('subagent: "dreamer"')).toBe(true);
        // Must match the phase name pushed by the runner (name: "user memories").
        expect(src.includes('task: "user memories"')).toBe(true);
    });

    it("the runner phase names match the recorded task strings", () => {
        const runner = read("dreamer/runner.ts");
        // The two out-of-loop phases push these exact names; the recorders above
        // must use the identical strings for the dashboard GROUP BY to map.
        expect(runner.includes('name: "key files"')).toBe(true);
        expect(runner.includes('name: "user memories"')).toBe(true);
    });
});
