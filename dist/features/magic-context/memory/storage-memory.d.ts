import type { Database } from "../../../shared/sqlite";
import type { Memory, MemoryCategory, MemoryInput, MemoryScope, MemoryStatus, VerificationStatus } from "./types";
export declare const COLUMN_MAP: Record<keyof Memory, string>;
export interface MemoryCountsByStatus {
    total: number;
    active: number;
    permanent: number;
    archived: number;
    merged: number;
    ids: number[];
    archivedIds: number[];
    mergedIds: number[];
}
export declare function hasMemoryShareableColumn(db: Database): boolean;
export declare function hasMemoryClassifiedAtColumn(db: Database): boolean;
/** Memory ids (from the given set) that have never been classified — the
 *  classify-memories run-gate + Stage-3 "to-classify" partition. */
export declare function getUnclassifiedMemoryIds(db: Database, memoryIds: readonly number[]): number[];
export declare function getMemorySelectColumns(db: Database, tableName?: string): string;
export declare function isMemoryRow(row: unknown): row is Memory;
export declare function toMemory(row: Memory): Memory;
export declare function insertMemory(db: Database, input: MemoryInput): Memory;
export declare function getMemoryByHash(db: Database, projectPath: string, category: MemoryCategory, normalizedHash: string): Memory | null;
export declare function getMemoriesByProject(db: Database, projectPath: string, statuses?: MemoryStatus[], expiryCutoff?: number): Memory[];
export interface WorkspaceMemorySharingFilter {
    ownIdentities?: readonly string[];
    shareCategories?: readonly string[] | null;
}
export interface WorkspaceMemorySqlFilter {
    clause: string;
    params: string[];
    active: boolean;
}
export declare function buildWorkspaceMemorySqlFilter(args: {
    identities: readonly string[];
    ownIdentities?: readonly string[];
    shareCategories?: readonly string[] | null;
    tableName?: string;
}): WorkspaceMemorySqlFilter;
export declare function getMemoriesByProjects(db: Database, projectPaths: readonly string[], statuses?: MemoryStatus[], expiryCutoff?: number, ownIdentities?: readonly string[], shareCategories?: readonly string[] | null): Memory[];
export declare function getMaxMemoryIdForProjects(db: Database, projectPaths: readonly string[], ownIdentities?: readonly string[], shareCategories?: readonly string[] | null): number;
export declare function readNewMemoriesForM1Union(db: Database, projectPaths: readonly string[], afterId: number, expiryCutoff: number, ownIdentities?: readonly string[], shareCategories?: readonly string[] | null): Memory[];
export declare function getAllActiveMemoriesForMigration(db: Database, projectPath: string): Memory[];
export declare function getMemoryById(db: Database, id: number): Memory | null;
export declare function updateMemorySeenCount(db: Database, id: number): void;
export declare function updateMemoryRetrievalCount(db: Database, id: number): void;
export declare function updateMemoryStatus(db: Database, id: number, status: MemoryStatus): void;
export declare function updateMemoryVerification(db: Database, id: number, verificationStatus: VerificationStatus): void;
export declare function updateMemoryContent(db: Database, id: number, content: string, normalizedHash: string): void;
export interface MemoryClassificationUpdate {
    importance?: number;
    scope?: MemoryScope;
    shareable?: boolean;
}
export declare function setMemoryClassification(db: Database, id: number, classification: MemoryClassificationUpdate): boolean;
export declare function supersededMemory(db: Database, id: number, supersededById: number): void;
export declare function mergeMemoryStats(db: Database, id: number, seenCount: number, retrievalCount: number, mergedFrom: string, status: MemoryStatus): void;
export declare function archiveMemory(db: Database, id: number, reason?: string): void;
export declare function deleteMemory(db: Database, id: number): void;
export declare function getMemoryCount(db: Database, projectPath?: string): number;
export declare function getMemoryCountsByStatus(db: Database, projectPath: string): MemoryCountsByStatus;
//# sourceMappingURL=storage-memory.d.ts.map