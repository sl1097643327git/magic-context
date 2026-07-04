import type { EmbeddingConfig } from "../../config/schema/magic-context";
import type { Database } from "../../shared/sqlite";
import type { EmbeddingProvider, EmbeddingPurpose } from "./memory/embedding-provider";
export interface EmbeddingFeatures {
    memoryEnabled: boolean;
    gitCommitEnabled: boolean;
}
export interface ProjectEmbeddingRegistrationSnapshot {
    projectIdentity: string;
    sourceDirectory: string;
    providerIdentity: string;
    runtimeFingerprint: string;
    generation: number;
    features: EmbeddingFeatures;
    enabled: boolean;
    gitCommitEnabled: boolean;
    modelId: string;
    chunkModelId: string;
    /** Friendly configured model name (e.g. "text-embedding-qwen3-embedding-4b"),
     *  for user-facing status. "off" when no provider / observation mode. */
    model: string;
    /** Configured provider kind (e.g. "openai-compatible", "local", "ollama"). */
    provider: string;
}
/** Latch a project as currently loaded from an untrusted config (suppresses GC). */
export declare function markProjectLoadUntrusted(projectIdentity: string): void;
export interface StaleEmbeddingSweepResult {
    memoryRowsDeleted: number;
    commitRowsDeleted: number;
    chunkRowsDeleted: number;
    trackingRowsDeleted: number;
}
export declare function sweepStaleEmbeddingIdentitiesForProject(db: Database, projectIdentity: string, now?: number): StaleEmbeddingSweepResult;
export declare function registerProjectEmbedding(db: Database, projectIdentity: string, config: EmbeddingConfig, features: EmbeddingFeatures, sourceDirectory: string): ProjectEmbeddingRegistrationSnapshot;
export declare function registerProjectInObservationMode(db: Database, projectIdentity: string, sourceDirectory: string, failedConfig: EmbeddingConfig, failureSummary: string): ProjectEmbeddingRegistrationSnapshot;
export declare function unregisterProjectEmbedding(projectIdentity: string): void;
export declare function getProjectEmbeddingSnapshot(projectIdentity: string): ProjectEmbeddingRegistrationSnapshot | null;
export declare function getProjectChunkEmbeddingModelId(projectIdentity: string): string;
export declare function getProjectEmbeddingMaxInputTokens(projectIdentity: string): number;
export declare function embedTextForProject(projectIdentity: string, text: string, signal?: AbortSignal, purpose?: EmbeddingPurpose): Promise<{
    vector: Float32Array;
    modelId: string;
    generation: number;
} | null>;
export declare function embedBatchForProject(projectIdentity: string, texts: string[], signal?: AbortSignal, purpose?: EmbeddingPurpose): Promise<{
    vectors: (Float32Array | null)[];
    modelId: string;
    generation: number;
} | null>;
export declare function embedUnembeddedMemoriesForProject(db: Database, projectIdentity: string, batchSize?: number): Promise<number>;
/**
 * Drain a project's unembedded-commit backlog, coordinated across processes.
 *
 * Drains pure backlogs (indexed commits with no embedding row). The dream-timer
 * git-sweep embeds new commits from `git log` but skips backlog drain when
 * `embedded=0`; this path runs after each sweep (ignoreCooldown lease) so
 * pre-existing backlogs clear. Every plugin process runs this
 * on its dream-timer tick, so without coordination N processes hammer the
 * embedding provider with the same commits. We take the shared git-sweep lease
 * (mutual exclusion) per identity — but with `ignoreCooldown`, because a
 * backlog must keep draining every tick until empty and must not be blocked by
 * the cooldown the dream-timer sweep advances. We release without marking
 * success so the two paths' cooldown tracking stays independent.
 */
export declare function drainCommitBacklogForProject(db: Database, projectIdentity: string, deadline: number): Promise<number>;
export declare function embedUnembeddedCompartmentChunksForProject(db: Database, projectIdentity: string): Promise<number>;
export interface SessionChunkBackfillProgress {
    /** Compartments fully embedded so far this run. */
    embedded: number;
    /** Total compartments that needed embedding when the run started. */
    total: number;
}
export type SessionChunkBackfillOutcome = {
    status: "done";
    embedded: number;
    total: number;
    failed: number;
} | {
    status: "nothing";
    embedded: 0;
    total: 0;
} | {
    status: "disabled";
    embedded: 0;
    total: 0;
} | {
    status: "busy";
    embedded: 0;
    total: number;
} | {
    status: "aborted";
    embedded: number;
    total: number;
    failed: number;
} | {
    status: "stalled";
    embedded: number;
    total: number;
    remaining: number;
    failed: number;
};
/**
 * Backfill ALL un-embedded compartment chunks for ONE session in a single run
 * (the `/ctx-embed-history` command path), oldest-first so progress fills
 * chronologically. Unlike the passive project drain this has no per-sweep cap —
 * the user asked for the whole session — but it still runs under the per-project
 * embedding coordinator lease (mutual exclusion with the passive sweep + sibling
 * processes) and yields between batches so an 8-core MiniLM burst stays
 * interruptible. Idempotent + resumable via chunk_hash; re-running embeds only
 * what's still missing.
 */
export declare function embedSessionCompartmentChunks(db: Database, projectIdentity: string, sessionId: string, options?: {
    signal?: AbortSignal;
    onProgress?: (p: SessionChunkBackfillProgress) => void;
    batchSize?: number;
}): Promise<SessionChunkBackfillOutcome>;
export interface EmbeddingCoverageStatus {
    /** Whether embedding is active at all for this project. */
    enabled: boolean;
    /** Friendly configured model name, or "off"/"disabled". */
    model: string;
    /** Configured provider kind ("local" / "openai-compatible" / "ollama" / "off"). */
    provider: string;
    /** This session's compartment-chunk coverage. */
    session: {
        embedded: number;
        total: number;
    };
    /** Project-wide active-memory coverage. */
    memories: {
        embedded: number;
        total: number;
    };
    /** Project-wide git-commit coverage (only meaningful when gitEnabled). */
    commits: {
        embedded: number;
        total: number;
        gitEnabled: boolean;
    };
}
/**
 * Gather the embedding-coverage status for `/ctx-embed` (no-arg): which model is
 * active, and how much of this session's history / the project's memories /
 * git commits are embedded under it. Pure reads — no provider calls.
 */
export declare function getEmbeddingCoverageStatus(db: Database, projectIdentity: string, sessionId: string): EmbeddingCoverageStatus;
export declare function sweepAllRegisteredProjects(db: Database, batchSize?: number): Promise<{
    memoriesEmbedded: number;
    commitsEmbedded: number;
    chunksEmbedded: number;
    perProject: Map<string, {
        memories: number;
        commits: number;
        chunks: number;
    }>;
}>;
export declare function _setTestProviderFactoryForProject(factory: ((config: EmbeddingConfig) => EmbeddingProvider | null) | null): void;
export declare function _resetProjectEmbeddingRegistryForTests(): void;
//# sourceMappingURL=project-embedding-registry.d.ts.map