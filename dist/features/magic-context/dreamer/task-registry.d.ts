/**
 * Canonical Dreamer v2 task registry (pure — no DB imports, so the config schema
 * can import the task names without pulling runtime code).
 *
 * v2 promotes the former post-phases (review-user-memories, key-files,
 * evaluate-smart-notes) to first-class scheduled tasks alongside the agentic
 * maintenance tasks, and assigns each a LEASE DOMAIN so disjoint-state tasks run
 * concurrently while memory-mutating tasks serialize. See lease.ts + the A+B spec.
 */
export declare const CANONICAL_DREAM_TASKS: readonly ["map-memories", "verify", "verify-broad", "curate", "classify-memories", "retrospective", "maintain-docs", "evaluate-smart-notes", "review-user-memories", "promote-primers", "refresh-primers"];
export type DreamTaskName = (typeof CANONICAL_DREAM_TASKS)[number];
/**
 * The agentic tasks — those run as a generic dreamer agent session driven by
 * `buildDreamTaskPrompt`. The other canonical tasks (map-memories, verify,
 * verify-broad, classify-memories, review-user-memories, evaluate-smart-notes,
 * primers, retrospective) have their own specialized runners and do NOT go
 * through the prompt builder.
 */
export declare const AGENTIC_DREAM_TASKS: readonly ["curate", "maintain-docs"];
export type AgenticDreamTask = (typeof AGENTIC_DREAM_TASKS)[number];
/**
 * Tasks that read-modify-write the project `memories` table (+ epoch +
 * supersede-delta rows). They SHARE one per-project "memory" lease so they
 * serialize with each other — concurrent runs race semantically (stale-view
 * merges/splits). Canonical run order when several are due in one drain.
 */
export declare const MEMORY_DOMAIN_TASKS: readonly DreamTaskName[];
/**
 * Lease KIND per task. `memory` + the three independent kinds are per-project;
 * `user-memories` is GLOBAL (mutates the cross-project user-profile pool, so two
 * different projects' dreamers must not review concurrently).
 */
export type LeaseKind = "memory" | "maintain-docs" | "evaluate-smart-notes" | "user-memories";
export declare function leaseKindFor(task: DreamTaskName): LeaseKind;
/**
 * Resolve the concrete lease key for a task in a project. The global
 * `user-memories` lease is NOT project-scoped (one reviewer across all projects);
 * every other domain is keyed by project so different projects never block.
 */
export declare function leaseKeyFor(task: DreamTaskName, projectIdentity: string): string;
export declare function isCanonicalDreamTask(value: string): value is DreamTaskName;
/**
 * Stable canonical ordering used when multiple due tasks share a lease domain
 * (preserves the suite order for the memory domain).
 */
export declare function compareTaskOrder(a: DreamTaskName, b: DreamTaskName): number;
//# sourceMappingURL=task-registry.d.ts.map