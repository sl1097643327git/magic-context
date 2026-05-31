// The historian system prompt is the validated v8.7.3 artifact, generated from
// historian-prompt.source.md (escape-safe). Edit the .md source + regenerate via
// scripts/build-historian-prompt.ts — never hand-edit the generated constant.
export { COMPARTMENT_AGENT_SYSTEM_PROMPT } from "./historian-prompt.generated";

export const HISTORIAN_EDITOR_SYSTEM_PROMPT = `You are an editor refining a historian draft. The draft was produced by a first-pass historian and may contain noise — low-signal U: lines, redundant quotes across compartments, and weak preservation decisions.

Your job is to clean the draft without changing its structure:

1. DROP low-signal U: lines:
   - Questions in any form — resolved decision goes in narrative only.
   - Pacing/agreement: "let's go", "yes", "okay", "sounds good", "I agree".
   - Pasted error output, debugging status, mid-process observations.
   - Tactical micro-direction: "now look at X", "first check Y".

2. DROP cross-compartment duplicates:
   - Scan U: lines across ALL compartments in the draft.
   - If two U: lines express the same intent/decision, keep only ONE — in the compartment where the outcome is actually described.

3. STRIP agreement prefixes:
   - "Yes we should X" → keep only the directive content, or drop entirely if nothing substantive remains after "Yes".

4. PREFER verbatim over paraphrase:
   - If the draft rephrased a user directive into formal constraint language, restore the user's wording if available.
   - Do not invent technical specificity (file paths, function names, constants) the user did not state.

5. FOLD into narrative when possible:
   - If a U: line's signal is already captured in the surrounding narrative, drop the U: line.
   - Narrative should not need the U: line to be understood.

6. KEEP as U: lines ONLY:
   - Hard constraints with concrete values (thresholds, byte sizes, timeouts).
   - Explicit rejections ("X is wrong because Y", "NOT Z").
   - Implementation pivots in future-tense ("instead of A, do B").
   - Source-of-truth corrections.

Do NOT change:
- Compartment titles, ranges, or ordering.
- Narrative summary text unless it directly references a U: line you dropped (in which case integrate the signal into the narrative).
- Facts — leave the facts section untouched.
- <meta> section — leave messages_processed and unprocessed_from exactly as the draft has them.

Output the cleaned version as valid XML matching the original structure. Preserve all XML tags, compartment ranges, meta, and facts.`;

export function buildHistorianEditorPrompt(draft: string): string {
    return [
        "This is a historian draft. Clean it up following the rules in your system prompt.",
        "",
        "<draft>",
        draft,
        "</draft>",
        "",
        "Return the cleaned draft as valid XML matching the original structure.",
    ].join("\n");
}
export interface CompartmentPromptInputs {
    /** `<compartment_examples_from_other_projects>` block (4-seed floor), or "". */
    seedExamples: string;
    /** `<session_references>` block (last-6 recency), or "" for a young session. */
    sessionReferences: string;
    /** `<project-memory>` block for fact dedup, or "" when memory disabled/empty. */
    projectMemory: string;
    /** Raw chunk to compartmentalize, pre-formatted `Messages X-Y:\n\n...`. */
    inputSource: string;
    /** When false, instruct the historian to SKIP fact extraction entirely.
     *  v2 faithful facts are stored only as project memories; with memory
     *  disabled there is no fact store, so emitting facts is pure waste
     *  (and they would never be rendered). Defaults to enabled. */
    memoryEnabled?: boolean;
}

/**
 * Assemble the per-run historian USER prompt for the v8.7.3 system prompt.
 *
 * The system prompt (`COMPARTMENT_AGENT_SYSTEM_PROMPT`, from
 * historian-prompt.generated.ts) carries ALL instructions. This builder only
 * lays out the four input blocks in the order the prompt's Inputs section
 * documents: cross-project examples → session references → project memory →
 * `<new_messages>`. The unbounded v1 `existing_state` dump is GONE (v2) —
 * bounded reference blocks replace it.
 */
export function buildCompartmentAgentPrompt(inputs: CompartmentPromptInputs): string {
    const parts: string[] = [];
    if (inputs.seedExamples) parts.push(inputs.seedExamples);
    if (inputs.sessionReferences) parts.push(inputs.sessionReferences);
    if (inputs.projectMemory) parts.push(inputs.projectMemory);
    if (inputs.memoryEnabled === false) {
        // Memory disabled → no fact store exists. Tell the historian to skip
        // the <facts> section so it spends its budget on compartments only.
        parts.push(
            "<fact_extraction>disabled</fact_extraction>\nMemory is disabled for this project: do NOT emit a <facts> block. Produce compartments only.",
        );
    }
    parts.push("<new_messages>");
    parts.push(inputs.inputSource);
    parts.push("</new_messages>");
    return parts.join("\n\n");
}
