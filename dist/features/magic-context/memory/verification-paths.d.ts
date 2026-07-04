export interface NormalizedVerificationFiles {
    files: string[];
    warnings: string[];
    gitRoot: string | null;
}
export declare function resolveGitTopLevel(cwd: string): Promise<string | null>;
export declare function readGitHead(cwd: string): Promise<string | null>;
export declare function gitCommitExists(cwd: string, revision: string): Promise<boolean>;
export declare function readGitChangedFilesSince(cwd: string, revision: string): Promise<Set<string> | null>;
/**
 * Map each repo file changed at/after `sinceMs` to its LATEST commit time (ms).
 * Drives the per-memory verify gate: a memory needs re-verification if any of
 * its mapped files has a change time newer than that memory's `verified_at`.
 *
 * Returns null on any git failure → caller falls back to full verification
 * (safe direction: re-check rather than skip). Output excludes the working tree;
 * a file edited but uncommitted is caught separately by `verificationFileExists`
 * (deletion) — verify reads the live file regardless, so uncommitted edits are
 * surfaced when the file is opened. The committed-history map is what lets the
 * gate cheaply SKIP unchanged memories.
 */
export declare function readGitFileChangeTimesSince(cwd: string, sinceMs: number): Promise<Map<string, number> | null>;
export declare function verificationFileExists(baseRoot: string, filePath: string): boolean;
/**
 * Normalize agent-supplied verification paths into repo-root-relative Git paths.
 * Non-git projects fall back to cwd-relative existing files; their gate full-runs.
 */
export declare function normalizeVerificationFiles(args: {
    cwd: string;
    files: readonly string[];
}): Promise<NormalizedVerificationFiles>;
//# sourceMappingURL=verification-paths.d.ts.map