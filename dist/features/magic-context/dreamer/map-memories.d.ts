import type { PluginContext } from "../../../plugin/types";
import type { Database } from "../../../shared/sqlite";
export interface MapMemoriesArgs {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string;
    holderId: string;
    leaseKey: string;
    deadline: number;
    model?: string;
    fallbackModels?: readonly string[];
}
export interface MapMemoriesResult {
    mapped: number;
    independent: number;
    batches: number;
    remaining: number;
}
export declare function mapMemories(args: MapMemoriesArgs): Promise<MapMemoriesResult>;
//# sourceMappingURL=map-memories.d.ts.map