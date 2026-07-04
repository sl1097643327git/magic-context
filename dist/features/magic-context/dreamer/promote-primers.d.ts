import type { PluginContext } from "../../../plugin/types";
import type { Database } from "../../../shared/sqlite";
export interface PromotePrimersArgs {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    sessionDirectory: string;
    holderId: string;
    leaseKey: string;
    deadline: number;
    promotionThreshold?: number;
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void> | void;
}
export interface PromotePrimersResult {
    promoted: number;
    updated: number;
    candidates: number;
    pruned: number;
}
export declare function promotePrimers(args: PromotePrimersArgs): Promise<PromotePrimersResult>;
//# sourceMappingURL=promote-primers.d.ts.map