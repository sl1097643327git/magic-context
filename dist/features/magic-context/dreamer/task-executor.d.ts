import type { RawMessageProvider } from "../../../hooks/magic-context/read-session-chunk";
import type { PluginContext } from "../../../plugin/types";
import type { Database } from "../../../shared/sqlite";
import { type RetrospectiveRawProvider } from "./retrospective-raw-provider";
import type { TaskExecutor } from "./task-scheduler";
export interface DreamTaskExecutorDeps {
    client: PluginContext["client"];
    /** Filesystem directory of the project this drain owns (NOT the identity). */
    sessionDirectory: string;
    /** Opens the OpenCode DB read-only (for the key-files candidate scan). The
     *  dream-timer owns the path resolution; null when unavailable. */
    openOpenCodeDb: () => Database | null;
    retrospectiveRawProvider?: RetrospectiveRawProvider | ((db: Database, projectIdentity: string) => RetrospectiveRawProvider | null);
    /** Host-side privacy gate for route="observation" learnings. */
    userMemoryCollectionEnabled?: boolean;
    /** Ensure the project embedding provider is registered before primer clustering embeds candidates. */
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void> | void;
    /**
     * Pi only: builds a RawMessageProvider for an arbitrary historical session id
     * so refresh-primers can render the orientation seed from Pi JSONL. OpenCode
     * leaves this undefined (the seed read falls to the read-only opencode.db
     * path). Returning null for a session → refresh falls back to closed-book.
     */
    primerRawProviderFactory?: (sessionId: string) => Promise<RawMessageProvider | null> | RawMessageProvider | null;
    language?: string;
}
/**
 * Build the TaskExecutor the v2 scheduler drives. The scheduler owns the keyed
 * domain lease + holderId and hands them in; this executor runs one task's actual
 * work (LLM loop / specialized runner), renews the lease during the run, aborts
 * if the lease is lost, and writes one per-task dream_runs telemetry row.
 */
export declare function createDreamTaskExecutor(deps: DreamTaskExecutorDeps): TaskExecutor;
/** Parse the gate's verdict. Expected shape: a single line `n` (no friction) or
 *  `y: 3, 7` (flagged ordinals). Robust to a model that wraps it in prose:
 *  - scan LINE BY LINE for the first verdict-leading line (`y`/`yes`/`n`/`no`);
 *  - ordinals are taken ONLY from that verdict line (so a stray year/number in
 *    surrounding prose can't fabricate a deepen);
 *  - if no verdict-leading line exists, look for an embedded `y: <nums>` pattern;
 *  - anything unparseable → NO hit (fail safe — the caller still advances the
 *    watermark on a clean run, so a garbled verdict can't wedge progress).
 *  A `y` with zero ordinals is NOT a hit (there are no lines to deepen on). */
export declare function parseFrictionGateVerdict(verdict: string): {
    hit: boolean;
    ordinals: number[];
};
//# sourceMappingURL=task-executor.d.ts.map