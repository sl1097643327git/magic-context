import type { PluginContext } from "../../../plugin/types";
import type { Database } from "../../../shared/sqlite";
import { type VerifyPromptMemory } from "./verify-prompt";
export interface VerifyArgs {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string;
    holderId: string;
    leaseKey: string;
    deadline: number;
    forceBroad?: boolean;
    model?: string;
    fallbackModels?: readonly string[];
    language?: string;
}
export interface VerifyResult {
    verified: number;
    updated: number;
    archived: number;
    batches: number;
    inScope: number;
    mode: string;
}
export declare function runVerify(args: VerifyArgs): Promise<VerifyResult>;
/**
 * Apply the manifest host-side. Only ids that were IN this batch are touched.
 * - verified: re-record the (normalized) backing files with verified_at = now
 *   (banks the per-memory verify progress).
 * - update: rewrite the memory content via the cache-neutral mutation log, then
 *   clear old file mappings and embeddings so the new content is mapped and
 *   verified again next cycle.
 * - archive: archive + queue an archive mutation (m[1] delta). Skipped when the
 *   memory is no longer primary-mutable (already archived/superseded), so a stale
 *   manifest can't fight a concurrent change.
 * All writes happen under ONE lease-guarded transaction.
 */
export declare function applyVerifyManifest(args: VerifyArgs, batch: VerifyPromptMemory[], manifestText: string): Promise<{
    verified: number;
    updated: number;
    archived: number;
}>;
//# sourceMappingURL=verify.d.ts.map