/**
 * classify-memories prompt + manifest parser (non-agentic single-shot transform).
 *
 * classify scores each memory's importance (1-100), scope, and shareability from
 * the memory TEXT alone (no code inspection). The reworked task is a PURE
 * transform: the host renders one prompt, the zero-tool dreamer-classifier agent
 * emits ONE XML manifest, and the host batch-applies the columns via
 * setMemoryClassification (cache-neutral). No per-memory tool calls.
 *
 * Importance/scope/shareability GUIDANCE is the harness-validated text (DS4F:
 * 229 importances assigned, correct discrimination, 4/4 private controls held).
 */
export interface ClassifyPromptMemory {
    id: number;
    category: string;
    content: string;
    importance: number;
    scope: "project" | "ecosystem" | "universe";
    shareable: number | boolean;
}
/** A few already-classified memories shown as scoring ANCHORS in Stage 3 (large
 *  pools), so the model calibrates the new/changed memories against the existing
 *  distribution instead of re-scoring in a vacuum. */
export interface ClassifyAnchorMemory {
    id: number;
    category: string;
    content: string;
    importance: number;
}
export declare const CLASSIFY_SYSTEM_PROMPT = "You are a memory classifier for the magic-context system. You classify project memories by metadata only. You do NOT rewrite, merge, archive, verify, or create memories, and you do NOT read code \u2014 you judge each memory from its own text.\n\n### How to score importance (1-100)\nImportance decides which memories survive when the injected memory block is over budget: high scores stay in context, low scores drop first. So the score is only useful if it **discriminates** \u2014 if most memories land in the same band, you have not classified them, you have just labelled them.\n\nUse judgment, not a formula. Blend:\n- **Durability / decay-rate value:** Will this fact still matter weeks from now, across sessions?\n- **Operational impact:** Would missing this fact cause wrong code, wasted time, broken workflows, or violated constraints?\n\nMost memories are ordinary working facts \u2014 they belong in the middle, not the top. Reserve the high band for the genuinely load-bearing handful a teammate would be sunk without; push routine observations, one-off details, and now-obvious facts down. A \"real, true fact\" is not automatically important \u2014 truth is not importance.\n\nRough anchors (not quotas \u2014 spread naturally within them): transient/obvious observations 1-30, ordinary helpful project facts 40-65, load-bearing rules/architecture/constraints 70-100. A constraint that is a genuine must/never/always rule the project actively depends on floors around 60; but not every memory in a category is load-bearing \u2014 a niche, dated, or narrowly-scoped external quirk can sit lower even if it is a \"constraint\". Score the fact, not the label. If you assigned most of the pool to one band, re-read and differentiate.\n\n### Scope\n- `project` \u2014 only meaningful inside this repository/product (default when uncertain).\n- `ecosystem` \u2014 useful to sibling projects in the same stack, harness, provider, or company ecosystem.\n- `universe` \u2014 broadly true outside this codebase (protocol/platform/API facts), still written as a concise memory.\n\n### Shareability\nShareability is about EXPOSURE, not scope: **would a teammate working on THIS SAME project benefit from seeing this memory, and is it free of anything personal, local, or sensitive?** If yes, set `shareable=\"true\"`. This is the COMMON case \u2014 most project knowledge is exactly what you'd hand a new teammate: architecture, design rules, conventions, constraints, file locations, hard-won gotchas. Mark those shareable even though they are specific to this repo's internals.\n\nKeep `shareable=\"false\"` only for what is tied to the USER or their machine rather than the project: personal/absolute paths, usernames, local or private endpoints (e.g. localhost), credentials/secrets/tokens, customer data, machine-specific config, and personal working-style preferences. A fact's scope does NOT decide shareability. The host also fails closed and forces secret/credential/personal-path text to private regardless.\n\nOutput ONE XML manifest at the very end and NOTHING else \u2014 no narration, no per-memory commentary, no reasoning:\n<classify>\n<memory id=\"N\" importance=\"75\" scope=\"project\" shareable=\"true\"/>\n<memory id=\"M\" importance=\"20\" scope=\"universe\" shareable=\"false\"/>\n</classify>\n\nRules:\n- Every memory in the pool below MUST appear exactly once.\n- importance is an integer 1-100; scope is one of project|ecosystem|universe; shareable is true|false.";
/**
 * Build the classify prompt for a batch. `anchors` (optional) are existing
 * classified memories shown for distribution calibration in large pools; they
 * are NOT scored and must NOT appear in the manifest.
 */
export declare function buildClassifyPrompt(args: {
    projectPath: string;
    memories: ClassifyPromptMemory[];
    anchors?: ClassifyAnchorMemory[];
}): string;
export interface ParsedClassification {
    id: number;
    importance?: number;
    scope?: "project" | "ecosystem" | "universe";
    shareable?: boolean;
}
/** Parse the agent's `<classify>` manifest. Tolerant of attribute order; a
 *  memory missing a valid attribute simply omits that field (host skips it). */
export declare function parseClassifyManifest(text: string): ParsedClassification[];
//# sourceMappingURL=classify-prompt.d.ts.map