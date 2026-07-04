export interface ConflictResult {
    /** Whether any blocking conflict was found */
    hasConflict: boolean;
    /** Human-readable reasons for each conflict */
    reasons: string[];
    /** Which conflicts were found — used for targeted fixes */
    conflicts: {
        compactionAuto: boolean;
        compactionPrune: boolean;
        dcpPlugin: boolean;
        omoPreemptiveCompaction: boolean;
        omoContextWindowMonitor: boolean;
        omoAnthropicRecovery: boolean;
    };
}
/**
 * Detect all conflicts that would prevent magic-context from working correctly.
 * Checks: OpenCode compaction, DCP plugin, OMO conflicting hooks.
 */
export declare function detectConflicts(directory: string): ConflictResult;
/**
 * Canonical npm package names that represent the conflicting plugin.
 * Matched against the npm-style segment of each plugin entry, so:
 *   - "@tarquinen/opencode-dcp"           ✓ direct match
 *   - "@tarquinen/opencode-dcp@latest"    ✓ version suffix stripped
 *   - "@tarquinen/opencode-dcp@^3.1.0"    ✓ semver suffix stripped
 *   - "file:///path/to/opencode-dcp-fork" ✗ unrelated path
 *
 * forks/renames that don't ship the conflicting transform/system hooks are
 * intentionally NOT matched.
 */
export declare const DCP_PACKAGE_NAMES: Set<string>;
/**
 * Match a plugin entry against a set of canonical npm package names.
 *
 * A plugin entry can be:
 *   - "pkg-name"
 *   - "pkg-name@version"
 *   - "@scope/pkg-name"
 *   - "@scope/pkg-name@version"
 *   - "file://..." or other URL/path forms (never matched here)
 *
 * For the canonical-name path we only match the exact package name (with
 * optional version suffix). file:// paths and forks with different
 * package names are intentionally NOT matched — even if a path string
 * happens to contain a substring like "oh-my-opencode" (e.g. forks like
 * "oh-my-opencode-slim" published under a different package name).
 */
export declare function matchesPackageName(entry: string, canonicalNames: Set<string>): boolean;
/** Extract the package-name string from a plugin entry.
 *  OpenCode supports two forms:
 *   - plain string:        "@scope/pkg@latest"
 *   - tuple [name, opts]:  ["@scope/pkg@latest", { ... }]
 *  Returns null for any other shape (numbers, objects, etc.). */
export declare function extractPluginName(entry: unknown): string | null;
/**
 * Canonical OMO npm package names. The plugin publishes under both names as
 * a versioned alias (latest 3.17.5 on npm at time of writing).
 *
 * Forks under a different package name (e.g. `oh-my-opencode-slim`,
 * `oh-my-opencode-cli`, etc.) are intentionally NOT matched here — they
 * don't ship the `preemptive-compaction`, `context-window-monitor`, or
 * `anthropic-context-window-limit-recovery` hooks that conflict with
 * Magic Context. See https://github.com/cortexkit/magic-context/issues/43.
 *
 * The legacy `@code-yeongyu/` scope is no longer used — both names are
 * unscoped on npm.
 */
export declare const OMO_PACKAGE_NAMES: Set<string>;
/**
 * Generate a short conflict summary for ignored message display.
 */
export declare function formatConflictShort(result: ConflictResult): string;
//# sourceMappingURL=conflict-detector.d.ts.map