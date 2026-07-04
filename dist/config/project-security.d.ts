/**
 * Security hardening for PROJECT-level (repo-supplied, untrusted) config.
 *
 * A project config lives inside a repository the user cloned. Opening a repo
 * must never let that repo's config escalate privilege or exfiltrate secrets.
 * These helpers run on the raw project config BEFORE/AFTER it is merged over the
 * trusted user config, mutating the relevant object in place and returning
 * human-readable warnings.
 *
 * Shared by both harnesses (OpenCode `config/index.ts` and Pi
 * `config/index.ts`) so the trust boundary is identical cross-harness.
 */
/**
 * Strip unsafe fields from a raw PROJECT config IN PLACE, before it is merged
 * over the user config. Returns warnings describing what was ignored.
 *
 * Closes:
 *  - `auto_update` — a repo must not suppress plugin self-updates (which can
 *    carry security fixes).
 *  - `language`: a repo must not inject prompt text through a user preference.
 *  - `sqlite` — `sqlite.cache_size_mb` / `mmap_size_mb` become PRAGMAs on the
 *    process-global shared DB handle (one connection across every project in the
 *    process). A cloned repo could set a huge value to exhaust host memory /
 *    address space — a resource-exhaustion vector with no legitimate per-repo
 *    use. Honor user-level config only.
 *  - `embedding.endpoint` / `embedding.provider` — a repo must not choose
 *    where private memory/search/commit text is embedded. User-level config is
 *    the trust boundary for embedding destinations.
 *  - hidden-agent `prompt`/`permission`/`tools` — a repo must not reprogram or
 *    re-permission the historian/dreamer/sidekick.
 */
export declare function stripUnsafeProjectConfigFields(projectRaw: Record<string, unknown>): string[];
export declare function dropInheritedEmbeddingKeyOnRedirect(projectRaw: Record<string, unknown>, mergedRaw: Record<string, unknown>, userRaw?: Record<string, unknown>): string[];
//# sourceMappingURL=project-security.d.ts.map