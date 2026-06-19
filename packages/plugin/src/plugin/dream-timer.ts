import type { DreamerConfig } from "../config/schema/magic-context";
import { openOpenCodeDb } from "../features/magic-context/dreamer/open-opencode-db";
import { buildDreamTaskRuntimeConfigs } from "../features/magic-context/dreamer/task-config";
import { createDreamTaskExecutor } from "../features/magic-context/dreamer/task-executor";
import { runDueTasksForProject } from "../features/magic-context/dreamer/task-scheduler";
import {
    acquireGitSweepLease,
    embedUnembeddedCommits,
    GIT_SWEEP_LEASE_RENEWAL_MS,
    indexCommitsForProject,
    markGitSweepSuccessAndRelease,
    releaseGitSweepLease,
    renewGitSweepLease,
} from "../features/magic-context/git-commits";
import {
    embedUnembeddedMemoriesForProject,
    getProjectEmbeddingSnapshot,
} from "../features/magic-context/memory/embedding";
import { drainCommitBacklogForProject } from "../features/magic-context/project-embedding-registry";
import { openDatabase, runSqliteOptimize } from "../features/magic-context/storage";
import { log } from "../shared/logger";
import type { Database } from "../shared/sqlite";
import type { PluginContext } from "./types";

/** Check interval for dream schedule (15 minutes). */
const DREAM_TIMER_INTERVAL_MS = 15 * 60 * 1000;
/** Wall-clock budget for post-sweep commit backlog drain (matches indexer embed sweep). */
const GIT_COMMIT_BACKLOG_DRAIN_MAX_MS = 5 * 60 * 1000;

/**
 * Per-project work registered with the timer. The timer is a process-wide
 * singleton, but Desktop OpenCode can load the same plugin once per project
 * within one process — every load needs its directory's git commits indexed,
 * its dream schedule checked, and its experimental config respected.
 */
interface ProjectRegistration {
    directory: string;
    projectIdentity: string;
    client: PluginContext["client"];
    dreamerConfig?: DreamerConfig;
    gitCommitIndexing?: {
        enabled: boolean;
        since_days: number;
        max_commits: number;
    };
    ensureRegistered: (directory: string, db: Database) => Promise<void>;
}

/** Singleton timer state. */
let activeTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Open the shared DB for timer work, returning null (with one clear log) when
 * storage is unavailable. openDatabase() returns a typed-null on the
 * schema-fence and open-failure paths (e.g. a stale binary that supports an
 * older schema than the DB on disk), so every timer entry point MUST null-check
 * before using the handle — otherwise the null reaches `db.transaction(...)`
 * deep in embedding registration and throws a confusing TypeError.
 */
function openTimerDatabaseOrNull(context: string): Database | null {
    const db = openDatabase();
    if (!db) {
        log(
            `[dreamer] storage unavailable; skipping ${context} (the cache schema is newer than this binary supports — restart/upgrade OpenCode/Pi/Magic Context to recover)`,
        );
        return null;
    }
    return db;
}
/** All projects that have called startDreamScheduleTimer in this process,
 *  keyed by directory so re-registration of the same directory is idempotent. */
const registeredProjects = new Map<string, ProjectRegistration>();

/**
 * Register the calling project with the process-wide dream + maintenance
 * timer. The timer itself is a singleton (we only need one setInterval per
 * process), but every registered project gets its per-directory work — git
 * commit indexing, dream schedule check, dream queue processing — on each
 * tick. The first registration also kicks off an immediate startup tick so
 * fresh installs and restarts don't wait 15 minutes for first-time indexing.
 *
 * Returns a cleanup that removes this project's registration. The timer
 * itself stops only when the last project unregisters.
 */
export async function startDreamScheduleTimer(
    args: ProjectRegistration,
): Promise<(() => void) | undefined> {
    const db = openTimerDatabaseOrNull("schedule timer registration");
    if (!db) return;
    await args.ensureRegistered(args.directory, db);
    const snapshot = getProjectEmbeddingSnapshot(args.projectIdentity);
    const dreamingEnabled = Boolean(args.dreamerConfig && args.dreamerConfig.disable !== true);
    const embeddingSweepEnabled = snapshot?.enabled ?? false;
    const commitIndexingEnabled = snapshot?.gitCommitEnabled ?? false;

    if (!dreamingEnabled && !embeddingSweepEnabled && !commitIndexingEnabled) {
        return;
    }

    // Idempotent registration — re-registering the same directory replaces
    // the prior config (e.g., if config was reloaded for that project).
    const isNewRegistration = !registeredProjects.has(args.directory);
    registeredProjects.set(args.directory, args);

    if (isNewRegistration) {
        log(
            `[dreamer] registered project ${args.projectIdentity} (dreaming=${dreamingEnabled} embeddings=${embeddingSweepEnabled} commits=${commitIndexingEnabled}; total=${registeredProjects.size})`,
        );
    }

    if (!activeTimer) {
        // First registration in this process — start the timer and run an
        // immediate startup tick so embedding backfill, commit indexing, and
        // dream schedule checks don't wait 15 minutes after a fresh install.
        log(
            `[dreamer] started independent schedule timer (every ${DREAM_TIMER_INTERVAL_MS / 60_000}m)`,
        );

        runTick("startup");

        const timer = setInterval(() => runTick("interval"), DREAM_TIMER_INTERVAL_MS);
        if (typeof timer === "object" && "unref" in timer) {
            timer.unref();
        }
        activeTimer = timer;
    } else if (isNewRegistration) {
        // Timer is already running, but this is a brand-new project — give
        // it the same "no 15-minute wait" treatment by sweeping just this
        // project immediately. Existing projects keep their tick cadence.
        void sweepProject(args, "startup", db);
    }

    return () => {
        registeredProjects.delete(args.directory);
        log(
            `[dreamer] unregistered project ${args.projectIdentity} (remaining=${registeredProjects.size})`,
        );
        if (registeredProjects.size === 0 && activeTimer) {
            clearInterval(activeTimer);
            activeTimer = null;
            log("[dreamer] stopped dream schedule timer (no projects left)");
        }
    };
}

/**
 * Single tick body. Runs the global memory embedding sweep once, then
 * iterates every registered project for its per-directory work.
 */
function runTick(origin: "startup" | "interval"): void {
    log(`[dreamer] timer tick (${origin}) — projects=${registeredProjects.size}`);
    void (async () => {
        try {
            const db = openTimerDatabaseOrNull("maintenance tick");
            if (!db) return;
            // Per-project work — git commit indexing, dream schedule check,
            // dream queue processing. We iterate all registered projects so
            // Desktop's "open all projects at once" workflow indexes every one,
            // not just whichever project happened to register the timer first.
            for (const reg of registeredProjects.values()) {
                await reg.ensureRegistered(reg.directory, db);
                const memorySnapshot = getProjectEmbeddingSnapshot(reg.projectIdentity);
                if (memorySnapshot?.enabled) {
                    const embeddedCount = await embedUnembeddedMemoriesForProject(
                        db,
                        reg.projectIdentity,
                    );
                    if (embeddedCount > 0) {
                        log(
                            `[magic-context] proactively embedded ${embeddedCount} ${embeddedCount === 1 ? "memory" : "memories"} for project ${reg.projectIdentity}`,
                        );
                    }
                    // Compartment-chunk backfill is NOT driven from the timer: a
                    // bounded batch per tick is a slow, bursty trickle that hammers
                    // local embedding endpoints. New compartments embed on publish;
                    // historical backfill runs on demand via /ctx-embed-history.
                }

                await reg.ensureRegistered(reg.directory, db);
                const gitSnapshot = getProjectEmbeddingSnapshot(reg.projectIdentity);
                await sweepProject(reg, origin, db, gitSnapshot?.gitCommitEnabled === true);
            }
            // Refresh planner stats once per tick (after per-project work).
            // Self-gating: a no-op unless a table's row count drifted enough to
            // warrant re-ANALYZE, and analysis_limit bounds any work it does.
            runSqliteOptimize(db);
        } catch (error) {
            log("[magic-context] timer-triggered maintenance check failed:", error);
        }
    })();
}

/**
 * Run all per-project maintenance for one registration: git commit indexing
 * (when enabled) plus dream schedule check + queue processing (when enabled).
 *
 * Each registered project gets its own pass per tick — Desktop loads the
 * plugin once per project in the same process, and every project needs its
 * own commits indexed and its own dream schedule honored.
 */
async function sweepProject(
    reg: ProjectRegistration,
    origin: "startup" | "interval",
    db: Database,
    gitCommitEnabled = getProjectEmbeddingSnapshot(reg.projectIdentity)?.gitCommitEnabled === true,
): Promise<void> {
    const dreamerConfig = reg.dreamerConfig;
    const dreamingEnabled = Boolean(dreamerConfig && dreamerConfig.disable !== true);
    if (gitCommitEnabled && reg.gitCommitIndexing) {
        await sweepGitCommits({
            directory: reg.directory,
            gitCommitIndexing: reg.gitCommitIndexing,
            projectIdentity: reg.projectIdentity,
            db,
        });
    }

    if (!dreamingEnabled || !dreamerConfig) {
        return;
    }

    try {
        // Dreamer v2: per-task cron scheduling. The scheduler seeds/reads
        // task_schedule_state, evaluates each task's cron + activity gate, and
        // runs due tasks grouped by conflict-domain under keyed leases. The
        // executor runs in THIS registration's own checkout (not a sibling
        // worktree the shared git:<sha> identity might resolve to).
        const runtimeConfigs = buildDreamTaskRuntimeConfigs(dreamerConfig);
        const executor = createDreamTaskExecutor({
            client: reg.client,
            sessionDirectory: reg.directory,
            openOpenCodeDb,
        });
        const ran = await runDueTasksForProject({
            db,
            projectIdentity: reg.projectIdentity,
            tasks: runtimeConfigs,
            executor,
        });
        if (ran > 0) {
            log(`[dreamer] timer tick (${origin}) ${reg.projectIdentity} — ran ${ran} task(s)`);
        }
    } catch (error) {
        log(`[dreamer] timer-triggered task scheduling failed for ${reg.projectIdentity}:`, error);
    }
}

/**
 * Index commits for the current project and drain embeddings. Runs in the
 * background under the timer's fire-and-forget contract.
 *
 * Project identity resolution happens inside the indexer so we always read
 * the same `git:<sha>` identity used by memories and ctx_search.
 */
function startGitSweepLeaseRenewal(
    db: Database,
    projectIdentity: string,
    holderId: string,
): () => void {
    const timer = setInterval(() => {
        try {
            if (!renewGitSweepLease(db, projectIdentity, holderId)) {
                log(`[git-commits] sweep lease renewal failed for ${projectIdentity}`);
            }
        } catch (error) {
            log(
                `[git-commits] sweep lease renewal errored for ${projectIdentity}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }, GIT_SWEEP_LEASE_RENEWAL_MS);
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
}

async function sweepGitCommits(args: {
    directory: string;
    projectIdentity: string;
    db: Database;
    gitCommitIndexing: { enabled: boolean; since_days: number; max_commits: number };
}): Promise<void> {
    const { directory, projectIdentity, db, gitCommitIndexing } = args;
    const holderId = crypto.randomUUID();
    const lease = acquireGitSweepLease(db, projectIdentity, holderId);
    if (!lease.acquired) {
        const reason =
            lease.reason === "cooldown_active"
                ? `cooldown active until ${lease.nextAllowedAt}`
                : `lease held by ${lease.leaseHolder ?? "another holder"} until ${lease.leaseExpiresAt ?? "unknown"}`;
        log(`[git-commits] sweep skipped for ${projectIdentity}: ${reason}`);
        return;
    }

    const startedAt = Date.now();
    const stopRenewal = startGitSweepLeaseRenewal(db, projectIdentity, holderId);
    log(
        `[git-commits] sweep starting for ${projectIdentity} (sinceDays=${gitCommitIndexing.since_days} maxCommits=${gitCommitIndexing.max_commits})`,
    );
    try {
        const result = await indexCommitsForProject(db, projectIdentity, directory, {
            sinceDays: gitCommitIndexing.since_days,
            maxCommits: gitCommitIndexing.max_commits,
        });
        // Drain any remaining embedding backlog from this sweep (indexer caps per run).
        let drainedEmbeddings = 0;
        if (result.embedded > 0) {
            drainedEmbeddings = await embedUnembeddedCommits(db, projectIdentity);
        }
        const cooldownMarked = markGitSweepSuccessAndRelease(db, projectIdentity, holderId);
        if (!cooldownMarked) {
            releaseGitSweepLease(db, projectIdentity, holderId);
            log(
                `[git-commits] sweep finished for ${projectIdentity}, but lease was no longer active; cooldown not advanced`,
            );
        }

        const memorySnapshot = getProjectEmbeddingSnapshot(projectIdentity);
        let backlogDrained = 0;
        if (memorySnapshot?.gitCommitEnabled) {
            try {
                backlogDrained = await drainCommitBacklogForProject(
                    db,
                    projectIdentity,
                    Date.now() + GIT_COMMIT_BACKLOG_DRAIN_MAX_MS,
                );
            } catch (error) {
                log(
                    `[git-commits] commit backlog drain failed for ${projectIdentity}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        const elapsedMs = Date.now() - startedAt;
        log(
            `[git-commits] sweep finished for ${projectIdentity} in ${elapsedMs}ms: scanned=${result.scanned} inserted=${result.inserted} updated=${result.updated} evicted=${result.evicted} embedded=${result.embedded} drained=${drainedEmbeddings} backlogDrained=${backlogDrained}`,
        );
    } catch (error) {
        releaseGitSweepLease(db, projectIdentity, holderId);
        const elapsedMs = Date.now() - startedAt;
        log(
            `[git-commits] sweep failed for ${projectIdentity} after ${elapsedMs}ms: ${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
        stopRenewal();
    }
}
