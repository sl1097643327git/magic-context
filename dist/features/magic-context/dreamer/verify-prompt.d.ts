/**
 * verify prompt + manifest parser.
 *
 * verify checks each in-scope project memory against the CURRENT source and
 * emits ONE XML manifest (verified / update / archive). The agent reads code
 * and changes nothing; the HOST parses the manifest and applies the DB writes
 * (so the agent never needs a mutation tool). Calibrated in the shadow harness
 * with planted ground-truth controls (4/4: caught a stale number → update, a
 * wrong tool-count → archive, a same-session change → archive, and kept the
 * correct control verified). See .alfonso/plans/dreamer-v2-rework.md.
 *
 * The DANGEROUS failure mode is WRONG ARCHIVAL (deleting a TRUE memory), so the
 * prompt and the host apply both bias hard toward keeping memories.
 */
export declare const VERIFY_SYSTEM_PROMPT = "You are a memory verifier for the magic-context system. You verify project memories against the CURRENT code.\n\nEach memory below comes with its backing file(s) \u2014 the code it makes a claim about. For EACH memory: read its backing files (you may read more if needed) and decide whether the memory is still accurate.\n\nTools (read-only): read, grep, glob, aft_search, aft_outline, aft_zoom. You read code to check claims; you change nothing.\n\nDecide ONE of three outcomes per memory:\n- VERIFIED \u2014 still accurate. Keep it as-is.\n- UPDATE \u2014 the underlying fact is still true but a DETAIL drifted (a renamed symbol, moved file, changed number/name). Provide corrected content in terse present tense (\"X uses Y\", not \"X was changed to Y\"). Only update for genuine drift, not style.\n- ARCHIVE \u2014 the code CLEARLY contradicts the memory, or the thing it describes no longer exists.\n\nBE CONSERVATIVE ABOUT ARCHIVING. Wrong archival of a TRUE memory is the worst possible outcome \u2014 far worse than leaving a slightly-stale memory. If you cannot find the code, or you are unsure, or it might still be true somewhere you didn't look: mark it VERIFIED, never archived. Archive ONLY when you have positive evidence the code contradicts it.\n\nOutput ONE XML manifest at the very end and NOTHING else \u2014 no narration, no per-memory commentary, no reasoning:\n<verify>\n<verified id=\"N\" files=\"path/a.ts,path/b.ts\"/>\n<update id=\"M\" files=\"path/c.ts\">corrected present-tense content</update>\n<archive id=\"K\" reason=\"specific evidence the code contradicts it\"/>\n</verify>\n\nRules:\n- Every input memory id MUST appear exactly once, in exactly one of verified/update/archive.\n- files = the COMPLETE current backing set (repo-relative, comma-separated). It may differ from the given mapping if a file moved \u2014 record what you actually verified against.\n- Default to VERIFIED. update and archive are the exceptions, not the norm.";
export interface VerifyPromptMemory {
    id: number;
    category: string;
    content: string;
    mappedFiles: string[];
}
export declare function buildVerifyPrompt(projectPath: string, memories: VerifyPromptMemory[]): string;
export interface ParsedVerifyManifest {
    verified: Array<{
        id: number;
        files: string[];
    }>;
    updated: Array<{
        id: number;
        files: string[];
        content: string;
    }>;
    archived: Array<{
        id: number;
        reason: string;
    }>;
}
/** Parse the agent's `<verify>` manifest. Tolerant of attribute order, and of
 *  `<update>` either self-closing or wrapping its corrected content. */
export declare function parseVerifyManifest(text: string): ParsedVerifyManifest;
//# sourceMappingURL=verify-prompt.d.ts.map