/**
 * Static registration data for one hidden agent. The id / allow-list / step cap
 * are INLINE LITERALS in {@link buildHiddenAgentRegistrations} rather than
 * cross-module `const` imports.
 *
 * # Why inline
 *
 * Belt-and-suspenders, not the load-bearing fix. The load failure was caused by
 * exporting helpers from the entry module (see the module header) — that is what
 * the entry-only-`default` rule fixes. Inlining the small id/tool/step values
 * additionally removes any dependency on cross-module top-level `const` init
 * timing, so this builder returns a complete, valid registration set the instant
 * it is called regardless of module-evaluation order. Cheap insurance for a path
 * that runs once per plugin-instance boot.
 *
 * The only value that cannot be inlined is the multi-KB generated system prompt;
 * it stays a module `var` and is guarded at the call site (skip the agent + log
 * if undefined, never register a broken/deny-all agent).
 *
 * `agent-registration-drift.test.ts` asserts the inline literals here stay
 * byte-identical to the canonical exported constants so they can't silently
 * diverge.
 */
export interface HiddenAgentRegistration {
    id: string;
    prompt: string | undefined;
    allowedTools: readonly string[];
    maxSteps: number;
    overrides?: Record<string, unknown>;
    /** Drop any user `permission` override (privacy-critical agents only). */
    lockPermissions?: boolean;
}
/**
 * Hoisted function declaration: returns the four hidden-agent registrations with
 * INLINE id / allow-list / step-cap literals (see {@link HiddenAgentRegistration}
 * for why these must not come from module-level `var` consts). Prompts and
 * computed overrides are passed in by the caller; the historian disallow filter
 * is applied here against an inline default allow-list.
 */
export declare function buildHiddenAgentRegistrations(args: {
    dreamerPrompt: string | undefined;
    smartNoteCompilerPrompt?: string | undefined;
    historianPrompt: string | undefined;
    historianRecompPrompt?: string | undefined;
    historianEditorPrompt: string | undefined;
    sidekickPrompt: string | undefined;
    dreamerOverrides?: Record<string, unknown>;
    historianOverrides?: Record<string, unknown>;
    sidekickOverrides?: Record<string, unknown>;
    historianDisallowed: readonly string[];
}): HiddenAgentRegistration[];
/**
 * Build a hidden-agent config with a deny-everything-by-default permission
 * baseline and a hard tool-iteration ceiling. User overrides may lower
 * `steps`/`maxSteps`, but cannot raise either above the built-in cap.
 */
export declare function buildHiddenAgentConfig(prompt: string, allowedTools: readonly string[], maxSteps: number, overrides?: Record<string, unknown>, agentLabel?: string, lockPermissions?: boolean): {
    steps: number;
    maxSteps: number;
    permission: {
        [x: string]: unknown;
    };
    mode: "subagent";
    hidden: boolean;
    prompt: string;
};
//# sourceMappingURL=hidden-agent-registrations.d.ts.map