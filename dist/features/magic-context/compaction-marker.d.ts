/**
 * Compaction Marker Injection
 *
 * Injects compaction boundaries into OpenCode's SQLite DB so that
 * `filterCompacted` stops at the historian boundary. After injection,
 * the transform hook receives only post-boundary messages instead
 * of the full session history.
 *
 * Always-on as of v0.21.4. Previously gated behind `compaction_markers`
 * config (default true since v0.9.0); the knob was removed because the
 * feature is required for sane transform performance.
 *
 * ## What gets injected (3 rows):
 * 1. A `compaction` part on the boundary user message
 * 2. A summary assistant message with `parentID` → boundary user message
 * 3. A text part on that summary message containing a static placeholder
 *
 * The real `<session-history>` is injected by the transform pipeline via
 * inject-compartments.ts. The marker exists solely to make filterCompacted
 * stop at the boundary.
 *
 * ## How OpenCode's filterCompacted works:
 * - Iterates newest→oldest
 * - Stops when it finds a user message that:
 *   (a) has a part with type: "compaction"
 *   (b) has a completed summary assistant response (summary: true, finish: "stop")
 *       whose parentID matches that user message's id
 */
export declare function generateMessageId(timestampMs: number, counter?: bigint): string;
export declare function generatePartId(timestampMs: number, counter?: bigint): string;
export declare function getOpenCodeDbPath(): string;
export declare function closeCompactionMarkerDb(): void;
export interface BoundaryUserMessage {
    id: string;
    timeCreated: number;
}
/**
 * Find the nearest user message at or before the given end message id.
 * The boundary must be a user message for filterCompacted to work.
 *
 * Filters out compaction summary messages (summary=true, finish="stop")
 * so ordinals stay consistent with readRawSessionMessagesFromDb.
 */
export declare function findBoundaryUserMessage(sessionId: string, endMessageId: string): BoundaryUserMessage | null;
export declare function compareOpenCodeMessagesByCanonicalOrder(sessionId: string, leftMessageId: string, rightMessageId: string): number | null;
/**
 * Check whether an OpenCode message ID still exists for a given session.
 *
 * Used by plan v6's deferred marker drain to validate that a deferred
 * compaction-marker target hasn't been wiped by recomp / revert / partial
 * recomp between publication and the consuming pass. Errors propagate
 * (unlike the swallow-and-return-empty helpers in `read-session-db.ts`):
 * the marker-manager wraps this call in its own try/catch so missing or
 * locked OpenCode DBs become `retryable-failure` outcomes, not silent skips.
 *
 * Note: returns `{ id }` rather than a richer row shape because the only
 * thing the caller needs is existence. If a future caller needs role or
 * timestamps, widen the return type but keep the throw-on-failure contract.
 */
export declare function getOpenCodeMessageById(sessionId: string, messageId: string): {
    id: string;
} | null;
interface CompactionMarkerState {
    /** The user message ID that has the compaction part */
    boundaryMessageId: string;
    /** The summary assistant message ID we injected */
    summaryMessageId: string;
    /** The compaction part ID on the user message */
    compactionPartId: string;
    /** The text part ID on the summary message */
    summaryPartId: string;
}
export interface InjectCompactionMarkerArgs {
    sessionId: string;
    /** Raw ordinal of the last compartmentalized message */
    endOrdinal: number;
    /** OpenCode message id of the last compartmentalized message */
    endMessageId: string;
    /** Summary text for the compaction summary message (static placeholder) */
    summaryText: string;
    /** Working directory for the session */
    directory: string;
    /** Boundary resolved before removing the old marker (prevents null-boundary cache busts). */
    resolvedBoundary?: BoundaryUserMessage;
}
/**
 * Inject a compaction marker into OpenCode's DB.
 * Returns the marker state if successful, null if boundary couldn't be found.
 */
export declare function injectCompactionMarker(args: InjectCompactionMarkerArgs): CompactionMarkerState | null;
/**
 * Remove an existing compaction marker (all 3 rows).
 * Used when moving the boundary forward or on session cleanup.
 */
export declare function removeCompactionMarker(state: CompactionMarkerState): boolean;
export {};
//# sourceMappingURL=compaction-marker.d.ts.map