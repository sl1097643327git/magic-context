import { DREAMER_AGENT } from "../../../agents/dreamer";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { shouldKeepSubagents } from "../../../shared/keep-subagents";
import { log } from "../../../shared/logger";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import { getPendingSmartNotes, markNoteChecked, markNoteReady } from "../storage-notes";
import { recordChildInvocation } from "../subagent-token-capture";
import { peekLeaseHolderAndExpiry, renewLease } from "./lease";
import { DREAMER_SYSTEM_PROMPT } from "./task-prompts";

export interface EvaluateSmartNotesArgs {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string | undefined;
    holderId: string;
    /** Keyed lease this task holds (Dreamer v2: per-project evaluate-smart-notes domain). */
    leaseKey: string;
    deadline: number;
    model?: string;
    fallbackModels?: readonly string[];
    onLeaseLost?: (phase: string, error?: unknown) => void;
}

export interface EvaluateSmartNotesResult {
    surfaced: number;
    pending: number;
    /** False when there were no pending notes (the gate should prevent this, but
     *  the runner stays defensive). */
    ran: boolean;
}

/**
 * Evaluate pending smart-note conditions with the dreamer model. Extracted from
 * the v1 runner monolith into a standalone task so the v2 scheduler can run it as
 * a first-class scheduled task under its own keyed lease.
 */
export async function evaluateSmartNotes(
    args: EvaluateSmartNotesArgs,
): Promise<EvaluateSmartNotesResult> {
    const pendingNotes = getPendingSmartNotes(args.db, args.projectIdentity);
    if (pendingNotes.length === 0) {
        log("[dreamer] smart notes: no pending notes to evaluate");
        return { surfaced: 0, pending: 0, ran: false };
    }

    log(`[dreamer] smart notes: evaluating ${pendingNotes.length} pending note(s)`);

    const noteDescriptions = pendingNotes
        .map((n) => `- Note #${n.id}: "${n.content}"\n  Condition: ${n.surfaceCondition}`)
        .join("\n");

    const evaluationPrompt = `You are evaluating smart note conditions for the magic-context system.

For each note below, determine whether its surface condition has been met.
You have access to tools like GitHub CLI (gh), web search, and the local codebase to verify conditions.

You DO NOT have access to:
- Any conversation between the user and the original agent that wrote the note
- The state of any active session, including whether messages have been sent
- The current task, mood, or intent of the human user

If a condition references conversation context the user is having ("When the user mentions X", "When they ask to do Y", "When we revisit Z", "When relevant to current discussion", etc.), it is UNEVALUATABLE — skip it (do not include in results) so the note stays pending. These are misuse cases that should never have been written as smart notes; leaving them pending is the correct outcome, the dreamer's archive-stale task will eventually retire them.

## Pending Smart Notes

${noteDescriptions}

## Instructions

1. Check each condition using the tools available to you.
2. Be conservative — only mark a condition as met when you have clear evidence.
3. Skip conditions that depend on session/conversation context you cannot observe — do not invent a "false" verdict for them, just omit them from your response.
4. Respond with a JSON array of results:

\`\`\`json
[
  { "id": <note_id>, "met": true/false, "reason": "brief explanation" }
]
\`\`\`

Only include notes whose conditions you could definitively evaluate against external signals. Skip notes where you cannot determine the status (they will be re-evaluated next run, or eventually archived as stale).`;

    const taskStartedAt = Date.now();
    let agentSessionId: string | null = null;
    let phaseFailed = false;
    let invocationRecorded = false;
    const recordInvocation = (params: {
        status: "completed" | "failed" | "aborted";
        messages?: unknown[];
        error?: unknown;
    }) => {
        if (!args.parentSessionId || invocationRecorded) return;
        invocationRecorded = true;
        recordChildInvocation({
            db: args.db,
            parentSessionId: args.parentSessionId,
            harness: "opencode",
            subagent: "dreamer",
            // Canonical v2 task name — MUST match the dream_runs row name
            // (config.task) so the dashboard's task GROUP BY join lines up.
            task: "evaluate-smart-notes",
            startedAt: taskStartedAt,
            status: params.status,
            messages: params.messages,
            error: params.error,
        });
    };
    const abortController = new AbortController();
    const leaseInterval = setInterval(() => {
        try {
            if (!renewLease(args.db, args.holderId, args.leaseKey)) {
                log("[dreamer] smart notes: lease renewal failed — aborting");
                args.onLeaseLost?.("smart notes");
                abortController.abort();
            }
        } catch (error) {
            args.onLeaseLost?.("smart notes", error);
            abortController.abort();
        }
    }, 60_000);

    try {
        const createResponse = await args.client.session.create({
            body: {
                ...(args.parentSessionId ? { parentID: args.parentSessionId } : {}),
                title: "magic-context-dream-smart-notes",
            },
            query: { directory: args.sessionDirectory ?? args.projectIdentity },
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            {
                preferResponseOnMissingData: true,
            },
        );
        agentSessionId = typeof created?.id === "string" ? created.id : null;
        if (!agentSessionId) {
            const error = new Error("Could not create smart note evaluation session.");
            recordInvocation({ status: "failed", error });
            throw error;
        }

        log(`[dreamer] smart notes: child session created ${agentSessionId}`);
        const childSessionId = agentSessionId;

        const remainingMs = Math.max(0, args.deadline - Date.now());
        const smartNoteRun = await shared.promptSyncWithValidatedOutputRetry(
            args.client,
            {
                path: { id: childSessionId },
                query: { directory: args.sessionDirectory ?? args.projectIdentity },
                body: {
                    agent: DREAMER_AGENT,
                    system: DREAMER_SYSTEM_PROMPT,
                    ...modelBodyField(args.model),
                    parts: [{ type: "text", text: evaluationPrompt, synthetic: true }],
                },
            },
            {
                // The executor owns the per-task deadline; honor the remaining
                // budget rather than silently re-capping at 5 minutes (Oracle P1).
                timeoutMs: remainingMs,
                signal: abortController.signal,
                fallbackModels: args.fallbackModels,
                callContext: "dreamer:smart-notes",
                fetchOutput: async () => {
                    const messagesResponse = await args.client.session.messages({
                        path: { id: childSessionId },
                        query: {
                            directory: args.sessionDirectory ?? args.projectIdentity,
                            limit: 50,
                        },
                    });
                    return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                        preferResponseOnMissingData: true,
                    });
                },
                validateOutput: (messages) => {
                    const output = extractLatestAssistantText(messages);
                    if (!output) throw new Error("Smart note evaluation returned no output.");
                    const jsonMatch = output.match(/\[[\s\S]*\]/);
                    if (!jsonMatch) {
                        throw new Error("Smart note evaluation returned no JSON array.");
                    }
                    try {
                        return JSON.parse(jsonMatch[0]) as Array<{
                            id: number;
                            met: boolean;
                            reason?: string;
                        }>;
                    } catch {
                        throw new Error("Smart note evaluation returned invalid JSON.");
                    }
                },
            },
        );

        recordInvocation({ status: "completed", messages: smartNoteRun.output });
        const evaluations = smartNoteRun.validated;
        let surfaced = 0;
        // Lease-held-before-commit: a slow model may have outlived our lease and
        // another holder taken over. Verify under BEGIN IMMEDIATE before writing
        // note state, and throw (not silently skip) on loss so the executor
        // records failed and next_due_at is not advanced past unprocessed notes.
        let leaseLostAtCommit = false;
        args.db.transaction(() => {
            if (!peekLeaseHolderAndExpiry(args.db, args.holderId, args.leaseKey)) {
                log(`[dreamer] smart notes: commit aborted — lease lost (holder ${args.holderId})`);
                leaseLostAtCommit = true;
                return;
            }
            for (const evaluation of evaluations) {
                if (typeof evaluation.id !== "number") continue;
                const note = pendingNotes.find((n) => n.id === evaluation.id);
                if (!note) continue;
                if (evaluation.met) {
                    markNoteReady(args.db, note.id, evaluation.reason);
                    surfaced++;
                    log(
                        `[dreamer] smart notes: #${note.id} condition MET — "${evaluation.reason ?? "condition satisfied"}"`,
                    );
                } else {
                    markNoteChecked(args.db, note.id);
                }
            }
            for (const note of pendingNotes) {
                if (!evaluations.some((e) => e.id === note.id)) {
                    markNoteChecked(args.db, note.id);
                }
            }
        })();

        if (leaseLostAtCommit) {
            throw new Error("Dream lease lost during smart-notes commit");
        }

        const durationMs = Date.now() - taskStartedAt;
        const pending = Math.max(0, pendingNotes.length - surfaced);
        log(
            `[dreamer] smart notes: evaluated ${pendingNotes.length} notes in ${(durationMs / 1000).toFixed(1)}s — ${surfaced} surfaced, ${pending} still pending`,
        );
        return { surfaced, pending, ran: true };
    } catch (error) {
        phaseFailed = true;
        if (
            error instanceof Error &&
            error.message === "Smart note evaluation returned no JSON array."
        ) {
            log("[dreamer] smart notes: no JSON array found in output, skipping");
            for (const note of pendingNotes) markNoteChecked(args.db, note.id);
        } else if (
            error instanceof Error &&
            error.message === "Smart note evaluation returned invalid JSON."
        ) {
            log("[dreamer] smart notes: failed to parse JSON from LLM output, marking all checked");
            for (const note of pendingNotes) markNoteChecked(args.db, note.id);
        }
        recordInvocation({ status: "failed", error });
        throw error;
    } finally {
        clearInterval(leaseInterval);
        if (agentSessionId && !phaseFailed && !shouldKeepSubagents()) {
            await args.client.session.delete({ path: { id: agentSessionId } }).catch(() => {});
        }
    }
}
