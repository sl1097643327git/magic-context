import type { ContextDatabase } from "../../features/magic-context/storage";
import type { TagEntry } from "../../features/magic-context/types";
import { type CavemanCleanupConfig } from "./caveman-cleanup";
import type { MessageLike, TagTarget } from "./tag-messages";
export declare function applyHeuristicCleanup(sessionId: string, db: ContextDatabase, targets: Map<number, TagTarget>, messageTagNumbers: Map<MessageLike, number>, config: {
    protectedTags: number;
    /**
     * Tiered target-headroom emergency drop. Provided only on the ≥85%
     * force-materialize (cache-busting) pass; undefined on routine execute
     * passes (Phase 2 removed routine age-based tool drops entirely). When
     * present, the emergency drop runs before dedup/injection-strip.
     */
    emergency?: {
        currentTotalInputTokens: number;
        ceilingTokens: number;
    };
    /**
     * Age-tier caveman text compression settings. Only honored when the
     * session is running with ctx_reduce_enabled=false — caller is
     * responsible for zeroing this out when ctx_reduce is on.
     */
    caveman?: CavemanCleanupConfig;
}, preloadedTags?: TagEntry[]): {
    droppedTools: number;
    deduplicatedTools: number;
    droppedInjections: number;
    emergencyDroppedTools: number;
    compressedTextTags: number;
    mutatedTextTags: number;
};
//# sourceMappingURL=heuristic-cleanup.d.ts.map