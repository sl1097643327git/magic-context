export declare const DREAMER_AGENT = "dreamer";
export declare const DREAMER_RETROSPECTIVE_AGENT = "dreamer-retrospective";
export declare const DREAMER_PRIMER_INVESTIGATOR_AGENT = "dreamer-primer-investigator";
export declare const DREAMER_MEMORY_MAPPER_AGENT = "dreamer-memory-mapper";
/** Read-only tool profile shared by the memory-maintenance reader agent.
 *  No ctx_search (local-source checks only), no write/bash/ctx_memory. */
export declare const DREAMER_MEMORY_MAPPER_ALLOWED_TOOLS: readonly ["read", "grep", "glob", "aft_outline", "aft_zoom", "aft_search"];
export declare const DREAMER_CLASSIFIER_AGENT = "dreamer-classifier";
export declare const DREAMER_DOCS_AGENT = "dreamer-docs";
/** Codebase-read + doc-write tool profile for the docs maintainer. No memory
 *  tools (it edits docs, not the memory store). */
export declare const DREAMER_DOCS_ALLOWED_TOOLS: readonly ["read", "grep", "glob", "bash", "write", "edit", "aft_outline", "aft_zoom", "aft_search"];
export declare const DREAMER_REVIEWER_AGENT = "dreamer-reviewer";
/** Tool profile for the base `dreamer` agent, now CURATE-ONLY (memory-pool
 *  hygiene). Curate edits the memory store through ctx_memory and never reads
 *  code (a separate verify task owns memory-vs-code correctness), so it needs
 *  only ctx_memory — not the former bash/write/edit/read/aft/ctx_search/ctx_note
 *  kitchen sink. Kept on the `dreamer` id so the ctx_memory dreamer-action gate
 *  (toolContext.agent === DREAMER_AGENT) still recognizes it. */
export declare const DREAMER_CURATE_ALLOWED_TOOLS: readonly ["ctx_memory"];
//# sourceMappingURL=dreamer.d.ts.map