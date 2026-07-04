import type { PluginContext } from "../../../plugin/types";
import type { Database } from "../../../shared/sqlite";
interface ReviewUserMemoriesArgs {
    db: Database;
    client: PluginContext["client"];
    parentSessionId: string | undefined;
    sessionDirectory: string | undefined;
    holderId: string;
    /** Keyed lease this task holds (Dreamer v2: global user-memories domain).
     *  Defaults to the legacy single lease key for back-compat. */
    leaseKey?: string;
    deadline: number;
    promotionThreshold: number;
    /** Per-task model override (Dreamer v2). */
    model?: string;
    /** Resolved dreamer fallback chain. */
    fallbackModels?: readonly string[];
    language?: string;
}
interface ReviewResult {
    promoted: number;
    merged: number;
    dismissed: number;
    candidatesConsumed: number;
}
export declare function reviewUserMemories(args: ReviewUserMemoriesArgs): Promise<ReviewResult>;
export {};
//# sourceMappingURL=review-user-memories.d.ts.map