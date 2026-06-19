/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { migrateDreamerV2 } from "./migrate-dreamer-v2";

function migrate(raw: Record<string, unknown>): {
    out: Record<string, unknown>;
    warnings: string[];
} {
    const warnings: string[] = [];
    const out = migrateDreamerV2(raw, warnings);
    return { out, warnings };
}

function tasks(
    out: Record<string, unknown>,
): Record<string, { schedule?: string } & Record<string, unknown>> {
    return (out.dreamer as Record<string, unknown>).tasks as Record<
        string,
        { schedule?: string } & Record<string, unknown>
    >;
}

describe("migrateDreamerV2", () => {
    it("is a no-op when there is no dreamer block", () => {
        const { out } = migrate({ enabled: true });
        expect(out).toEqual({ enabled: true });
    });

    it("is a no-op (idempotent) when tasks is already a v2 record", () => {
        const v2 = { dreamer: { tasks: { consolidate: { schedule: "0 3 * * *" } } } };
        const { out, warnings } = migrate(structuredClone(v2));
        expect(out).toEqual(v2);
        expect(warnings).toHaveLength(0);
    });

    it("is a no-op when dreamer has only non-legacy keys (e.g. model)", () => {
        const { out, warnings } = migrate({ dreamer: { model: "x/y" } });
        expect(out).toEqual({ dreamer: { model: "x/y" } });
        expect(warnings).toHaveLength(0);
    });

    it("derives the base cron from the window START", () => {
        const { out } = migrate({ dreamer: { schedule: "02:00-06:00", tasks: ["consolidate"] } });
        expect(tasks(out).consolidate.schedule).toBe("0 2 * * *");
    });

    it("listed tasks get the base cron; OMITTED canonical tasks are DISABLED", () => {
        // Deliberate selection: only consolidate + verify. The others must be "".
        const { out } = migrate({
            dreamer: { schedule: "03:30-06:00", tasks: ["consolidate", "verify"] },
        });
        const t = tasks(out);
        expect(t.consolidate.schedule).toBe("30 3 * * *");
        expect(t.verify.schedule).toBe("30 3 * * *");
        expect(t["archive-stale"].schedule).toBe(""); // omitted → disabled
        expect(t.improve.schedule).toBe(""); // omitted → disabled
        expect(t["maintain-docs"].schedule).toBe(""); // omitted → disabled
    });

    it("when tasks array is ABSENT, preserves the v1 default suite (maintain-docs off)", () => {
        const { out } = migrate({ dreamer: { schedule: "02:00-06:00" } });
        const t = tasks(out);
        expect(t.consolidate.schedule).toBe("0 2 * * *");
        expect(t.verify.schedule).toBe("0 2 * * *");
        expect(t["archive-stale"].schedule).toBe("0 2 * * *");
        expect(t.improve.schedule).toBe("0 2 * * *");
        expect(t["maintain-docs"].schedule).toBe(""); // not in v1 default list
    });

    it("user_memories.enabled false → review-user-memories disabled (opt-out preserved)", () => {
        const { out } = migrate({
            dreamer: { schedule: "02:00-06:00", user_memories: { enabled: false } },
        });
        expect(tasks(out)["review-user-memories"].schedule).toBe("");
    });

    it("user_memories default (no block) → review-user-memories enabled", () => {
        const { out } = migrate({ dreamer: { schedule: "02:00-06:00" } });
        const rum = tasks(out)["review-user-memories"];
        expect(rum.schedule).toBe("0 2 * * *");
    });

    it("carries user_memories.promotion_threshold", () => {
        const { out } = migrate({
            dreamer: {
                schedule: "02:00-06:00",
                user_memories: { enabled: true, promotion_threshold: 7 },
            },
        });
        expect(tasks(out)["review-user-memories"].promotion_threshold).toBe(7);
    });

    it("pin_key_files.enabled true → key-files scheduled, carries token_budget/min_reads", () => {
        const { out } = migrate({
            dreamer: {
                schedule: "02:00-06:00",
                pin_key_files: { enabled: true, token_budget: 8000, min_reads: 6 },
            },
        });
        const kf = tasks(out)["key-files"];
        expect(kf.schedule).toBe("0 2 * * *");
        expect(kf.token_budget).toBe(8000);
        expect(kf.min_reads).toBe(6);
    });

    it("pin_key_files default (no block) → key-files DISABLED (v1 default off)", () => {
        const { out } = migrate({ dreamer: { schedule: "02:00-06:00" } });
        expect(tasks(out)["key-files"].schedule).toBe("");
    });

    it("evaluate-smart-notes always gets the base cron", () => {
        const { out } = migrate({ dreamer: { schedule: "02:00-06:00", tasks: [] } });
        expect(tasks(out)["evaluate-smart-notes"].schedule).toBe("0 2 * * *");
    });

    it("task_timeout_minutes becomes each task's timeout_minutes", () => {
        const { out } = migrate({
            dreamer: { schedule: "02:00-06:00", task_timeout_minutes: 15 },
        });
        const t = tasks(out);
        expect(t.consolidate.timeout_minutes).toBe(15);
        expect(t["review-user-memories"].timeout_minutes).toBe(15);
    });

    it("drops retired keys and preserves agent-config keys (model, disable)", () => {
        const { out } = migrate({
            dreamer: {
                schedule: "02:00-06:00",
                max_runtime_minutes: 120,
                model: "anthropic/x",
                disable: false,
            },
        });
        const d = out.dreamer as Record<string, unknown>;
        expect(d.model).toBe("anthropic/x");
        expect(d.disable).toBe(false);
        expect("schedule" in d).toBe(false);
        expect("max_runtime_minutes" in d).toBe(false);
        expect("user_memories" in d).toBe(false);
        expect("pin_key_files" in d).toBe(false);
    });

    it("falls back to the default base cron on an unparseable window", () => {
        const { out } = migrate({ dreamer: { schedule: "garbage", tasks: ["consolidate"] } });
        expect(tasks(out).consolidate.schedule).toBe("0 2 * * *");
    });

    it("emits a migration warning", () => {
        const { warnings } = migrate({ dreamer: { schedule: "02:00-06:00" } });
        expect(warnings.join("\n")).toContain("dreamer.tasks");
    });

    it("all 8 canonical tasks are present after migration", () => {
        const { out } = migrate({ dreamer: { schedule: "02:00-06:00" } });
        expect(Object.keys(tasks(out)).sort()).toEqual(
            [
                "archive-stale",
                "consolidate",
                "evaluate-smart-notes",
                "improve",
                "key-files",
                "maintain-docs",
                "review-user-memories",
                "verify",
            ].sort(),
        );
    });
});
