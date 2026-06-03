import { getHarness } from "../../shared/harness";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import {
    adoptNullOwnerToolTag,
    getMaxTagNumberBySession,
    getNullOwnerToolTag,
    getTagNumberByMessageId,
    getToolTagNumberByOwner,
    insertTag,
} from "./storage-tags";
import type { TagEntry } from "./types";

/**
 * Composite key separator for tool tags in the in-memory assignments map.
 * `\x00` (NUL) cannot appear in a callId or message id (both are
 * UUID-shaped or finite character sets) so concatenation is unambiguous.
 *
 * v3.3.1 Layer C: tool tags carry a composite identity of
 * `(sessionId, callId, ownerMsgId)`. The bare callId is no longer a
 * unique key — two assistant turns reusing the same callId (collision
 * pattern observed in real OC sessions) must produce distinct tags.
 *
 * Message and file tags continue to use bare `messageId` keys (no
 * collision risk; `messageId` is `${msgId}:p${ord}` or `${msgId}:fileN`
 * which is globally unique within a session).
 */
const TOOL_COMPOSITE_KEY_SEP = "\x00";

export function makeToolCompositeKey(ownerMsgId: string, callId: string): string {
    return `${ownerMsgId}${TOOL_COMPOSITE_KEY_SEP}${callId}`;
}

/**
 * Narrowed type for non-tool tag operations. The compile-time exclusion
 * of `"tool"` here is the v3.3.1 Layer C contract: every tool path MUST
 * use `assignToolTag`/`getToolTag` so composite identity propagates.
 *
 * Any caller passing `"tool"` to `assignTag` or `getTag` triggers a TS
 * compile error at the call site. Defense-in-depth: the runtime body
 * also throws if it ever sees a "tool" type at runtime (caught by
 * `as any` casts in legacy code).
 */
type NonToolTagType = Exclude<TagEntry["type"], "tool">;

export interface Tagger {
    /**
     * Assign a tag for a non-tool entity (message text or file part).
     *
     * Tool tags MUST use {@link assignToolTag}; the `type` parameter
     * here is narrowed at compile time to forbid `"tool"`.
     */
    assignTag(
        sessionId: string,
        messageId: string,
        type: NonToolTagType,
        byteSize: number,
        db: Database,
        reasoningByteSize?: number,
        toolName?: string | null,
        inputByteSize?: number,
        /**
         * Pi-only: fingerprint of the raw message this tag is created for,
         * persisted on the tag row so a later pass can adopt a fallback-id tag
         * onto the real SessionEntry id. OpenCode passes undefined → column
         * stays NULL → no behavior change.
         */
        entryFingerprint?: string | null,
    ): number;
    /**
     * Look up the tag number for a non-tool entity.
     *
     * The `type` parameter is required (and narrowed to non-tool) so a
     * future tool-tag lookup can't accidentally fall through here. Use
     * {@link getToolTag} for tool lookups.
     */
    getTag(sessionId: string, messageId: string, type: NonToolTagType): number | undefined;
    /**
     * Assign a tag for a tool invocation. Composite identity
     * `(sessionId, callId, ownerMsgId)` is mandatory — pre-v3.3.1 the
     * tagger keyed tool tags by bare callId, and two assistant turns
     * reusing the same callId would silently bind to the same tag,
     * inheriting the older tag's drop status.
     *
     * `ownerMsgId` is the assistant message id that hosts the tool
     * invocation. For Pi parallel-tool-calls without `part.id`, callers
     * pass a synthetic locator equal to the contentId (owner == callId)
     * to satisfy the contract while preserving the legacy "each part
     * gets its own tag" behavior.
     */
    assignToolTag(
        sessionId: string,
        callId: string,
        ownerMsgId: string,
        byteSize: number,
        db: Database,
        reasoningByteSize?: number,
        toolName?: string | null,
        inputByteSize?: number,
    ): number;
    /**
     * Look up the tag number for a tool invocation by composite
     * identity.
     */
    getToolTag(sessionId: string, callId: string, ownerMsgId: string): number | undefined;
    bindTag(sessionId: string, messageId: string, tagNumber: number): void;
    /**
     * Remove a stale in-memory assignment key. Used by Pi fallback-tag
     * adoption after a tag's message_id is migrated from the pi-msg-*
     * fallback to the real id: the old fallback key must be dropped so it
     * doesn't linger as an alias to the same tag number.
     */
    unbindTag(sessionId: string, messageId: string): void;
    /**
     * Bind a tool tag by composite key. The in-memory map keys this as
     * `${ownerMsgId}\x00${callId}`.
     */
    bindToolTag(sessionId: string, callId: string, ownerMsgId: string, tagNumber: number): void;
    getAssignments(sessionId: string): ReadonlyMap<string, number>;
    resetCounter(sessionId: string, db: Database): void;
    getCounter(sessionId: string): number;
    initFromDb(sessionId: string, db: Database): void;
    cleanup(sessionId: string): void;
}

const GET_COUNTER_SQL = `SELECT counter FROM session_meta WHERE session_id = ?`;
// Layer C: pull tool_owner_message_id and type so we can compose the
// in-memory key correctly. NULL-owner tool rows are intentionally NOT
// placed in the in-memory map; the lazy-adoption DB path discovers them
// at the next lookup.
const GET_ASSIGNMENTS_SQL =
    "SELECT message_id, tag_number, type, tool_owner_message_id FROM tags WHERE session_id = ? ORDER BY tag_number ASC";

/**
 * Two SQLite primitives form the change-detection signal for the
 * `initFromDb` cache:
 *
 *   - `PRAGMA main.data_version` — bumps when ANOTHER connection commits
 *     to this DB. Does NOT bump for writes on the current connection.
 *   - `SELECT total_changes()` — bumps when THIS connection commits any
 *     INSERT/UPDATE/DELETE (including inside transactions). Does NOT
 *     reflect writes made by other connections.
 *
 * Together they cover every write path that could invalidate our in-memory
 * tagger state. Read-only queries bump neither, so a defer pass that only
 * reads sees a clean cache hit.
 *
 * Both probes are <0.005ms vs ~15ms for the full assignments scan on a
 * 49k-tag session, so cache hits are effectively free.
 */
const PROBE_DATA_VERSION_SQL = "PRAGMA main.data_version";
const PROBE_TOTAL_CHANGES_SQL = "SELECT total_changes() AS tc";

const probeDataVersionStatements = new WeakMap<Database, PreparedStatement>();
const probeTotalChangesStatements = new WeakMap<Database, PreparedStatement>();

function getProbeDataVersionStatement(db: Database): PreparedStatement {
    let stmt = probeDataVersionStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(PROBE_DATA_VERSION_SQL);
        probeDataVersionStatements.set(db, stmt);
    }
    return stmt;
}

function getProbeTotalChangesStatement(db: Database): PreparedStatement {
    let stmt = probeTotalChangesStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(PROBE_TOTAL_CHANGES_SQL);
        probeTotalChangesStatements.set(db, stmt);
    }
    return stmt;
}

interface AssignmentRow {
    message_id: string;
    tag_number: number;
    type: TagEntry["type"];
    tool_owner_message_id: string | null;
}

/**
 * Per-session signature recorded at the last successful `initFromDb` reload.
 * Keyed by sessionId; tied to a specific `Database` object so we never
 * cache-hit across different connections (e.g. test fixtures, dashboard
 * hot reload, harness swap).
 */
interface LoadSignature {
    db: Database;
    dataVersion: number;
    totalChanges: number;
}

function isAssignmentRow(row: unknown): row is AssignmentRow {
    if (row === null || typeof row !== "object") {
        return false;
    }

    const candidate = row as Record<string, unknown>;
    if (typeof candidate.message_id !== "string") return false;
    if (typeof candidate.tag_number !== "number") return false;
    if (candidate.type !== "message" && candidate.type !== "tool" && candidate.type !== "file")
        return false;
    if (
        candidate.tool_owner_message_id !== null &&
        typeof candidate.tool_owner_message_id !== "string"
    )
        return false;
    return true;
}

/**
 * Counter upsert is monotonic: ON CONFLICT we keep MAX(existing, new) so
 * concurrent writers (or a stale process catching up) cannot accidentally
 * roll the counter backwards. Combined with the DB-authoritative allocation
 * in assignTag(), this prevents a stale in-memory counter from re-issuing
 * tag numbers that another writer already claimed.
 *
 * `harness` is written on first INSERT only. On conflict we don't update it —
 * a session is created by exactly one harness (OpenCode or Pi) and that origin
 * doesn't change for the lifetime of the row.
 */
const UPSERT_COUNTER_SQL = `
  INSERT INTO session_meta (session_id, counter, harness)
  VALUES (?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET counter = MAX(session_meta.counter, excluded.counter)
`;

const upsertCounterStatements = new WeakMap<Database, PreparedStatement>();

function getUpsertCounterStatement(db: Database): PreparedStatement {
    let stmt = upsertCounterStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(UPSERT_COUNTER_SQL);
        upsertCounterStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Force-reset to 0. Distinct from the monotonic upsert above because callers
 * like /ctx-recomp need to roll the counter back to rebuild a session from
 * scratch. Includes harness on first INSERT for the same reason as the
 * monotonic upsert.
 */
const RESET_COUNTER_SQL = `
  INSERT INTO session_meta (session_id, counter, harness)
  VALUES (?, 0, ?)
  ON CONFLICT(session_id) DO UPDATE SET counter = 0
`;

const resetCounterStatements = new WeakMap<Database, PreparedStatement>();

function getResetCounterStatement(db: Database): PreparedStatement {
    let stmt = resetCounterStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(RESET_COUNTER_SQL);
        resetCounterStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Maximum retries when a tag_number INSERT collides with an existing row
 * for a different message_id (i.e. our counter is behind the DB max). Each
 * retry re-reads the DB max and tries the next slot. In practice 1-2 retries
 * are enough; the cap protects against pathological state divergence.
 */
const MAX_TAG_ALLOC_RETRIES = 5;

export function createTagger(): Tagger {
    // per-session monotonic counter
    const counters = new Map<string, number>();
    // per-session tag assignments: messageId → tag number
    const assignments = new Map<string, Map<string, number>>();
    // per-session load signatures: tracks the DB state at the last
    // successful initFromDb() reload. A subsequent initFromDb() call can
    // skip the full DB scan when (a) the signature exists for this session,
    // (b) the recorded `db` object is identical to the current one, and
    // (c) both `data_version` and `total_changes` still match. Any
    // mismatch — including a different Database object, an external
    // commit (data_version bump), or any commit on this connection
    // (total_changes bump) — falls through to the full reload.
    //
    // Absence of a signature entry means "first load" (or post-cleanup /
    // post-resetCounter) so the next initFromDb is always a full reload.
    const loadSignatures = new Map<string, LoadSignature>();

    function getSessionAssignments(sessionId: string): Map<string, number> {
        let map = assignments.get(sessionId);
        if (!map) {
            map = new Map();
            assignments.set(sessionId, map);
        }
        return map;
    }

    function isUniqueConstraintError(error: unknown): boolean {
        return (
            error instanceof Error &&
            "code" in error &&
            (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
        );
    }

    /**
     * Persist a counter value at least as large as `value`, both in memory
     * and in the session_meta table. The DB upsert is monotonic (MAX-based)
     * so this never moves the counter backwards, even under concurrent
     * writers from another process touching the same session.
     */
    function syncCounterAtLeast(sessionId: string, db: Database, value: number): void {
        if (value <= 0) return;
        const next = Math.max(counters.get(sessionId) ?? 0, value);
        counters.set(sessionId, next);
        getUpsertCounterStatement(db).run(sessionId, next, getHarness());
    }

    /**
     * Core allocation loop shared by both non-tool and tool tag paths.
     *
     * `mapKey` is the in-memory assignments key (bare messageId for
     * message/file, composite `<owner>\x00<callId>` for tool).
     * `toolOwnerMessageId` is null for non-tool tags and required for
     * tool tags. `dbExistingLookup` returns the persisted tag number
     * for this entity if one already exists (different lookup paths
     * for the bare-key vs composite-key cases).
     */
    function allocateTag(
        sessionId: string,
        messageId: string,
        type: TagEntry["type"],
        byteSize: number,
        db: Database,
        reasoningByteSize: number,
        toolName: string | null,
        inputByteSize: number,
        toolOwnerMessageId: string | null,
        mapKey: string,
        dbExistingLookup: () => number | null,
        entryFingerprint: string | null = null,
    ): number {
        const sessionAssignments = getSessionAssignments(sessionId);

        const existing = sessionAssignments.get(mapKey);
        if (existing !== undefined) {
            return existing;
        }

        // Fast path: this entity already has a row in DB from a previous
        // pass. Bind the existing tag back into memory and bump the counter
        // to at least that value. This handles the case where the in-memory
        // assignments map was lost (cleanup/restart) but the DB still has
        // the row.
        const dbExisting = dbExistingLookup();
        if (dbExisting !== null) {
            sessionAssignments.set(mapKey, dbExisting);
            syncCounterAtLeast(sessionId, db, dbExisting);
            return dbExisting;
        }

        // Allocation loop (see assignTag pre-Layer-C comment for rationale).
        for (let attempt = 0; attempt < MAX_TAG_ALLOC_RETRIES; attempt += 1) {
            const memCounter = counters.get(sessionId) ?? 0;
            const dbMax = getMaxTagNumberBySession(db, sessionId);
            const next = Math.max(memCounter, dbMax) + 1;

            try {
                db.transaction(() => {
                    insertTag(
                        db,
                        sessionId,
                        messageId,
                        type,
                        byteSize,
                        next,
                        reasoningByteSize,
                        toolName,
                        inputByteSize,
                        toolOwnerMessageId,
                        entryFingerprint,
                    );
                    getUpsertCounterStatement(db).run(sessionId, next, getHarness());
                })();
            } catch (error: unknown) {
                if (!isUniqueConstraintError(error)) {
                    throw error;
                }

                // UNIQUE collision. Two possible causes:
                //   (a) Another writer just claimed `next` for a DIFFERENT
                //       entity — recovery: advance counter and retry.
                //   (b) This entity was raced and now has its own row —
                //       recovery: bind the existing tag and return it.
                const racedRow = dbExistingLookup();
                if (racedRow !== null) {
                    sessionAssignments.set(mapKey, racedRow);
                    syncCounterAtLeast(sessionId, db, racedRow);
                    return racedRow;
                }

                const advancedDbMax = getMaxTagNumberBySession(db, sessionId);
                counters.set(sessionId, Math.max(memCounter, advancedDbMax));
                continue;
            }

            counters.set(sessionId, next);
            sessionAssignments.set(mapKey, next);
            return next;
        }

        // Give up after retries — surface the failure so the transform
        // catch can log it and continue with reduced functionality.
        throw new Error(
            `tagger.allocateTag: failed to allocate tag for session=${sessionId} key=${mapKey} after ${MAX_TAG_ALLOC_RETRIES} retries`,
        );
    }

    function assignTag(
        sessionId: string,
        messageId: string,
        type: NonToolTagType,
        byteSize: number,
        db: Database,
        reasoningByteSize: number = 0,
        toolName: string | null = null,
        inputByteSize: number = 0,
        entryFingerprint: string | null = null,
    ): number {
        // Defense-in-depth: TS narrowing already excludes "tool", but a
        // caller routing through `as any` could still hit this body.
        // Throw to surface the misuse loudly.
        if ((type as string) === "tool") {
            throw new Error(
                "tagger.assignTag: type='tool' is forbidden — use assignToolTag(sessionId, callId, ownerMsgId, ...)",
            );
        }
        return allocateTag(
            sessionId,
            messageId,
            type,
            byteSize,
            db,
            reasoningByteSize,
            toolName,
            inputByteSize,
            null,
            messageId,
            () => getTagNumberByMessageId(db, sessionId, messageId),
            entryFingerprint,
        );
    }

    function assignToolTag(
        sessionId: string,
        callId: string,
        ownerMsgId: string,
        byteSize: number,
        db: Database,
        reasoningByteSize: number = 0,
        toolName: string | null = null,
        inputByteSize: number = 0,
    ): number {
        const compositeKey = makeToolCompositeKey(ownerMsgId, callId);
        const sessionAssignments = getSessionAssignments(sessionId);

        // Composite-key fast path
        const existing = sessionAssignments.get(compositeKey);
        if (existing !== undefined) {
            return existing;
        }

        // DB fast path: composite-keyed lookup. If the row already exists
        // for this exact (callId, ownerMsgId), bind and return.
        const dbHit = getToolTagNumberByOwner(db, sessionId, callId, ownerMsgId);
        if (dbHit !== null) {
            sessionAssignments.set(compositeKey, dbHit);
            syncCounterAtLeast(sessionId, db, dbHit);
            return dbHit;
        }

        // Lazy adoption: legacy NULL-owner row exists for this callId and
        // is up for grabs. Try to atomically claim it.
        //
        // Loop: backfill (Layer B) may finish writing an owner between
        // our SELECT and UPDATE. The NULL-guarded UPDATE catches that
        // race; if the UPDATE matches zero rows we re-check the composite
        // fast path (which may now hit) and on miss try the next NULL row.
        // Bounded by MAX_TAG_ALLOC_RETRIES so we never loop unboundedly
        // even under pathological concurrent-writer interleavings.
        for (let attempt = 0; attempt < MAX_TAG_ALLOC_RETRIES; attempt += 1) {
            const orphan = getNullOwnerToolTag(db, sessionId, callId);
            if (orphan === null) break;

            const claimed = adoptNullOwnerToolTag(db, orphan.id, ownerMsgId);
            if (claimed) {
                sessionAssignments.set(compositeKey, orphan.tagNumber);
                syncCounterAtLeast(sessionId, db, orphan.tagNumber);
                return orphan.tagNumber;
            }

            // Race lost: re-check composite fast path before allocating
            // fresh — another writer may have just claimed the same row
            // for the same owner.
            const recheck = getToolTagNumberByOwner(db, sessionId, callId, ownerMsgId);
            if (recheck !== null) {
                sessionAssignments.set(compositeKey, recheck);
                syncCounterAtLeast(sessionId, db, recheck);
                return recheck;
            }
            // Otherwise loop: there may be more NULL-owner rows for this
            // callId (collision deviation: when legacy data has multiple
            // NULL-owner rows for the same callId, partial UNIQUE forced
            // only the lowest tag_number row to be adopted by backfill;
            // remaining rows stay NULL and we get to adopt one here).
        }

        // Fresh allocation
        return allocateTag(
            sessionId,
            callId,
            "tool",
            byteSize,
            db,
            reasoningByteSize,
            toolName,
            inputByteSize,
            ownerMsgId,
            compositeKey,
            () => getToolTagNumberByOwner(db, sessionId, callId, ownerMsgId),
        );
    }

    function getTag(
        sessionId: string,
        messageId: string,
        _type: NonToolTagType,
    ): number | undefined {
        // _type is unused at runtime — the parameter exists for compile-
        // time enforcement of the non-tool contract. Any caller passing
        // "tool" gets a TS error before this body runs.
        return assignments.get(sessionId)?.get(messageId);
    }

    function getToolTag(sessionId: string, callId: string, ownerMsgId: string): number | undefined {
        return assignments.get(sessionId)?.get(makeToolCompositeKey(ownerMsgId, callId));
    }

    function bindTag(sessionId: string, messageId: string, tagNumber: number): void {
        getSessionAssignments(sessionId).set(messageId, tagNumber);
    }

    function unbindTag(sessionId: string, messageId: string): void {
        getSessionAssignments(sessionId).delete(messageId);
    }

    function bindToolTag(
        sessionId: string,
        callId: string,
        ownerMsgId: string,
        tagNumber: number,
    ): void {
        getSessionAssignments(sessionId).set(makeToolCompositeKey(ownerMsgId, callId), tagNumber);
    }

    function getAssignments(sessionId: string): ReadonlyMap<string, number> {
        return getSessionAssignments(sessionId);
    }

    function resetCounter(sessionId: string, db: Database): void {
        // Force-reset uses a non-monotonic UPDATE so callers can rebuild a
        // session from scratch (e.g. /ctx-recomp full rebuild). Bypass the
        // monotonic upsert by using a dedicated statement.
        counters.set(sessionId, 0);
        assignments.delete(sessionId);
        // Drop the load signature so the next initFromDb forces a full
        // reload rather than cache-hitting against pre-reset state.
        loadSignatures.delete(sessionId);
        getResetCounterStatement(db).run(sessionId, getHarness());
    }

    function getCounter(sessionId: string): number {
        return counters.get(sessionId) ?? 0;
    }

    /**
     * Read the current SQLite change-detection signature for `db`. The two
     * cheap probes together detect any commit that could have invalidated
     * our in-memory tagger state.
     */
    function probeSignature(db: Database): { dataVersion: number; totalChanges: number } {
        const dvRow = getProbeDataVersionStatement(db).get() as
            | { data_version: number }
            | null
            | undefined;
        const tcRow = getProbeTotalChangesStatement(db).get() as { tc: number } | null | undefined;
        return {
            dataVersion: dvRow?.data_version ?? 0,
            totalChanges: tcRow?.tc ?? 0,
        };
    }

    /**
     * Load (or refresh) per-session tagger state from the DB.
     *
     * Cache-hit fast path: if the recorded load signature for this session
     * still matches the current `data_version` and `total_changes` on this
     * connection, the in-memory map is consistent with disk and we skip the
     * full reload (~0.005 ms vs ~15 ms on a 49k-tag session).
     *
     * Cache-miss slow path: re-read assignments + counter from disk to pick
     * up writes made by either this connection or a sibling writer. The
     * previous `if (counters.has(sessionId)) return` short-circuit had a
     * subtle bug: once the in-memory counter drifted behind the DB max
     * (stale process, prior outer-transaction rollback, concurrent writer),
     * it could never self-heal — every `assignTag` would keep proposing
     * already-claimed tag numbers and either bounce through the collision-
     * recovery path or fail outright. The signature-based cache restores
     * refresh-on-change correctness without paying the cost on every pass.
     *
     * Realistic hit-rate caveat: `total_changes()` is connection-cumulative,
     * so a write to ANY table on this connection (`session_meta`,
     * `compartments`, `source_contents`, `pending_ops`, …) bumps the
     * counter and invalidates the cache. In practice the postprocess phase
     * persists nudge state, watermarks, sticky reminders, etc., so most
     * defer passes are NOT pure-read — they still pay the full reload cost
     * (still cheap; full reload is ~15 ms on the largest sessions). The
     * cache-hit fast path fires only on truly read-only defer passes, which
     * are infrequent. Don't read the 110× speedup figure as a per-pass
     * average — it's the ceiling for the rarest case.
     *
     * Per-table change detection would lift the hit rate but adds complexity
     * (manual versioning of every write site, brittle to refactors). The
     * current behavior is the simplest correct design that still avoids the
     * pathological "reload every pass even when nothing changed."
     *
     * Important: do NOT update the cached signature from anywhere except
     * a successful full reload. In particular, do not bump it inside
     * `assignTag` — its writes happen inside SAVEPOINTs that a caller-
     * managed outer transaction can later roll back, and marking the cache
     * clean from `assignTag` would freeze in-memory state that is no longer
     * consistent with the rolled-back DB.
     */
    function initFromDb(sessionId: string, db: Database): void {
        const probe = probeSignature(db);
        const cached = loadSignatures.get(sessionId);
        if (
            cached !== undefined &&
            cached.db === db &&
            cached.dataVersion === probe.dataVersion &&
            cached.totalChanges === probe.totalChanges
        ) {
            return;
        }

        const row = db.prepare(GET_COUNTER_SQL).get(sessionId) as
            | { counter: number }
            | null
            | undefined;
        const assignmentRows = db
            .prepare(GET_ASSIGNMENTS_SQL)
            .all(sessionId)
            .filter(isAssignmentRow);
        const sessionAssignments = getSessionAssignments(sessionId);
        sessionAssignments.clear();

        let maxTagNumber = 0;
        for (const assignment of assignmentRows) {
            // v3.3.1 Layer C: tool tags with non-NULL owner enter the
            // map under their composite key so getToolTag/assignToolTag
            // can hit. NULL-owner tool rows are intentionally NOT
            // placed in the in-memory map — they're discoverable via
            // the lazy-adoption DB query (getNullOwnerToolTag) the
            // next time their callId is observed in a transform pass.
            // This guarantees only "fully identified" rows live in
            // memory; NULL-owner orphans get adopted on first touch
            // rather than racing against fresh allocations.
            if (assignment.type === "tool") {
                if (assignment.tool_owner_message_id !== null) {
                    sessionAssignments.set(
                        makeToolCompositeKey(
                            assignment.tool_owner_message_id,
                            assignment.message_id,
                        ),
                        assignment.tag_number,
                    );
                }
                // else: NULL-owner — skip the in-memory binding.
            } else {
                sessionAssignments.set(assignment.message_id, assignment.tag_number);
            }
            if (assignment.tag_number > maxTagNumber) {
                maxTagNumber = assignment.tag_number;
            }
        }

        // Counter is the largest of three signals: persisted counter (what
        // we last wrote), DB max from the assignments table (what's actually
        // claimed), and current in-memory counter (what we already allocated
        // in this process). Taking the max of all three guarantees we never
        // hand out a number some other writer has already taken.
        const counter = Math.max(row?.counter ?? 0, maxTagNumber, counters.get(sessionId) ?? 0);
        counters.set(sessionId, counter);

        // Record the signature AFTER the full reload completes successfully
        // so a thrown query never leaves us with a fresh signature pointing
        // at stale in-memory state.
        loadSignatures.set(sessionId, {
            db,
            dataVersion: probe.dataVersion,
            totalChanges: probe.totalChanges,
        });
    }

    function cleanup(sessionId: string): void {
        counters.delete(sessionId);
        assignments.delete(sessionId);
        // Drop the load signature so the next initFromDb forces a full
        // reload rather than cache-hitting against pre-cleanup state.
        loadSignatures.delete(sessionId);
    }

    return {
        assignTag,
        assignToolTag,
        getTag,
        getToolTag,
        bindTag,
        unbindTag,
        bindToolTag,
        getAssignments,
        resetCounter,
        getCounter,
        initFromDb,
        cleanup,
    };
}
