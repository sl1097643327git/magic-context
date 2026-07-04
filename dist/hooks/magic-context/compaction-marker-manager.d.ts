/**
 * Compaction Marker Manager
 *
 * Coordinates compaction marker injection/update/removal with historian
 * publication. Called after compartments are published. Always-on since
 * v0.21.4 — the `compaction_markers` config knob was removed because the
 * feature is required for sane transform performance on long sessions.
 *
 * The marker summary text is a static placeholder — the real <session-history>
 * is injected by the transform pipeline via inject-compartments.ts. The marker
 * exists solely to make OpenCode's filterCompacted stop at the boundary so the
 * transform receives only the live tail.
 */
import { type PendingCompactionMarker } from "../../features/magic-context/storage-meta-persisted";
import type { Database } from "../../shared/sqlite";
/**
 * Outcome of `updateCompactionMarkerAfterPublication` after the plan-v6
 * refactor. Currently UNUSED — the legacy `void`-returning entry point is
 * still the call site for incremental, recomp, and partial-recomp runners.
 * Step 2 of plan v6 wires this in.
 *
 * Drain policy (consumer reads this in transform-postprocess-phase):
 *   - `applied` / `already-current` / `stale-skip` → CAS-clear pending
 *   - `retryable-failure` → keep pending, do NOT consume
 *     `deferredHistoryRefreshSessions`
 */
export type MarkerUpdateOutcome = {
    kind: "applied";
    markerOrdinal: number;
} | {
    kind: "already-current";
} | {
    kind: "stale-skip";
    reason: "compartment-removed" | "target-superseded";
} | {
    kind: "retryable-failure";
    error: Error;
};
/**
 * Apply a deferred compaction-marker mutation owned by a specific pending
 * blob. Called from the transform postprocess drain — see
 * `transform-postprocess-phase.ts` Plan v6 §1.
 *
 * Returns one of four outcomes; the drain interprets each:
 *   - `applied`         → CAS-clear pending (we did the work)
 *   - `already-current` → CAS-clear pending (boundary already at this ordinal)
 *   - `stale-skip`      → CAS-clear pending (target gone or superseded)
 *   - `retryable-failure` → KEEP pending (transient failure; next consuming
 *                          pass will retry; another publish may overwrite
 *                          blob and that publish's drain heals)
 *
 * The justification for "retry on inject failure" is that
 * `removeCompactionMarker()` is a no-op success on already-missing rows (per
 * `compaction-marker.ts:358-367`), so a retry of the full sequence is safe:
 * the second remove sees nothing to delete and succeeds; the second inject
 * tries again.
 */
export declare function applyDeferredCompactionMarker(db: Database, sessionId: string, pending: PendingCompactionMarker, directory?: string): MarkerUpdateOutcome;
/**
 * After historian publishes new compartments, inject or move the compaction marker.
 * Only moves the boundary forward; summary text is a static placeholder.
 *
 * Plan v6: callers in incremental / recomp / partial-recomp paths invoke this
 * directly only when they are NOT deferring (i.e.
 * `preserveInjectionCacheUntilConsumed === false`). Deferred path uses
 * `applyDeferredCompactionMarker` from postprocess drain.
 */
export declare function updateCompactionMarkerAfterPublication(db: Database, sessionId: string, lastCompartmentEnd: number, directory?: string): boolean;
/**
 * Remove the compaction marker for a session (e.g. on session.deleted).
 */
export declare function removeCompactionMarkerForSession(db: Database, sessionId: string): void;
/**
 * Close the writable OpenCode DB connection used for marker injection.
 */
export declare function closeCompactionMarkerConnection(): void;
/**
 * Startup consistency check for compaction markers.
 *
 * Magic Context persists marker state in context.db's `session_meta`, while the
 * actual marker rows (compaction part + summary message + summary part) live in
 * OpenCode's separate `opencode.db`. There is no cross-DB transaction between
 * the two stores, so a crash between writes — or any external cleanup of
 * OpenCode's DB — can leave the two in an inconsistent state:
 *
 * - Phantom state: persisted in context.db but the referenced rows no longer
 *   exist in opencode.db. On next publication, the manager tries to remove a
 *   marker that isn't there, ignores the failure, and re-injects, but the
 *   stale persisted state can also confuse readers that trust it.
 * - Orphaned rows: rows in opencode.db exist without matching context.db
 *   state. Those can't be surfaced from here (we don't track them), but the
 *   natural-healing path already handles them: the next historian publication
 *   moves the boundary forward and the new injection replaces the orphans by
 *   moving filterCompacted past them.
 *
 * This function scans all persisted marker states and, for each one, verifies
 * that the referenced rows still exist in opencode.db. If any referenced row
 * is missing, it treats the marker as inconsistent, attempts to remove
 * whatever rows ARE still present (best-effort cleanup of half-written
 * markers), and clears the persisted state so the next publication can
 * re-inject cleanly.
 *
 * Called once at plugin startup. Safe to call multiple times (idempotent).
 */
export declare function checkCompactionMarkerConsistency(db: Database): void;
//# sourceMappingURL=compaction-marker-manager.d.ts.map