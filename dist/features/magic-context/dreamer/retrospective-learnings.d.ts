import type { Database } from "../../../shared/sqlite";
import type { MemoryCategory } from "../memory/types";
export type RetrospectiveLearningRoute = "memory" | "observation";
export interface ParsedRetrospectiveLearning {
    route: RetrospectiveLearningRoute;
    content: string;
    category?: MemoryCategory;
}
export interface RetrospectiveApplyResult {
    memoryWritten: number;
    observationsInserted: number;
    observationsDropped: number;
    rejected: Array<{
        content: string;
        reason: string;
    }>;
}
export declare function parseRetrospectiveLearnings(text: string): ParsedRetrospectiveLearning[];
export declare const MAX_SOURCE_WORD_RUN = 7;
export declare const MAX_SOURCE_WORD_RUN_RATIO = 0.5;
export declare const MAX_OVERLAP_LEARNING_WORDS = 200;
/**
 * True when `content` reads as a near-transcription of any source user line:
 * it shares a contiguous run of ≥ runCap words (an absolute cap of
 * MAX_SOURCE_WORD_RUN, or half the learning's own length for very short
 * learnings). This is the structural enforcement of "distill, don't transcribe"
 * — the regexes catch quotes/dates/anger; this catches a lightly-reworded user
 * sentence that would otherwise pass.
 *
 * Implementation: since runCap ≤ MAX_SOURCE_WORD_RUN (small), "a shared run ≥
 * runCap exists" is equivalent to "some runCap-gram of the learning occurs in the
 * source". We build the learning's runCap-grams once (≤ learning length) and
 * stream each FULL source past them — O(Σ source words) time, O(learning) memory,
 * with NO source truncation (a verbatim run at any offset is caught).
 */
export declare function hasHighSourceOverlap(content: string, sourceUserTexts: string[]): boolean;
export declare function validateRetrospectiveLearningText(content: string, sourceUserTexts?: readonly string[]): string | null;
export declare function applyRetrospectiveLearnings(args: {
    db: Database;
    projectIdentity: string;
    sourceSessionId: string;
    learnings: ParsedRetrospectiveLearning[];
    userMemoryCollectionEnabled: boolean;
    /** The raw source user lines, for the near-transcription reject check. */
    sourceUserTexts?: readonly string[];
}): RetrospectiveApplyResult;
//# sourceMappingURL=retrospective-learnings.d.ts.map