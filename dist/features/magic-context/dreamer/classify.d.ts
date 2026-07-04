import type { PluginContext } from "../../../plugin/types";
import type { Database } from "../../../shared/sqlite";
export interface ClassifyArgs {
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
export interface ClassifyResult {
    classified: number;
    changed: number;
    chunks: number;
    stage: 1 | 2 | 3;
}
export declare function runClassify(args: ClassifyArgs): Promise<ClassifyResult>;
//# sourceMappingURL=classify.d.ts.map