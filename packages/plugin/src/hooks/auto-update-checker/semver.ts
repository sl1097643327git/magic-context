/**
 * Strict semver validator for the auto-update path.
 *
 * The plugin version string flows from the npm registry / dist-tags into
 * package.json's dependency spec before `npm install`. A malformed or crafted
 * value (`npm:@evil/pkg@1.0.0`, `file:/tmp/x`, `git+ssh://...`) must never be
 * written there — this is the arbitrary-package-install / SSRF guard.
 *
 * Lives in its own leaf module (no imports beyond this) so both `cache.ts` and
 * `checker.ts` can use it without creating a circular import between them
 * (`cache.ts` imports `checker.ts` for the runtime package.json path; if
 * `checker.ts` also imported this from `cache.ts`, the cycle breaks static
 * export resolution on a cold module graph — CI / fresh installs — even though
 * a warm bun cache tolerates it).
 */
export function isValidSemver(version: string): boolean {
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}
