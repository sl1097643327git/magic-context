import { loadPluginConfigDetailed } from "../config";
import {
    type EmbeddingFeatures,
    registerProjectEmbedding,
} from "../features/magic-context/memory/embedding";
import { invalidateProject } from "../features/magic-context/memory/embedding-cache";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import type { Database } from "../shared/sqlite";
import { handleUntrustedLoad, isConfigLoadUntrusted } from "./embedding-bootstrap-helpers";

export async function ensureProjectRegisteredFromOpenCodeDirectory(
    directory: string,
    db: Database,
): Promise<void> {
    const projectIdentity = resolveProjectIdentity(directory);
    invalidateProject(projectIdentity);

    const detailed = loadPluginConfigDetailed(directory);
    if (isConfigLoadUntrusted(detailed)) {
        handleUntrustedLoad(db, projectIdentity, directory, detailed);
        return;
    }

    const features: EmbeddingFeatures = {
        memoryEnabled: detailed.config.memory.enabled,
        gitCommitEnabled: detailed.config.memory.git_commit_indexing.enabled,
    };
    registerProjectEmbedding(db, projectIdentity, detailed.config.embedding, features, directory);
}
