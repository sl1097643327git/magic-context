import type { Database } from "../../../shared/sqlite";
interface SessionFact {
    category: string;
    content: string;
}
export interface PromotedMemoryRef {
    memoryId: number;
    content: string;
}
/**
 * Synchronously promote eligible session facts to cross-session memories.
 *
 * Transaction contract: callers may run this inside their publish transaction.
 * Storage failures deliberately propagate so the enclosing publication rolls
 * back atomically with the boundary; malformed/unpromotable facts are validation
 * skips and do not abort the publish.
 */
export declare function promoteSessionFactsDurable(db: Database, sessionId: string, projectPath: string, facts: SessionFact[]): PromotedMemoryRef[];
/**
 * Best-effort asynchronous embedding for newly promoted facts. Must run after
 * the durable publish transaction commits.
 */
export declare function embedPromotedFacts(db: Database, sessionId: string, projectPath: string, refs: PromotedMemoryRef[]): Promise<void>;
export {};
//# sourceMappingURL=promotion.d.ts.map