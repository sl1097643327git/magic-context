interface AutoUpdateInstallContext {
    installDir: string;
    packageJsonPath: string;
}
export declare function resolveInstallContext(runtimePackageJsonPath?: string | null): AutoUpdateInstallContext | null;
export declare function preparePackageUpdate(version: string, packageName?: string, runtimePackageJsonPath?: string | null): string | null;
/**
 * Run `npm install` in the install dir to materialize the dependency version
 * we just rewrote. Earlier versions used `bun install`, but OpenCode itself
 * installs plugins via npm (the install dir always contains package-lock.json,
 * never bun.lock), so calling npm matches the existing lockfile shape and
 * avoids generating a parallel bun.lock that drifts from OpenCode's view.
 *
 * The default timeout is 60s — long enough for a typical reinstall over a
 * mediocre network, short enough that a stuck install doesn't pin the plugin
 * process. Caller can override.
 */
export declare function runNpmInstallSafe(installDir: string, options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
}): Promise<boolean>;
export {};
//# sourceMappingURL=cache.d.ts.map