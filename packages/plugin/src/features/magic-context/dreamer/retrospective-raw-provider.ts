import { resolve } from "node:path";

import { cleanUserText } from "../../../hooks/magic-context/read-session-chunk";
import { hasMeaningfulUserText } from "../../../hooks/magic-context/read-session-formatting";
import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { openOpenCodeDb } from "./open-opencode-db";

export const RETROSPECTIVE_MAX_MESSAGES_PER_SESSION = 80;
export const RETROSPECTIVE_MAX_MESSAGES_PER_RUN = 240;
// Cap the number of (newest-first) sessions scanned per run. The first run
// (watermark=0) would otherwise fan out over the project's entire session
// history; this bounds the scan/IO regardless of how many sessions exist.
export const RETROSPECTIVE_MAX_SESSIONS_PER_RUN = 20;

export type RetrospectiveMessageRole = "user" | "assistant" | "tool";

export interface RetrospectiveProjectSession {
    sessionId: string;
    path?: string;
    updatedAt?: number;
}

export interface RetrospectiveRawMessage {
    sessionId: string;
    ordinal: number;
    role: RetrospectiveMessageRole;
    text: string;
    toolName?: string;
    isError?: boolean;
    ts: number;
}

export interface RetrospectiveRawProvider {
    listProjectSessions(
        projectIdentity: string,
    ): RetrospectiveProjectSession[] | Promise<RetrospectiveProjectSession[]>;
    readUserMessagesSince(
        sessionId: string,
        sinceMs: number,
        capPerSession: number,
    ): RetrospectiveRawMessage[] | Promise<RetrospectiveRawMessage[]>;
    /** The ~`count` most recent typed USER messages at or before `beforeMs` — the
     *  run-boundary overlap so friction spanning two runs isn't missed. */
    readUserMessagesBefore(
        sessionId: string,
        beforeMs: number,
        count: number,
    ): RetrospectiveRawMessage[] | Promise<RetrospectiveRawMessage[]>;
    /** Release any reused resources (e.g. a pooled DB handle) after a run. */
    dispose?(): void;
}

interface OpenCodeRetrospectiveRawProviderDeps {
    contextDb: Database;
    openOpenCodeDb?: () => Database | null;
    /** Test-only shortcut: when provided, this connection is not closed by the provider. */
    opencodeDb?: Database;
}

interface SessionProjectRow {
    session_id: string;
    updated_at?: number | null;
}

interface OpenCodeMessageRow {
    id: string;
    data: string;
    time_created: number;
}

interface OpenCodePartRow {
    message_id: string;
    data: string;
}

export class OpenCodeRetrospectiveRawProvider implements RetrospectiveRawProvider {
    private readonly openDb: () => Database | null;
    // One read-only opencode.db handle reused across the run's per-session reads
    // (opened lazily on the first read, closed via dispose()). Avoids opening +
    // closing the DB once per session, which on a large project meant many
    // open/close cycles per scheduled run.
    private sharedDb: Database | null = null;
    private sharedDbOpened = false;

    constructor(private readonly deps: OpenCodeRetrospectiveRawProviderDeps) {
        this.openDb = deps.openOpenCodeDb ?? openOpenCodeDb;
    }

    listProjectSessions(projectIdentity: string): RetrospectiveProjectSession[] {
        // ROOT sessions only. The retrospective learns from USER friction, but a
        // subagent child (oracle / mason / historian / dreamer) has no user — its
        // "user messages" are agent-authored task prompts whose audit/spec wording
        // ("fail", "error", "wrong", "no padding") trips the frustration regex and
        // whose tool fan-out trips repeated-tool-call. In a delegation-heavy period
        // children also outnumber roots ~30:1, so the newest-first session cap is
        // entirely consumed by them and the real user session is never scanned.
        // is_subagent lives in session_meta (same DB); missing meta → treat as root.
        const rows = this.deps.contextDb
            .prepare<[string, number], SessionProjectRow>(
                `SELECT sp.session_id, sp.updated_at
                   FROM session_projects sp
                   LEFT JOIN session_meta m ON m.session_id = sp.session_id
                  WHERE sp.project_path = ? AND sp.harness = 'opencode'
                    AND COALESCE(m.is_subagent, 0) = 0
                  ORDER BY sp.updated_at DESC, sp.session_id DESC
                  LIMIT ?`,
            )
            .all(projectIdentity, RETROSPECTIVE_MAX_SESSIONS_PER_RUN);
        return rows.map((row) => ({
            sessionId: row.session_id,
            updatedAt: typeof row.updated_at === "number" ? row.updated_at : undefined,
        }));
    }

    private resolveDb(): Database | null {
        if (this.deps.opencodeDb) return this.deps.opencodeDb;
        if (!this.sharedDbOpened) {
            this.sharedDbOpened = true;
            this.sharedDb = this.openDb();
        }
        return this.sharedDb;
    }

    readUserMessagesSince(
        sessionId: string,
        sinceMs: number,
        capPerSession: number,
    ): RetrospectiveRawMessage[] {
        const db = this.resolveDb();
        if (!db) return [];
        try {
            return readOpenCodeMessagesSince(db, sessionId, sinceMs, capPerSession);
        } catch {
            return [];
        }
    }

    readUserMessagesBefore(
        sessionId: string,
        beforeMs: number,
        count: number,
    ): RetrospectiveRawMessage[] {
        const db = this.resolveDb();
        if (!db) return [];
        try {
            return readOpenCodeUserMessagesBefore(db, sessionId, beforeMs, count);
        } catch {
            return [];
        }
    }

    /** Close the reused read-only handle. Safe to call multiple times. */
    dispose(): void {
        if (this.sharedDb && !this.deps.opencodeDb) {
            closeQuietly(this.sharedDb);
        }
        this.sharedDb = null;
        this.sharedDbOpened = false;
    }
}

export async function readProjectRetrospectiveMessages(
    provider: RetrospectiveRawProvider,
    projectIdentity: string,
    sinceMs: number,
    options?: {
        maxMessagesPerRun?: number;
        capPerSession?: number;
        maxSessionsPerRun?: number;
    },
): Promise<RetrospectiveRawMessage[]> {
    const maxMessages = options?.maxMessagesPerRun ?? RETROSPECTIVE_MAX_MESSAGES_PER_RUN;
    const capPerSession = options?.capPerSession ?? RETROSPECTIVE_MAX_MESSAGES_PER_SESSION;
    const maxSessions = options?.maxSessionsPerRun ?? RETROSPECTIVE_MAX_SESSIONS_PER_RUN;
    try {
        // Cap the session count HERE (newest-first) so EVERY provider is bounded,
        // not just the OpenCode one — a provider that lists every project session
        // (e.g. Pi's JSONL enumeration) must not fan out unbounded reads.
        const sessions = (await provider.listProjectSessions(projectIdentity)).slice(
            0,
            maxSessions,
        );
        const batches = await Promise.all(
            sessions.map((session) =>
                provider.readUserMessagesSince(session.sessionId, sinceMs, capPerSession),
            ),
        );
        return batches
            .flat()
            .sort((a, b) => b.ts - a.ts || b.ordinal - a.ordinal)
            .slice(0, maxMessages)
            .sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal);
    } finally {
        // Release the provider's reused DB handle (OpenCode) after the run's reads.
        provider.dispose?.();
    }
}

export interface RetrospectiveScanWindow {
    /** All scanned messages (user rows + tool metadata), oldest→newest, ordinals
     *  reassigned globally. Includes the pre-watermark overlap (user-only). */
    messages: RetrospectiveRawMessage[];
    /** The max message ts ACTUALLY scanned this run (the content watermark to
     *  persist on completion). Never less than `watermarkMs` (overlap rows are
     *  ≤ watermark and cannot pull it back). */
    maxScannedTs: number;
}

/**
 * The retrospective scan window for one run: everything new since the content
 * watermark, PLUS the ~`overlapUserCount` user lines immediately before the
 * watermark per session (so friction straddling a run boundary isn't missed).
 * The since portion carries user rows + tool metadata (the deepen context); the
 * overlap portion is user-only (gate context). Ordinals are reassigned globally.
 */
export async function readRetrospectiveScanWindow(
    provider: RetrospectiveRawProvider,
    projectIdentity: string,
    watermarkMs: number,
    overlapUserCount: number,
    options?: {
        maxMessagesPerRun?: number;
        capPerSession?: number;
        maxSessionsPerRun?: number;
    },
): Promise<RetrospectiveScanWindow> {
    const maxMessages = options?.maxMessagesPerRun ?? RETROSPECTIVE_MAX_MESSAGES_PER_RUN;
    const capPerSession = options?.capPerSession ?? RETROSPECTIVE_MAX_MESSAGES_PER_SESSION;
    const maxSessions = options?.maxSessionsPerRun ?? RETROSPECTIVE_MAX_SESSIONS_PER_RUN;
    try {
        const sessions = (await provider.listProjectSessions(projectIdentity)).slice(
            0,
            maxSessions,
        );
        const sinceBatches = await Promise.all(
            sessions.map((session) =>
                provider.readUserMessagesSince(session.sessionId, watermarkMs, capPerSession),
            ),
        );
        const overlapBatches =
            overlapUserCount > 0 && watermarkMs > 0
                ? await Promise.all(
                      sessions.map((session) =>
                          provider.readUserMessagesBefore(
                              session.sessionId,
                              watermarkMs,
                              overlapUserCount,
                          ),
                      ),
                  )
                : [];

        // maxScannedTs is computed ONLY over the since portion — overlap rows are
        // ≤ watermark by construction and must never advance the watermark.
        let maxScannedTs = watermarkMs;
        for (const row of sinceBatches.flat()) {
            if (row.ts > maxScannedTs) maxScannedTs = row.ts;
        }

        // Merge, dedupe by stable identity (sessionId + ts + role + toolName) so an
        // overlap row that also appears in the since read isn't double-counted.
        const seen = new Set<string>();
        const merged: RetrospectiveRawMessage[] = [];
        for (const row of [...sinceBatches.flat(), ...overlapBatches.flat()]) {
            const key = `${row.sessionId}\u0000${row.ts}\u0000${row.role}\u0000${row.toolName ?? ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(row);
        }
        merged.sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal);
        const capped = merged
            .sort((a, b) => b.ts - a.ts || b.ordinal - a.ordinal)
            .slice(0, maxMessages)
            .sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal);
        return { messages: capped, maxScannedTs };
    } finally {
        provider.dispose?.();
    }
}

function readOpenCodeMessagesSince(
    db: Database,
    sessionId: string,
    sinceMs: number,
    capPerSession: number,
): RetrospectiveRawMessage[] {
    const limit = Math.max(1, Math.floor(capPerSession));
    const rows = db
        .prepare<[string, number, number], OpenCodeMessageRow>(
            `SELECT id, data, time_created
               FROM message
              WHERE session_id = ? AND time_created > ?
              ORDER BY time_created DESC, id DESC
              LIMIT ?`,
        )
        .all(sessionId, sinceMs, limit)
        .reverse();
    return normalizeOpenCodeRows(db, sessionId, rows);
}

/**
 * The ~N most recent typed USER messages at or before `beforeMs` (the run
 * overlap). Lets the next run re-see friction that straddles the watermark
 * boundary. Over-reads a window of mixed rows (user/assistant/tool) then keeps
 * the newest `count` USER rows. Returns user-only — it feeds the gate's U-line
 * overlap, nothing else.
 */
function readOpenCodeUserMessagesBefore(
    db: Database,
    sessionId: string,
    beforeMs: number,
    count: number,
): RetrospectiveRawMessage[] {
    const want = Math.max(1, Math.floor(count));
    const window = Math.max(want * 5, 32);
    const rows = db
        .prepare<[string, number, number], OpenCodeMessageRow>(
            `SELECT id, data, time_created
               FROM message
              WHERE session_id = ? AND time_created <= ?
              ORDER BY time_created DESC, id DESC
              LIMIT ?`,
        )
        .all(sessionId, beforeMs, window)
        .reverse();
    const userRows = normalizeOpenCodeRows(db, sessionId, rows).filter((r) => r.role === "user");
    return userRows.slice(-want);
}

function normalizeOpenCodeRows(
    db: Database,
    sessionId: string,
    rows: OpenCodeMessageRow[],
): RetrospectiveRawMessage[] {
    if (rows.length === 0) return [];

    // Restrict the part read to the capped message ids we actually kept, rather
    // than every part in the session — a long session has far more parts than
    // the newest-`capPerSession` messages we render.
    const messageIds = rows.map((row) => row.id);
    const placeholders = messageIds.map(() => "?").join(", ");
    const partRows = db
        .prepare<string[], OpenCodePartRow>(
            `SELECT message_id, data
               FROM part
              WHERE session_id = ? AND message_id IN (${placeholders})
              ORDER BY time_created ASC, id ASC`,
        )
        .all(sessionId, ...messageIds);
    const partsByMessageId = new Map<string, unknown[]>();
    for (const row of partRows) {
        const parts = partsByMessageId.get(row.message_id) ?? [];
        const parsed = parseJson(row.data);
        if (parsed !== null) parts.push(parsed);
        partsByMessageId.set(row.message_id, parts);
    }

    return rows.flatMap((row, index) => {
        const messageData = parseJsonRecord(row.data);
        if (!messageData) return [];
        if (messageData.summary === true && messageData.finish === "stop") return [];
        const role = typeof messageData.role === "string" ? messageData.role : "unknown";
        const parts = partsByMessageId.get(row.id) ?? [];
        const ordinal = index + 1;
        return normalizeOpenCodeMessage({
            sessionId,
            ordinal,
            role,
            parts,
            ts: row.time_created,
        });
    });
}

function normalizeOpenCodeMessage(args: {
    sessionId: string;
    ordinal: number;
    role: string;
    parts: unknown[];
    ts: number;
}): RetrospectiveRawMessage[] {
    const rows: RetrospectiveRawMessage[] = [];
    // PRIVACY: retrospective reads OTHER sessions' raw history. Only genuine
    // typed USER text may carry its content into the friction window — that is
    // the friction the user expressed. Assistant text and raw tool OUTPUT can
    // contain file contents / secrets / paths from prior sessions, so we never
    // emit them. Tool rows carry metadata ONLY (name + error flag), which is all
    // the friction detectors need (repeated-call / error-burst); their `text`
    // stays empty so no raw output can reach the prompt. (Pi already returns
    // user-only — this keeps the two providers aligned.)
    if (args.role === "user") {
        const text = extractGenuineUserText(args.parts);
        if (text) {
            rows.push({
                sessionId: args.sessionId,
                ordinal: args.ordinal,
                role: "user",
                text,
                ts: args.ts,
            });
        }
    }

    for (const tool of extractToolRows(args.parts)) {
        rows.push({
            sessionId: args.sessionId,
            ordinal: args.ordinal,
            role: "tool",
            text: "",
            toolName: tool.toolName,
            isError: tool.isError,
            ts: args.ts,
        });
    }

    return rows;
}

function extractGenuineUserText(parts: unknown[]): string {
    const nonSyntheticParts = parts.filter((part) => {
        if (part === null || typeof part !== "object" || Array.isArray(part)) return true;
        const record = part as Record<string, unknown>;
        return record.synthetic !== true;
    });
    if (!hasMeaningfulUserText(nonSyntheticParts)) return "";
    return extractPlainText(nonSyntheticParts)
        .map((text) => cleanUserText(text))
        .filter((text) => text.length > 0)
        .join("\n")
        .trim();
}

function extractPlainText(parts: unknown[]): string[] {
    const texts: string[] = [];
    for (const part of parts) {
        if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
        const record = part as Record<string, unknown>;
        if (record.type !== "text") continue;
        if (record.ignored === true || record.synthetic === true) continue;
        if (typeof record.text === "string" && record.text.trim().length > 0) {
            texts.push(record.text.trim());
        }
    }
    return texts;
}

function extractToolRows(parts: unknown[]): Array<{
    toolName: string;
    text: string;
    isError: boolean;
}> {
    const rows: Array<{ toolName: string; text: string; isError: boolean }> = [];
    for (const part of parts) {
        if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
        const record = part as Record<string, unknown>;
        if (record.type !== "tool" || typeof record.tool !== "string") continue;
        const state = record.state;
        const stateRecord =
            state && typeof state === "object" ? (state as Record<string, unknown>) : {};
        const output = stringifyToolOutput(stateRecord.output);
        const errorText = stringifyToolOutput(stateRecord.error);
        const status = typeof stateRecord.status === "string" ? stateRecord.status : "";
        const isError =
            stateRecord.isError === true ||
            status.toLowerCase() === "error" ||
            errorText.length > 0 ||
            /\b(error|failed|exception|traceback)\b/i.test(output);
        rows.push({
            toolName: record.tool,
            text: output || errorText || `tool ${record.tool}`,
            isError,
        });
    }
    return rows;
}

function stringifyToolOutput(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (value === null || value === undefined) return "";
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function parseJson(value: string): unknown | null {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
    const parsed = parseJson(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
}

export function sameResolvedPath(a: string, b: string): boolean {
    return resolve(a) === resolve(b);
}
