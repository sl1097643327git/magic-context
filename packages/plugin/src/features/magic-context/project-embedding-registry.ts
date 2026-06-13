import { createHash, randomUUID } from "node:crypto";

import type { EmbeddingConfig } from "../../config/schema/magic-context";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../config/schema/magic-context";
import { log } from "../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import {
    buildCanonicalChunkTextFromFts,
    type CompartmentChunkBackfillCandidate,
    chunkCanonicalText,
    chunkEmbeddingWindowsAreCurrent,
    clearChunkEmbeddingsForProject,
    countUnembeddedSessionCompartments,
    getDistinctChunkEmbeddingModelIds,
    loadUnembeddedCompartmentChunkCandidates,
    loadUnembeddedSessionChunkCandidates,
    normalizeCompartmentChunkMaxInputTokens,
    replaceCompartmentChunkEmbeddings,
    type SaveCompartmentChunkEmbeddingInput,
} from "./compartment-chunk-embedding";
import {
    clearProjectCommitEmbeddings,
    getDistinctCommitEmbeddingModelIds,
    loadUnembeddedCommits,
    saveCommitEmbedding,
} from "./git-commits/storage-git-commit-embeddings";
import { acquireGitSweepLease, releaseGitSweepLease } from "./git-commits/sweep-coordinator";
import { invalidateProject } from "./memory/embedding-cache";
import { getEmbeddingProviderIdentity } from "./memory/embedding-identity";
import { LocalEmbeddingProvider } from "./memory/embedding-local";
import { OpenAICompatibleEmbeddingProvider } from "./memory/embedding-openai";
import type { EmbeddingProvider } from "./memory/embedding-provider";
import {
    clearEmbeddingsForProject,
    getDistinctStoredModelIds,
    saveEmbedding,
} from "./memory/storage-memory-embeddings";

const OFF_PROVIDER_IDENTITY = "embedding-provider:off";
const SWEEP_MAX_WALL_CLOCK_MS = 10 * 60 * 1000;
const SWEEP_MAX_CONSECUTIVE_EMPTY = 3;
// Backlog-drain caps for the commit-embedding path. The drain loops within one
// held coordinator lease so a large backlog (e.g. a 2000-commit repo that was
// indexed before embeddings were enabled) clears in a few ticks instead of
// crawling one batch per tick. Bounded per sweep so one project can't starve
// the others or pin the provider indefinitely.
const COMMIT_DRAIN_BATCH_SIZE = 16;
const COMMIT_DRAIN_MAX_PER_SWEEP = 500;
const CHUNK_DRAIN_BATCH_SIZE = 8;
const CHUNK_DRAIN_MAX_PER_SWEEP = 200;

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
}

interface ProjectEmbeddingRegistration {
    projectIdentity: string;
    sourceDirectory: string;
    config: EmbeddingConfig;
    providerIdentity: string;
    runtimeFingerprint: string;
    provider: EmbeddingProvider | null;
    generation: number;
    features: EmbeddingFeatures;
    modelId: string;
    observationMode: boolean;
}

interface UnembeddedMemoryRow {
    id: number;
    content: string;
}

const projectRegistrations = new Map<string, ProjectEmbeddingRegistration>();
const loadUnembeddedMemoriesStatements = new WeakMap<Database, PreparedStatement>();
let globalRegistrationGeneration = 0;
let projectSweepInProgress = false;
let testProviderFactory: ((config: EmbeddingConfig) => EmbeddingProvider | null) | null = null;

function resolveEmbeddingConfig(config?: EmbeddingConfig): EmbeddingConfig {
    if (!config || config.provider === "local") {
        return {
            provider: "local",
            model: config?.model?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL,
            ...(config?.max_input_tokens
                ? {
                      max_input_tokens: normalizeCompartmentChunkMaxInputTokens(
                          config.max_input_tokens,
                      ),
                  }
                : {}),
        };
    }

    if (config.provider === "openai-compatible") {
        const apiKey = config.api_key?.trim();
        const inputType = config.input_type?.trim();
        const truncate = config.truncate?.trim();
        return {
            provider: "openai-compatible",
            model: config.model.trim(),
            endpoint: config.endpoint.trim(),
            ...(apiKey ? { api_key: apiKey } : {}),
            // Preserve provider-specific request fields (NVIDIA NIM input_type;
            // truncate). They must survive normalization so (a) they reach the
            // provider request body and (b) a change to either is part of the
            // config identity hash → a real config change correctly wipes stale
            // vectors. Dropping them here silently disabled NIM support.
            ...(inputType ? { input_type: inputType } : {}),
            ...(truncate ? { truncate } : {}),
            ...(config.max_input_tokens
                ? {
                      max_input_tokens: normalizeCompartmentChunkMaxInputTokens(
                          config.max_input_tokens,
                      ),
                  }
                : {}),
        };
    }

    return { provider: "off" };
}

function createProvider(config: EmbeddingConfig): EmbeddingProvider | null {
    if (testProviderFactory) {
        return testProviderFactory(config);
    }

    if (config.provider === "off") {
        return null;
    }

    if (config.provider === "openai-compatible") {
        return new OpenAICompatibleEmbeddingProvider({
            endpoint: config.endpoint,
            model: config.model,
            apiKey: config.api_key,
            inputType: config.input_type,
            truncate: config.truncate,
            maxInputTokens: config.max_input_tokens,
        });
    }

    return new LocalEmbeddingProvider(config.model, config.max_input_tokens);
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
    }
    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
        );
        return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function sha256Prefix(value: string, length = 16): string {
    return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function getRuntimeFingerprint(config: EmbeddingConfig): string {
    if (config.provider === "off") {
        return OFF_PROVIDER_IDENTITY;
    }
    return `${getEmbeddingProviderIdentity(config)}:${sha256Prefix(stableStringify(config))}`;
}

function sameFeatures(a: EmbeddingFeatures, b: EmbeddingFeatures): boolean {
    return a.memoryEnabled === b.memoryEnabled && a.gitCommitEnabled === b.gitCommitEnabled;
}

function snapshotFor(
    registration: ProjectEmbeddingRegistration,
): ProjectEmbeddingRegistrationSnapshot {
    const providerIsOn = registration.providerIdentity !== OFF_PROVIDER_IDENTITY;
    const enabled =
        !registration.observationMode && providerIsOn && registration.features.memoryEnabled;
    const gitCommitEnabled =
        !registration.observationMode && providerIsOn && registration.features.gitCommitEnabled;
    return {
        projectIdentity: registration.projectIdentity,
        sourceDirectory: registration.sourceDirectory,
        providerIdentity: registration.providerIdentity,
        runtimeFingerprint: registration.runtimeFingerprint,
        generation: registration.generation,
        features: { ...registration.features },
        enabled,
        gitCommitEnabled,
        modelId: registration.observationMode || !providerIsOn ? "off" : registration.modelId,
    };
}

function disposeProvider(provider: EmbeddingProvider | null): void {
    if (!provider) return;
    void provider.dispose().catch((error) => {
        log("[magic-context] embedding provider dispose failed:", error);
    });
}

function anyStoredModelIdIsStale(storedIds: Set<string | null>, currentId: string): boolean {
    if (storedIds.size === 0) return false;
    for (const id of storedIds) {
        if (id === null || id !== currentId) {
            return true;
        }
    }
    return false;
}

function maybeWipeStaleEmbeddings(
    db: Database,
    projectIdentity: string,
    currentProviderIdentity: string,
    features: EmbeddingFeatures,
): boolean {
    if (currentProviderIdentity === OFF_PROVIDER_IDENTITY) {
        return false;
    }

    let wiped = false;
    db.transaction(() => {
        if (features.memoryEnabled) {
            const memoryIds = getDistinctStoredModelIds(db, projectIdentity);
            if (anyStoredModelIdIsStale(memoryIds, currentProviderIdentity)) {
                clearEmbeddingsForProject(db, projectIdentity);
                invalidateProject(projectIdentity);
                wiped = true;
            }
        }

        if (features.gitCommitEnabled) {
            const commitIds = getDistinctCommitEmbeddingModelIds(db, projectIdentity);
            if (anyStoredModelIdIsStale(commitIds, currentProviderIdentity)) {
                clearProjectCommitEmbeddings(db, projectIdentity);
                wiped = true;
            }
        }

        if (features.memoryEnabled) {
            const chunkIds = getDistinctChunkEmbeddingModelIds(db, projectIdentity);
            if (anyStoredModelIdIsStale(chunkIds, currentProviderIdentity)) {
                clearChunkEmbeddingsForProject(db, projectIdentity);
                wiped = true;
            }
        }
    })();

    return wiped;
}

export function registerProjectEmbeddingAndMaybeWipe(
    db: Database,
    projectIdentity: string,
    config: EmbeddingConfig,
    features: EmbeddingFeatures,
    sourceDirectory: string,
): ProjectEmbeddingRegistrationSnapshot {
    const resolvedConfig = resolveEmbeddingConfig(config);
    const providerIdentity = getEmbeddingProviderIdentity(resolvedConfig);
    const runtimeFingerprint = getRuntimeFingerprint(resolvedConfig);
    const prior = projectRegistrations.get(projectIdentity);
    const canReuseProvider =
        prior !== undefined &&
        !prior.observationMode &&
        prior.runtimeFingerprint === runtimeFingerprint &&
        prior.providerIdentity === providerIdentity;
    const wiped = maybeWipeStaleEmbeddings(db, projectIdentity, providerIdentity, features);
    const generationChanged =
        prior === undefined ||
        prior.observationMode ||
        prior.runtimeFingerprint !== runtimeFingerprint ||
        !sameFeatures(prior.features, features) ||
        wiped;
    const generation = generationChanged ? ++globalRegistrationGeneration : prior.generation;
    const registration: ProjectEmbeddingRegistration = {
        projectIdentity,
        sourceDirectory,
        config: resolvedConfig,
        providerIdentity,
        runtimeFingerprint,
        provider: canReuseProvider ? prior.provider : null,
        generation,
        features: { ...features },
        modelId: providerIdentity === OFF_PROVIDER_IDENTITY ? "off" : providerIdentity,
        observationMode: false,
    };

    projectRegistrations.set(projectIdentity, registration);

    if (!canReuseProvider) {
        disposeProvider(prior?.provider ?? null);
    }

    return snapshotFor(registration);
}

export function registerProjectInObservationMode(
    db: Database,
    projectIdentity: string,
    sourceDirectory: string,
    failedConfig: EmbeddingConfig,
    failureSummary: string,
): ProjectEmbeddingRegistrationSnapshot {
    void db;
    const prior = projectRegistrations.get(projectIdentity);
    const runtimeFingerprint = `observation:${sha256Prefix(failureSummary)}`;
    const generation =
        prior?.runtimeFingerprint === runtimeFingerprint && prior.observationMode
            ? prior.generation
            : ++globalRegistrationGeneration;
    const registration: ProjectEmbeddingRegistration = {
        projectIdentity,
        sourceDirectory,
        config: resolveEmbeddingConfig(failedConfig),
        providerIdentity: OFF_PROVIDER_IDENTITY,
        runtimeFingerprint,
        provider: null,
        generation,
        features: { memoryEnabled: false, gitCommitEnabled: false },
        modelId: "off",
        observationMode: true,
    };

    projectRegistrations.set(projectIdentity, registration);
    disposeProvider(prior?.provider ?? null);

    return snapshotFor(registration);
}

export function unregisterProjectEmbedding(projectIdentity: string): void {
    const prior = projectRegistrations.get(projectIdentity);
    if (!prior) return;
    projectRegistrations.delete(projectIdentity);
    globalRegistrationGeneration += 1;
    disposeProvider(prior.provider);
}

export function getProjectEmbeddingSnapshot(
    projectIdentity: string,
): ProjectEmbeddingRegistrationSnapshot | null {
    const registration = projectRegistrations.get(projectIdentity);
    return registration ? snapshotFor(registration) : null;
}

export function getProjectEmbeddingMaxInputTokens(projectIdentity: string): number {
    const registration = projectRegistrations.get(projectIdentity);
    const configMax =
        registration?.config && "max_input_tokens" in registration.config
            ? registration.config.max_input_tokens
            : undefined;
    return normalizeCompartmentChunkMaxInputTokens(
        registration?.provider?.maxInputTokens ?? configMax,
    );
}

function getOrCreateProjectProvider(
    registration: ProjectEmbeddingRegistration,
): EmbeddingProvider | null {
    if (registration.providerIdentity === OFF_PROVIDER_IDENTITY || registration.observationMode) {
        return null;
    }
    if (registration.provider) {
        return registration.provider;
    }
    const provider = createProvider(registration.config);
    registration.provider = provider;
    return provider;
}

export async function embedTextForProject(
    projectIdentity: string,
    text: string,
    signal?: AbortSignal,
): Promise<{ vector: Float32Array; modelId: string; generation: number } | null> {
    const registration = projectRegistrations.get(projectIdentity);
    if (!registration) return null;
    const generation = registration.generation;
    const modelId = registration.modelId;
    const provider = getOrCreateProjectProvider(registration);
    if (!provider) return null;

    const vector = await provider.embed(text, signal);
    if (!vector) return null;

    const current = projectRegistrations.get(projectIdentity);
    if (
        !current ||
        current.generation !== generation ||
        current.runtimeFingerprint !== registration.runtimeFingerprint
    ) {
        return null;
    }

    return { vector, modelId, generation };
}

export async function embedBatchForProject(
    projectIdentity: string,
    texts: string[],
    signal?: AbortSignal,
): Promise<{ vectors: (Float32Array | null)[]; modelId: string; generation: number } | null> {
    if (texts.length === 0) {
        const registration = projectRegistrations.get(projectIdentity);
        if (!registration || registration.observationMode) return null;
        return { vectors: [], modelId: registration.modelId, generation: registration.generation };
    }

    const registration = projectRegistrations.get(projectIdentity);
    if (!registration) return null;
    const generation = registration.generation;
    const modelId = registration.modelId;
    const runtimeFingerprint = registration.runtimeFingerprint;
    const provider = getOrCreateProjectProvider(registration);
    if (!provider) return null;

    const vectors = await provider.embedBatch(texts, signal);
    const current = projectRegistrations.get(projectIdentity);
    if (
        !current ||
        current.generation !== generation ||
        current.runtimeFingerprint !== runtimeFingerprint
    ) {
        return null;
    }

    return { vectors, modelId, generation };
}

function isUnembeddedMemoryRow(row: unknown): row is UnembeddedMemoryRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return typeof candidate.id === "number" && typeof candidate.content === "string";
}

function getLoadUnembeddedMemoriesStatement(db: Database): PreparedStatement {
    let stmt = loadUnembeddedMemoriesStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT m.id AS id, m.content AS content FROM memories m LEFT JOIN memory_embeddings me ON m.id = me.memory_id WHERE m.project_path = ? AND m.status = 'active' AND me.memory_id IS NULL LIMIT ?",
        );
        loadUnembeddedMemoriesStatements.set(db, stmt);
    }
    return stmt;
}

export async function embedUnembeddedMemoriesForProject(
    db: Database,
    projectIdentity: string,
    batchSize = 10,
): Promise<number> {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.enabled) return 0;

    const normalizedBatchSize = Math.max(1, Math.floor(batchSize));
    const memories = getLoadUnembeddedMemoriesStatement(db)
        .all(projectIdentity, normalizedBatchSize)
        .filter(isUnembeddedMemoryRow);
    if (memories.length === 0) return 0;

    try {
        const result = await embedBatchForProject(
            projectIdentity,
            memories.map((memory) => memory.content),
        );
        if (!result) return 0;

        let embeddedCount = 0;
        db.transaction(() => {
            for (const [index, memory] of memories.entries()) {
                const embedding = result.vectors[index];
                if (!embedding) continue;
                saveEmbedding(db, memory.id, embedding, result.modelId);
                embeddedCount += 1;
            }
        })();
        return embeddedCount;
    } catch (error) {
        log("[magic-context] failed to proactively embed missing memories:", error);
        return 0;
    }
}

/** Drain a single batch of unembedded commits. Returns how many embedded. */
async function embedCommitBatch(
    db: Database,
    projectIdentity: string,
    batchSize: number,
): Promise<number> {
    const commits = loadUnembeddedCommits(db, projectIdentity, Math.max(1, Math.floor(batchSize)));
    if (commits.length === 0) return 0;

    const result = await embedBatchForProject(
        projectIdentity,
        commits.map((commit) => commit.message),
    );
    if (!result) return 0;

    let embeddedCount = 0;
    db.transaction(() => {
        for (const [index, commit] of commits.entries()) {
            const embedding = result.vectors[index];
            if (!embedding) continue;
            saveCommitEmbedding(db, commit.sha, embedding, result.modelId);
            embeddedCount += 1;
        }
    })();
    return embeddedCount;
}

/**
 * Drain a project's unembedded-commit backlog, coordinated across processes.
 *
 * This is the ONLY path that drains pure backlogs (the dream-timer git-sweep
 * only embeds when `git log` finds NEW commits, so a repo indexed before
 * embeddings were enabled never drains there). Every plugin process runs this
 * on its dream-timer tick, so without coordination N processes hammer the
 * embedding provider with the same commits. We take the shared git-sweep lease
 * (mutual exclusion) per identity — but with `ignoreCooldown`, because a
 * backlog must keep draining every tick until empty and must not be blocked by
 * the cooldown the dream-timer sweep advances. We release without marking
 * success so the two paths' cooldown tracking stays independent.
 */
async function drainCommitBacklogForProject(
    db: Database,
    projectIdentity: string,
    deadline: number,
): Promise<number> {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.gitCommitEnabled) return 0;

    const holderId = `embed-sweep-${randomUUID()}`;
    const lease = acquireGitSweepLease(db, projectIdentity, holderId, { ignoreCooldown: true });
    if (!lease.acquired) {
        // Another process is sweeping/draining this identity — skip cleanly.
        return 0;
    }

    let total = 0;
    try {
        while (Date.now() < deadline && total < COMMIT_DRAIN_MAX_PER_SWEEP) {
            const embedded = await embedCommitBatch(db, projectIdentity, COMMIT_DRAIN_BATCH_SIZE);
            if (embedded === 0) break;
            total += embedded;
            if (embedded < COMMIT_DRAIN_BATCH_SIZE) break; // partial batch = drained
        }
    } finally {
        releaseGitSweepLease(db, projectIdentity, holderId);
    }
    return total;
}

async function embedCompartmentChunkBatch(
    db: Database,
    projectIdentity: string,
    batchSize: number,
): Promise<number> {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.enabled || snapshot.modelId === "off") return 0;

    const candidates = loadUnembeddedCompartmentChunkCandidates(
        db,
        projectIdentity,
        snapshot.modelId,
        batchSize,
    );
    if (candidates.length === 0) return 0;
    return embedCandidateChunkBatch(db, projectIdentity, snapshot.modelId, candidates);
}

/** Embed + persist chunk vectors for an already-selected candidate batch.
 *  Shared by the project-wide passive drain and the session-scoped on-demand
 *  backfill. Returns the number of compartments fully embedded this call. */
async function embedCandidateChunkBatch(
    db: Database,
    projectIdentity: string,
    modelId: string,
    candidates: CompartmentChunkBackfillCandidate[],
): Promise<number> {
    if (candidates.length === 0) return 0;
    const maxInputTokens = getProjectEmbeddingMaxInputTokens(projectIdentity);
    const prepared: Array<{
        candidate: (typeof candidates)[number];
        windows: ReturnType<typeof chunkCanonicalText>;
        textOffset: number;
    }> = [];
    const texts: string[] = [];

    for (const candidate of candidates) {
        const canonicalText = buildCanonicalChunkTextFromFts(
            db,
            candidate.sessionId,
            candidate.startMessage,
            candidate.endMessage,
        );
        if (canonicalText.length === 0) continue;
        const windows = chunkCanonicalText(
            canonicalText,
            candidate.startMessage,
            candidate.endMessage,
            maxInputTokens,
        );
        if (windows.length === 0) continue;
        if (chunkEmbeddingWindowsAreCurrent(db, candidate.id, modelId, windows)) {
            continue;
        }
        prepared.push({ candidate, windows, textOffset: texts.length });
        texts.push(...windows.map((window) => window.text));
    }

    if (texts.length === 0) return 0;

    try {
        const result = await embedBatchForProject(projectIdentity, texts);
        if (!result) return 0;

        let embeddedCount = 0;
        for (const item of prepared) {
            const vectors = result.vectors.slice(
                item.textOffset,
                item.textOffset + item.windows.length,
            );
            if (vectors.length !== item.windows.length || vectors.some((vector) => !vector)) {
                continue;
            }
            const rows: SaveCompartmentChunkEmbeddingInput[] = item.windows.map(
                (window, index) => ({
                    compartmentId: item.candidate.id,
                    sessionId: item.candidate.sessionId,
                    projectPath: projectIdentity,
                    window,
                    modelId: result.modelId,
                    vector: vectors[index] as Float32Array,
                }),
            );
            replaceCompartmentChunkEmbeddings(db, rows);
            embeddedCount += 1;
        }
        return embeddedCount;
    } catch (error) {
        log("[magic-context] failed to proactively embed compartment chunks:", error);
        return 0;
    }
}

async function drainCompartmentChunkBacklogForProject(
    db: Database,
    projectIdentity: string,
    deadline: number,
): Promise<number> {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.enabled) return 0;

    const holderId = `chunk-embed-sweep-${randomUUID()}`;
    const lease = acquireGitSweepLease(db, projectIdentity, holderId, { ignoreCooldown: true });
    if (!lease.acquired) {
        return 0;
    }

    let total = 0;
    try {
        while (Date.now() < deadline && total < CHUNK_DRAIN_MAX_PER_SWEEP) {
            const embedded = await embedCompartmentChunkBatch(
                db,
                projectIdentity,
                CHUNK_DRAIN_BATCH_SIZE,
            );
            if (embedded === 0) break;
            total += embedded;
            if (embedded < CHUNK_DRAIN_BATCH_SIZE) break;
        }
    } finally {
        releaseGitSweepLease(db, projectIdentity, holderId);
    }
    return total;
}

export async function embedUnembeddedCompartmentChunksForProject(
    db: Database,
    projectIdentity: string,
): Promise<number> {
    return drainCompartmentChunkBacklogForProject(
        db,
        projectIdentity,
        Date.now() + SWEEP_MAX_WALL_CLOCK_MS,
    );
}

export interface SessionChunkBackfillProgress {
    /** Compartments fully embedded so far this run. */
    embedded: number;
    /** Total compartments that needed embedding when the run started. */
    total: number;
}

export type SessionChunkBackfillOutcome =
    | { status: "done"; embedded: number; total: number }
    | { status: "nothing"; embedded: 0; total: 0 }
    | { status: "disabled"; embedded: 0; total: 0 }
    | { status: "busy"; embedded: 0; total: number }
    | { status: "aborted"; embedded: number; total: number };

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
export async function embedSessionCompartmentChunks(
    db: Database,
    projectIdentity: string,
    sessionId: string,
    options?: {
        signal?: AbortSignal;
        onProgress?: (p: SessionChunkBackfillProgress) => void;
        batchSize?: number;
    },
): Promise<SessionChunkBackfillOutcome> {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.enabled || snapshot.modelId === "off") {
        return { status: "disabled", embedded: 0, total: 0 };
    }
    const total = countUnembeddedSessionCompartments(db, sessionId, snapshot.modelId);
    if (total === 0) return { status: "nothing", embedded: 0, total: 0 };

    const holderId = `session-embed-${randomUUID()}`;
    const lease = acquireGitSweepLease(db, projectIdentity, holderId, { ignoreCooldown: true });
    if (!lease.acquired) return { status: "busy", embedded: 0, total };

    const batchSize = Math.max(1, options?.batchSize ?? CHUNK_DRAIN_BATCH_SIZE);
    let embedded = 0;
    try {
        options?.onProgress?.({ embedded, total });
        // Re-query each iteration (rather than pre-loading all candidates) so
        // newly-published compartments mid-run are picked up and so chunk_hash
        // dedup is re-checked against fresh state. Loop ends when a query
        // returns no candidates (all embedded) — `total` is the start-of-run
        // figure for the progress denominator, embedded may exceed it only if
        // the historian published during the run (clamped in the callback).
        for (;;) {
            if (options?.signal?.aborted) {
                return { status: "aborted", embedded, total };
            }
            const candidates = loadUnembeddedSessionChunkCandidates(
                db,
                sessionId,
                snapshot.modelId,
                batchSize,
            );
            if (candidates.length === 0) break;
            const n = await embedCandidateChunkBatch(
                db,
                projectIdentity,
                snapshot.modelId,
                candidates,
            );
            // A batch that selected candidates but embedded 0 (all skipped:
            // empty canonical text / windows-already-current) would loop
            // forever since the candidate query still returns them. Guard by
            // breaking when no forward progress is made on a non-empty batch.
            if (n === 0) break;
            embedded += n;
            options?.onProgress?.({ embedded: Math.min(embedded, total), total });
            // Yield to the event loop so the burst stays interruptible and the
            // host process can serve other work between batches.
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    } finally {
        releaseGitSweepLease(db, projectIdentity, holderId);
    }
    return { status: "done", embedded, total };
}

export async function sweepAllRegisteredProjects(
    db: Database,
    batchSize = 10,
): Promise<{
    memoriesEmbedded: number;
    commitsEmbedded: number;
    chunksEmbedded: number;
    perProject: Map<string, { memories: number; commits: number; chunks: number }>;
}> {
    if (projectSweepInProgress) {
        log("[magic-context] project embedding sweep already in progress, skipping this tick");
        return {
            memoriesEmbedded: 0,
            commitsEmbedded: 0,
            chunksEmbedded: 0,
            perProject: new Map(),
        };
    }

    projectSweepInProgress = true;
    const startedAt = Date.now();
    const deadline = startedAt + SWEEP_MAX_WALL_CLOCK_MS;
    const perProject = new Map<string, { memories: number; commits: number; chunks: number }>();
    let memoriesEmbedded = 0;
    let commitsEmbedded = 0;
    let chunksEmbedded = 0;

    try {
        for (const projectIdentity of projectRegistrations.keys()) {
            let memories = 0;
            let commits = 0;
            let chunks = 0;
            let consecutiveEmpty = 0;

            while (Date.now() < deadline) {
                const count = await embedUnembeddedMemoriesForProject(
                    db,
                    projectIdentity,
                    batchSize,
                );
                if (count === 0) {
                    consecutiveEmpty += 1;
                    if (consecutiveEmpty >= SWEEP_MAX_CONSECUTIVE_EMPTY) break;
                    break;
                }
                consecutiveEmpty = 0;
                memories += count;
                memoriesEmbedded += count;
                if (count < batchSize) break;
            }

            if (Date.now() < deadline) {
                commits = await drainCommitBacklogForProject(db, projectIdentity, deadline);
                commitsEmbedded += commits;
            }

            if (Date.now() < deadline) {
                chunks = await drainCompartmentChunkBacklogForProject(
                    db,
                    projectIdentity,
                    deadline,
                );
                chunksEmbedded += chunks;
            }

            perProject.set(projectIdentity, { memories, commits, chunks });
            if (Date.now() >= deadline) break;
        }
    } finally {
        projectSweepInProgress = false;
    }

    return { memoriesEmbedded, commitsEmbedded, chunksEmbedded, perProject };
}

export function _setTestProviderFactoryForProject(
    factory: ((config: EmbeddingConfig) => EmbeddingProvider | null) | null,
): void {
    testProviderFactory = factory;
}

export function _resetProjectEmbeddingRegistryForTests(): void {
    for (const registration of projectRegistrations.values()) {
        disposeProvider(registration.provider);
    }
    projectRegistrations.clear();
    globalRegistrationGeneration = 0;
    projectSweepInProgress = false;
    testProviderFactory = null;
}
