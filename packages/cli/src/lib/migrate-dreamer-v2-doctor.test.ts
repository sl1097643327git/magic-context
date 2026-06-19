import { describe, expect, it } from "bun:test";
import { migrateDreamerV2ForDoctor } from "./migrate-dreamer-v2-doctor";

function tasksOf(
    cfg: Record<string, unknown>,
): Record<string, { schedule?: string } & Record<string, unknown>> {
    return (cfg.dreamer as Record<string, unknown>).tasks as Record<
        string,
        { schedule?: string } & Record<string, unknown>
    >;
}

describe("migrateDreamerV2ForDoctor", () => {
    it("returns false (no-op) without a dreamer block", () => {
        const cfg: Record<string, unknown> = { enabled: true };
        expect(migrateDreamerV2ForDoctor(cfg)).toBe(false);
    });

    it("is idempotent when tasks is already a v2 record", () => {
        const cfg: Record<string, unknown> = {
            dreamer: { tasks: { consolidate: { schedule: "0 3 * * *" } } },
        };
        expect(migrateDreamerV2ForDoctor(cfg)).toBe(false);
    });

    it("converts window + tasks array → per-task record (window→cron, omitted disabled)", () => {
        const cfg: Record<string, unknown> = {
            dreamer: { schedule: "02:00-06:00", tasks: ["consolidate"] },
        };
        expect(migrateDreamerV2ForDoctor(cfg)).toBe(true);
        const t = tasksOf(cfg);
        expect(t.consolidate.schedule).toBe("0 2 * * *");
        expect(t.verify.schedule).toBe(""); // omitted → disabled
    });

    it("preserves user_memories opt-out and key-files params, drops retired keys", () => {
        const cfg: Record<string, unknown> = {
            dreamer: {
                schedule: "03:00-06:00",
                model: "anthropic/x",
                max_runtime_minutes: 120,
                user_memories: { enabled: false },
                pin_key_files: { enabled: true, token_budget: 9000, min_reads: 5 },
            },
        };
        expect(migrateDreamerV2ForDoctor(cfg)).toBe(true);
        const d = cfg.dreamer as Record<string, unknown>;
        expect(d.model).toBe("anthropic/x"); // agent key preserved
        expect("schedule" in d).toBe(false);
        expect("max_runtime_minutes" in d).toBe(false);
        expect("user_memories" in d).toBe(false);
        expect("pin_key_files" in d).toBe(false);
        const t = tasksOf(cfg);
        expect(t["review-user-memories"].schedule).toBe(""); // opt-out preserved
        expect(t["key-files"].schedule).toBe("0 3 * * *");
        expect(t["key-files"].token_budget).toBe(9000);
        expect(t["key-files"].min_reads).toBe(5);
    });

    it("mutates in place (preserves the original object reference for comment-json)", () => {
        const dreamer: Record<string, unknown> = { schedule: "02:00-06:00" };
        const cfg: Record<string, unknown> = { dreamer };
        migrateDreamerV2ForDoctor(cfg);
        // Same object reference retained (comment-json comment symbols survive).
        expect(cfg.dreamer).toBe(dreamer);
        expect((dreamer.tasks as Record<string, unknown>).consolidate).toBeDefined();
    });
});
