import { existsSync } from "node:fs";
import { DREAMER_AGENT } from "../../../agents/dreamer";
import type { DreamingTask } from "../../../config/schema/magic-context";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { describeError } from "../../../shared/error-message";
import { shouldKeepSubagents } from "../../../shared/keep-subagents";
import { log } from "../../../shared/logger";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runKeyFilesTask } from "../key-files/identify-key-files";
import { getMemoryCountsByStatus } from "../memory/storage-memory";
import { recordChildInvocation } from "../subagent-token-capture";
import { reviewUserMemories } from "../user-memory/review-user-memories";
import { getActiveUserMemories } from "../user-memory/storage-user-memory";
import { evaluateSmartNotes } from "./evaluate-smart-notes";
import { renewLease } from "./lease";
import {
    enforceMaintainDocsProtectedRegions,
    snapshotMaintainDocsFiles,
} from "./maintain-docs-protected-enforcement";
import { insertDreamRun } from "./storage-dream-runs";
import { getTaskScheduleState } from "./storage-task-schedule";
import { buildDreamTaskPrompt, DREAMER_SYSTEM_PROMPT } from "./task-prompts";
import { isAgenticTask } from "./task-registry";
import type { DreamTaskRuntimeConfig, TaskExecOutcome, TaskExecutor } from "./task-scheduler";

export interface DreamTaskExecutorDeps {
    client: PluginContext["client"];
    /** Filesystem directory of the project this drain owns (NOT the identity). */
    sessionDirectory: string;
    /** Opens the OpenCode DB read-only (for the key-files candidate scan). The
     *  dream-timer owns the path resolution; null when unavailable. */
    openOpenCodeDb: () => Database | null;
}

/** A failed task either hot-retries (transient: provider/network/rate-limit/
 *  timeout/abort/lease/busy) or advances to the next cron slot (permanent:
 *  model-not-found, validation, parse). Classify off the error shape. */
function classifyFailure(error: unknown): { transient: boolean; brief: string } {
    const described = describeError(error);
    const brief = described.brief;
    const name = error instanceof Error ? error.name : "";
    const combined = `${name} ${brief}`.toLowerCase();
    const transient =
        name === "AbortError" ||
        /lease|timeout|timed out|econn|socket|network|rate.?limit|429|503|overloaded|sqlite_busy|database is locked/.test(
            combined,
        );
    return { transient, brief };
}

function countNewIds(beforeIds: number[], afterIds: number[]): number {
    const before = new Set(beforeIds);
    let n = 0;
    for (const id of afterIds) if (!before.has(id)) n++;
    return n;
}

/**
 * Build the TaskExecutor the v2 scheduler drives. The scheduler owns the keyed
 * domain lease + holderId and hands them in; this executor runs one task's actual
 * work (LLM loop / specialized runner), renews the lease during the run, aborts
 * if the lease is lost, and writes one per-task dream_runs telemetry row.
 */
export function createDreamTaskExecutor(deps: DreamTaskExecutorDeps): TaskExecutor {
    let parentSessionIdResolved = false;
    let parentSessionId: string | undefined;

    const resolveParentSessionId = async (): Promise<string | undefined> => {
        if (parentSessionIdResolved) return parentSessionId;
        parentSessionIdResolved = true;
        try {
            const listResponse = await deps.client.session.list({
                query: { directory: deps.sessionDirectory },
            });
            const sessions = shared.normalizeSDKResponse(listResponse, [] as { id?: string }[], {
                preferResponseOnMissingData: true,
            });
            parentSessionId = sessions?.find((s) => typeof s?.id === "string")?.id;
        } catch {
            parentSessionId = undefined;
        }
        return parentSessionId;
    };

    return async (
        config: DreamTaskRuntimeConfig,
        ctx: { db: Database; projectIdentity: string; holderId: string; leaseKey: string },
    ): Promise<TaskExecOutcome> => {
        const { db, projectIdentity, holderId, leaseKey } = ctx;
        const startedAt = Date.now();
        const deadline = startedAt + config.timeoutMinutes * 60 * 1000;
        const parent = await resolveParentSessionId();

        const recordRun = (
            status: "completed" | "failed",
            error: string | null,
            extra?: {
                memoryChanges?: ReturnType<typeof computeMemoryDelta>;
                smartNotesSurfaced?: number;
                smartNotesPending?: number;
            },
        ): void => {
            try {
                insertDreamRun(db, {
                    projectPath: projectIdentity,
                    startedAt,
                    finishedAt: Date.now(),
                    holderId,
                    tasks: [
                        {
                            name: config.task,
                            durationMs: Date.now() - startedAt,
                            resultChars: 0,
                            ...(error ? { error } : {}),
                        },
                    ],
                    tasksSucceeded: status === "completed" ? 1 : 0,
                    tasksFailed: status === "failed" ? 1 : 0,
                    smartNotesSurfaced: extra?.smartNotesSurfaced ?? 0,
                    smartNotesPending: extra?.smartNotesPending ?? 0,
                    memoryChanges: extra?.memoryChanges ?? null,
                    parentSessionId: parent ?? null,
                });
            } catch (e) {
                log(`[dreamer] failed to record dream_run for ${config.task}: ${e}`);
            }
        };

        function computeMemoryDelta(
            before: ReturnType<typeof getMemoryCountsByStatus>,
        ): { written: number; deleted: number; archived: number; merged: number } | null {
            const after = getMemoryCountsByStatus(db, projectIdentity);
            const changes = {
                written: countNewIds(before.ids, after.ids),
                deleted: countNewIds(after.ids, before.ids),
                archived: countNewIds(before.archivedIds, after.archivedIds),
                merged: countNewIds(before.mergedIds, after.mergedIds),
            };
            return Object.values(changes).some((v) => v > 0) ? changes : null;
        }

        try {
            if (config.task === "review-user-memories") {
                const result = await reviewUserMemories({
                    db,
                    client: deps.client,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    promotionThreshold: config.promotionThreshold ?? 3,
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                });
                recordRun("completed", null);
                log(
                    `[dreamer] review-user-memories: promoted=${result.promoted} merged=${result.merged} dismissed=${result.dismissed}`,
                );
                return { status: "completed" };
            }

            if (config.task === "evaluate-smart-notes") {
                const result = await evaluateSmartNotes({
                    db,
                    client: deps.client,
                    projectIdentity,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                });
                recordRun("completed", null, {
                    smartNotesSurfaced: result.surfaced,
                    smartNotesPending: result.pending,
                });
                return { status: "completed" };
            }

            if (config.task === "key-files") {
                const openCodeDb = deps.openOpenCodeDb();
                if (!openCodeDb) {
                    recordRun("completed", null);
                    return { status: "completed" }; // nothing to do without the OpenCode DB
                }
                try {
                    await runKeyFilesTask({
                        db,
                        openCodeDb,
                        client: deps.client,
                        projectPath: deps.sessionDirectory,
                        config: {
                            enabled: true,
                            token_budget: config.tokenBudget ?? 10000,
                            min_reads: config.minReads ?? 4,
                        },
                        holderId,
                        leaseKey,
                        deadline,
                        parentSessionId: parent,
                        model: config.model,
                        fallbackModels: config.fallbackModels,
                    });
                } finally {
                    closeQuietly(openCodeDb);
                }
                recordRun("completed", null);
                return { status: "completed" };
            }

            // Agentic tasks: consolidate / verify / archive-stale / improve / maintain-docs.
            return await runAgenticTask(config, ctx, {
                deps,
                deadline,
                parent,
                recordRun,
                computeMemoryDelta,
            });
        } catch (error) {
            const { transient, brief } = classifyFailure(error);
            recordRun("failed", brief);
            log(`[dreamer] task ${config.task} failed (transient=${transient}): ${brief}`);
            return { status: "failed", transient, error: brief };
        }
    };
}

/** The generic agentic-task path (prompt + child session + per-task model),
 *  with lease renewal → abort-on-loss and maintain-docs protected-region enforce. */
async function runAgenticTask(
    config: DreamTaskRuntimeConfig,
    ctx: { db: Database; projectIdentity: string; holderId: string; leaseKey: string },
    helpers: {
        deps: DreamTaskExecutorDeps;
        deadline: number;
        parent: string | undefined;
        recordRun: (
            status: "completed" | "failed",
            error: string | null,
            extra?: {
                memoryChanges?: {
                    written: number;
                    deleted: number;
                    archived: number;
                    merged: number;
                } | null;
            },
        ) => void;
        computeMemoryDelta: (
            before: ReturnType<typeof getMemoryCountsByStatus>,
        ) => { written: number; deleted: number; archived: number; merged: number } | null;
    },
): Promise<TaskExecOutcome> {
    const { db, projectIdentity, holderId, leaseKey } = ctx;
    const { deps, deadline, parent } = helpers;
    const task = config.task as DreamingTask;
    const docsDir = deps.sessionDirectory;
    const invocationStartedAt = Date.now();
    const memoryBefore = getMemoryCountsByStatus(db, projectIdentity);

    const lastRunAt = getTaskScheduleState(db, projectIdentity, config.task)?.lastRunAt ?? null;

    const maintainDocsSnapshot =
        task === "maintain-docs" ? snapshotMaintainDocsFiles(docsDir) : undefined;
    const existingDocs =
        task === "maintain-docs"
            ? {
                  architecture: existsSync(`${docsDir}/ARCHITECTURE.md`),
                  structure: existsSync(`${docsDir}/STRUCTURE.md`),
              }
            : undefined;
    const userMemories =
        task === "archive-stale"
            ? getActiveUserMemories(db).map((um) => ({ id: um.id, content: um.content }))
            : undefined;

    const taskPrompt = buildDreamTaskPrompt(task, {
        projectPath: projectIdentity,
        lastDreamAt: lastRunAt ? String(lastRunAt) : null,
        existingDocs,
        userMemories,
    });

    const abortController = new AbortController();
    let leaseLost = false;
    const leaseInterval = setInterval(() => {
        try {
            if (!renewLease(db, holderId, leaseKey)) {
                leaseLost = true;
                abortController.abort();
            }
        } catch {
            leaseLost = true;
            abortController.abort();
        }
    }, 60_000);

    let childSessionId: string | null = null;
    let taskFailed = false;
    try {
        const createResponse = await deps.client.session.create({
            body: {
                ...(parent ? { parentID: parent } : {}),
                title: `magic-context-dream-${task}`,
            },
            query: { directory: docsDir },
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            {
                preferResponseOnMissingData: true,
            },
        );
        childSessionId = typeof created?.id === "string" ? created.id : null;
        if (!childSessionId) throw new Error("Dreamer could not create its child session.");
        const sessionId = childSessionId;

        const remainingMs = Math.max(0, deadline - Date.now());
        const run = await shared.promptSyncWithValidatedOutputRetry(
            deps.client,
            {
                path: { id: sessionId },
                query: { directory: docsDir },
                body: {
                    agent: DREAMER_AGENT,
                    system: DREAMER_SYSTEM_PROMPT,
                    ...modelBodyField(config.model),
                    parts: [{ type: "text", text: taskPrompt, synthetic: true }],
                },
            },
            {
                timeoutMs: Math.min(remainingMs, config.timeoutMinutes * 60 * 1000),
                signal: abortController.signal,
                fallbackModels: config.fallbackModels,
                callContext: `dreamer:${task}`,
                fetchOutput: async () => {
                    const messagesResponse = await deps.client.session.messages({
                        path: { id: sessionId },
                        query: { directory: docsDir, limit: 50 },
                    });
                    return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                        preferResponseOnMissingData: true,
                    });
                },
                validateOutput: (messages) => {
                    const text = extractLatestAssistantText(messages);
                    if (!text) throw new Error("Dreamer returned no assistant output.");
                    return text;
                },
            },
        );

        if (leaseLost) throw new Error("Dream lease lost during task");

        if (parent) {
            recordChildInvocation({
                db,
                parentSessionId: parent,
                harness: "opencode",
                subagent: "dreamer",
                task,
                startedAt: invocationStartedAt,
                status: "completed",
                messages: run.output,
            });
        }

        if (task === "maintain-docs" && maintainDocsSnapshot && maintainDocsSnapshot.size > 0) {
            try {
                enforceMaintainDocsProtectedRegions({ docsDir, snapshot: maintainDocsSnapshot });
            } catch (e) {
                log(`[dreamer] maintain-docs protected-region enforcement failed: ${e}`);
            }
        }

        helpers.recordRun("completed", null, {
            memoryChanges: helpers.computeMemoryDelta(memoryBefore),
        });
        return { status: "completed" };
    } catch (error) {
        taskFailed = true;
        throw error;
    } finally {
        clearInterval(leaseInterval);
        if (childSessionId && !taskFailed && !shouldKeepSubagents()) {
            await deps.client.session.delete({ path: { id: childSessionId } }).catch(() => {});
        }
    }
}

/** Re-export for the dream-timer's executor wiring. */
export { isAgenticTask };
