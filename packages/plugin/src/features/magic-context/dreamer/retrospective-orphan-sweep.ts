import type { PluginContext } from "../../../plugin/types";
import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";

type OpencodeClient = PluginContext["client"];

/**
 * Privacy backstop for the retrospective task.
 *
 * The retrospective child session embeds raw cross-session user text in its
 * prompt. The task always deletes it in a `finally`, but a hard SIGKILL/OOM
 * BETWEEN session-create and that delete would leave the child (with raw user
 * text) on disk. This sweep removes such crash-orphaned children.
 *
 * CONCURRENCY: `session.delete` has no cross-process "active session" lease (OC
 * peer confirmed), so the ONLY safe filter is AGE — a child older than any
 * legitimate run cannot belong to a live run on another OpenCode process.
 * OpenCode sets `title` + `time_created` immediately at create (not lazily), so
 * the age gate is airtight. 404 on delete = already-swept = success.
 */
export const RETROSPECTIVE_CHILD_TITLE = "magic-context-dream-retrospective";
export const USER_MEMORIES_CHILD_TITLE = "magic-context-dream-user-memories";
const PRIVACY_SENSITIVE_CHILD_TITLES = [
    RETROSPECTIVE_CHILD_TITLE,
    USER_MEMORIES_CHILD_TITLE,
] as const;

/** Stale threshold from the task timeout: max(60min, timeout×3) — comfortably
 *  past any enforced run so a live child is never swept. */
export function retrospectiveOrphanStaleMs(taskTimeoutMinutes: number | undefined): number {
    const timeoutMs = Math.max(1, taskTimeoutMinutes ?? 20) * 60_000;
    return Math.max(60 * 60_000, timeoutMs * 3);
}

interface OrphanRow {
    id: string;
    time_created: number;
}

/**
 * Delete crash-orphaned privacy-sensitive dreamer children for THIS project
 * directory when they are older than `staleMs`. Best-effort + fail-open: any
 * DB/schema/API error is logged and skipped (never throws into the caller's
 * sweep). Returns the count deleted.
 */
export async function sweepOrphanedRetrospectiveChildren(args: {
    opencodeDb: Database | null;
    client: OpencodeClient;
    sessionDirectory: string;
    staleMs: number;
    now?: number;
}): Promise<number> {
    const { opencodeDb, client, sessionDirectory, staleMs } = args;
    if (!opencodeDb) return 0;
    const now = args.now ?? Date.now();
    const cutoff = now - staleMs;

    let rows: OrphanRow[];
    try {
        rows = opencodeDb
            .prepare<[string, string, string, number], OrphanRow>(
                `SELECT id, time_created
                   FROM session
                  WHERE title IN (${PRIVACY_SENSITIVE_CHILD_TITLES.map(() => "?").join(", ")})
                    AND directory = ?
                    AND time_created < ?
                  ORDER BY time_created ASC
                  LIMIT 200`,
            )
            .all(...PRIVACY_SENSITIVE_CHILD_TITLES, sessionDirectory, cutoff);
    } catch (error) {
        // `session` table absent / schema drift / locked → skip silently.
        log(`[dreamer] retrospective orphan sweep: read skipped (${String(error)})`);
        return 0;
    }
    if (rows.length === 0) return 0;

    let deleted = 0;
    for (const row of rows) {
        try {
            await client.session.delete({ path: { id: row.id } });
            deleted += 1;
        } catch {
            // 404 / already removed by another sweeper / transient → treat as done.
            deleted += 1;
        }
    }
    if (deleted > 0) {
        log(`[dreamer] swept ${deleted} crash-orphaned privacy-sensitive child session(s)`);
    }
    return deleted;
}
