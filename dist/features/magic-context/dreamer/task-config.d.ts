import type { DreamerConfig } from "../../../config/schema/magic-context";
import { type DreamTaskName } from "./task-registry";
import type { DreamTaskRuntimeConfig } from "./task-scheduler";
/**
 * Resolve the full per-task runtime config the scheduler consumes from the
 * validated dreamer config: each task's schedule + its effective model chain
 * (task override → dreamer-level default), thinking level, timeout, and
 * task-specific params. One place owns the inheritance rule.
 */
export declare function buildDreamTaskRuntimeConfigs(dreamer: DreamerConfig, language?: string): DreamTaskRuntimeConfig[];
/**
 * The collection privacy gate (Option C): user-behavior observation candidates
 * are stored during historian runs ONLY when the user has scheduled the
 * review-user-memories task (schedule != ""). Replaces the v1
 * `user_memories.enabled` flag, which both gated collection AND review.
 */
export declare function userMemoryCollectionEnabled(dreamer: DreamerConfig | undefined): boolean;
/** The promotion threshold for user-memory review (collection + review share it). */
export declare function userMemoryPromotionThreshold(dreamer: DreamerConfig | undefined): number;
/** True when a task is scheduled (schedule != ""). Generic enable check. */
export declare function dreamTaskScheduled(dreamer: DreamerConfig | undefined, task: keyof NonNullable<DreamerConfig["tasks"]>): boolean;
/** Names of the tasks the user has scheduled (schedule != ""), in canonical order. */
export declare function enabledDreamTasks(dreamer: DreamerConfig | undefined): DreamTaskName[];
/** A compact `/ctx-status`-style schedule summary, e.g.
 *  "verify 0 3 * * *, curate 0 4 * * 0" — or "manual-only" when nothing is
 *  scheduled. */
export declare function summarizeDreamSchedule(dreamer: DreamerConfig | undefined): string;
//# sourceMappingURL=task-config.d.ts.map