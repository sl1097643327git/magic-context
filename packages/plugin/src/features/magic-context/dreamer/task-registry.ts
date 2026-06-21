/**
 * Canonical Dreamer v2 task registry (pure — no DB imports, so the config schema
 * can import the task names without pulling runtime code).
 *
 * v2 promotes the former post-phases (review-user-memories, key-files,
 * evaluate-smart-notes) to first-class scheduled tasks alongside the agentic
 * maintenance tasks, and assigns each a LEASE DOMAIN so disjoint-state tasks run
 * concurrently while memory-mutating tasks serialize. See lease.ts + the A+B spec.
 */

export const CANONICAL_DREAM_TASKS = [
    "verify",
    "verify-broad",
    "curate",
    "classify-memories",
    "retrospective",
    "maintain-docs",
    "key-files",
    "evaluate-smart-notes",
    "review-user-memories",
] as const;

export type DreamTaskName = (typeof CANONICAL_DREAM_TASKS)[number];

/**
 * The agentic tasks — those run as a generic dreamer agent session driven by
 * `buildDreamTaskPrompt`. The other canonical tasks (review-user-memories,
 * key-files, evaluate-smart-notes) have their own specialized runners and do NOT
 * go through the prompt builder.
 */
export const AGENTIC_DREAM_TASKS = [
    "verify",
    "verify-broad",
    "curate",
    "classify-memories",
    "maintain-docs",
] as const;

export type AgenticDreamTask = (typeof AGENTIC_DREAM_TASKS)[number];

const AGENTIC_SET = new Set<string>(AGENTIC_DREAM_TASKS);

export function isAgenticTask(task: DreamTaskName): task is AgenticDreamTask {
    return AGENTIC_SET.has(task);
}

/**
 * Tasks that read-modify-write the project `memories` table (+ epoch +
 * supersede-delta rows). They SHARE one per-project "memory" lease so they
 * serialize with each other — concurrent runs race semantically (stale-view
 * merges/splits). Canonical run order when several are due in one drain.
 */
export const MEMORY_DOMAIN_TASKS: readonly DreamTaskName[] = [
    "verify",
    "verify-broad",
    "curate",
    "classify-memories",
    "retrospective",
];

const MEMORY_DOMAIN_SET = new Set<DreamTaskName>(MEMORY_DOMAIN_TASKS);

/**
 * Lease KIND per task. `memory` + the three independent kinds are per-project;
 * `user-memories` is GLOBAL (mutates the cross-project user-profile pool, so two
 * different projects' dreamers must not review concurrently).
 */
export type LeaseKind =
    | "memory"
    | "maintain-docs"
    | "key-files"
    | "evaluate-smart-notes"
    | "user-memories";

export function leaseKindFor(task: DreamTaskName): LeaseKind {
    if (MEMORY_DOMAIN_SET.has(task)) return "memory";
    switch (task) {
        case "review-user-memories":
            return "user-memories";
        case "maintain-docs":
            return "maintain-docs";
        case "key-files":
            return "key-files";
        case "evaluate-smart-notes":
            return "evaluate-smart-notes";
        default:
            // Memory-domain tasks already returned above; this is unreachable.
            return "memory";
    }
}

/**
 * Resolve the concrete lease key for a task in a project. The global
 * `user-memories` lease is NOT project-scoped (one reviewer across all projects);
 * every other domain is keyed by project so different projects never block.
 */
export function leaseKeyFor(task: DreamTaskName, projectIdentity: string): string {
    const kind = leaseKindFor(task);
    return kind === "user-memories" ? "user-memories" : `${kind}:${projectIdentity}`;
}

export function isCanonicalDreamTask(value: string): value is DreamTaskName {
    return (CANONICAL_DREAM_TASKS as readonly string[]).includes(value);
}

/**
 * Stable canonical ordering used when multiple due tasks share a lease domain
 * (preserves the suite order for the memory domain).
 */
export function compareTaskOrder(a: DreamTaskName, b: DreamTaskName): number {
    return CANONICAL_DREAM_TASKS.indexOf(a) - CANONICAL_DREAM_TASKS.indexOf(b);
}
