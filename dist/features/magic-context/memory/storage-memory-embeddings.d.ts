import type { Database } from "../../../shared/sqlite";
export interface StoredMemoryEmbedding {
    embedding: Float32Array;
    modelId: string | null;
}
export declare function saveEmbedding(db: Database, memoryId: number, embedding: Float32Array, modelId: string): void;
export declare function loadAllEmbeddings(db: Database, projectPath: string, modelId: string): Map<number, StoredMemoryEmbedding>;
export declare function deleteEmbedding(db: Database, memoryId: number): void;
export declare function getStoredModelId(db: Database, projectPath: string): string | null;
export declare function clearEmbeddingsForProject(db: Database, projectPath: string, modelId?: string): number;
export declare function getDistinctStoredModelIds(db: Database, projectPath: string): Set<string | null>;
/** Active memories for a project, and how many are embedded under `modelId`.
 *  Drives the `/ctx-embed` status `embedded / total` memory line. */
export declare function getMemoryEmbedCoverage(db: Database, projectPath: string, modelId: string): {
    embedded: number;
    total: number;
};
//# sourceMappingURL=storage-memory-embeddings.d.ts.map