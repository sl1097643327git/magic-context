import type { ContextDatabase } from "../../features/magic-context/storage";
import { getPendingOps } from "../../features/magic-context/storage";
import type { PendingOp, TagEntry } from "../../features/magic-context/types";
import type { TagTarget } from "./tag-messages";
export declare function buildReplacementContent(tagId: number): string;
export declare function applyPendingOperations(sessionId: string, db: ContextDatabase, targets: Map<number, TagTarget>, protectedTags?: number, preloadedTags?: TagEntry[], preloadedPendingOps?: ReturnType<typeof getPendingOps>, syntheticPendingOps?: PendingOp[], 
/**
 * Smart-drops: tag ids to compress as an edit_marker (an edit/write
 * superseded by a later edit to the same file) instead of a full/skeleton
 * drop. Synthetic-only: these are selected for the current apply pass;
 * replay reads the frozen drop_mode, not this set.
 */
editMarkerTagIds?: ReadonlySet<number>): boolean;
export declare function applyFlushedStatuses(sessionId: string, db: ContextDatabase, targets: Map<number, TagTarget>, preloadedTags?: TagEntry[]): boolean;
//# sourceMappingURL=apply-operations.d.ts.map