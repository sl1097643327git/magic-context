import type { Database } from "../../../shared/sqlite";
import type { Memory } from "./types";
export declare function sanitizeFtsQuery(query: string): string;
export declare function searchMemoriesFTS(db: Database, projectPath: string, query: string, limit?: number): Memory[];
export declare function searchMemoriesFTSUnion(db: Database, projectPaths: readonly string[], query: string, limit?: number, ownIdentities?: readonly string[], shareCategories?: readonly string[] | null): Memory[];
//# sourceMappingURL=storage-memory-fts.d.ts.map