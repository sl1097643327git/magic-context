import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseJsonc } from "comment-json";

import { log } from "../../shared/logger";
import { getCurrentRuntimePackageJsonPath } from "./checker";
import { CACHE_DIR, PACKAGE_NAME } from "./constants";
import { PackageJsonSchema } from "./types";

/**
 * package-lock.json shape (npm v7+) — minimal subset we need.
 * Both `dependencies` (legacy) and `packages` (modern) entry forms are present.
 */
interface PackageLockfile {
    dependencies?: Record<string, unknown>;
    packages?: Record<string, unknown>;
}

interface AutoUpdateInstallContext {
    installDir: string;
    packageJsonPath: string;
}

function warn(message: string): void {
    log(`WARN: ${message}`);
}

function stripPackageNameFromPath(pathValue: string, packageName: string): string | null {
    let current = pathValue;
    for (const segment of [...packageName.split("/")].reverse()) {
        if (basename(current) !== segment) return null;
        current = dirname(current);
    }
    return current;
}

/**
 * Remove our package's entries from package-lock.json so the next `npm install`
 * recomputes them fresh against the new version spec in package.json.
 *
 * Earlier this code targeted bun.lock (we used to spawn `bun install`).
 * OpenCode actually installs plugins with npm, so it generates package-lock.json
 * — keeping bun.lock handling around would have been dead code that diverged
 * from OpenCode's installer behavior.
 */
function removeFromPackageLock(installDir: string, packageName: string): boolean {
    const lockPath = join(installDir, "package-lock.json");
    if (!existsSync(lockPath)) return false;

    try {
        const lock = parseJsonc(readFileSync(lockPath, "utf-8")) as PackageLockfile;
        let modified = false;

        // npm v7+ stores entries under `packages` keyed by `node_modules/<name>`
        if (lock.packages) {
            const key = `node_modules/${packageName}`;
            if (lock.packages[key] !== undefined) {
                delete lock.packages[key];
                modified = true;
            }
        }

        // Legacy `dependencies` map (npm v6 and older) — also clean it for safety
        if (lock.dependencies?.[packageName]) {
            delete lock.dependencies[packageName];
            modified = true;
        }

        if (modified) {
            writeFileSync(lockPath, JSON.stringify(lock, null, 2));
            log(`[auto-update-checker] Removed from package-lock.json: ${packageName}`);
        }

        return modified;
    } catch {
        return false;
    }
}

function ensureDependencyVersion(
    packageJsonPath: string,
    packageName: string,
    version: string,
): boolean {
    if (!existsSync(packageJsonPath)) return false;

    try {
        const raw = parseJsonc(readFileSync(packageJsonPath, "utf-8"));
        const pkgJson = PackageJsonSchema.safeParse(raw);
        if (!pkgJson.success) return false;

        const nextPackageJson = { ...pkgJson.data };
        const dependencies = { ...(nextPackageJson.dependencies ?? {}) };
        if (dependencies[packageName] === version) return true;

        dependencies[packageName] = version;
        nextPackageJson.dependencies = dependencies;
        writeFileSync(packageJsonPath, JSON.stringify(nextPackageJson, null, 2));
        log(
            `[auto-update-checker] Updated dependency in package.json: ${packageName} → ${version}`,
        );
        return true;
    } catch (err) {
        warn(`[auto-update-checker] Failed to update package.json dependency: ${String(err)}`);
        return false;
    }
}

function removeInstalledPackage(installDir: string, packageName: string): boolean {
    const packageDir = join(installDir, "node_modules", packageName);
    if (!existsSync(packageDir)) return false;

    rmSync(packageDir, { recursive: true, force: true });
    log(`[auto-update-checker] Package removed: ${packageDir}`);
    return true;
}

export function resolveInstallContext(
    runtimePackageJsonPath: string | null = getCurrentRuntimePackageJsonPath(),
): AutoUpdateInstallContext | null {
    if (runtimePackageJsonPath) {
        const packageDir = dirname(runtimePackageJsonPath);
        const nodeModulesDir = stripPackageNameFromPath(packageDir, PACKAGE_NAME);

        if (nodeModulesDir && basename(nodeModulesDir) === "node_modules") {
            const installDir = dirname(nodeModulesDir);
            const packageJsonPath = join(installDir, "package.json");

            // Issue #73: OpenCode's plugin installer extracts the npm tarball
            // into node_modules/ but doesn't materialize a root package.json
            // in the install dir. When that file is missing, seed a minimal
            // one so ensureDependencyVersion has something to rewrite and
            // npm install has a manifest to resolve from. Otherwise users see
            // "Auto-update could not prepare the active install" indefinitely.
            if (!existsSync(packageJsonPath)) {
                try {
                    writeFileSync(
                        packageJsonPath,
                        `${JSON.stringify({ private: true, dependencies: {} }, null, 2)}\n`,
                    );
                    log(
                        `[auto-update-checker] Seeded missing package.json at ${packageJsonPath} (issue #73)`,
                    );
                } catch (err) {
                    warn(
                        `[auto-update-checker] Could not seed package.json at ${packageJsonPath}: ${String(err)}`,
                    );
                    return null;
                }
            }
            return { installDir, packageJsonPath };
        }

        return null;
    }

    const legacyPackageJsonPath = join(dirname(CACHE_DIR), "package.json");
    if (existsSync(legacyPackageJsonPath)) {
        return { installDir: dirname(CACHE_DIR), packageJsonPath: legacyPackageJsonPath };
    }

    return null;
}

export function preparePackageUpdate(
    version: string,
    packageName: string = PACKAGE_NAME,
    runtimePackageJsonPath: string | null = getCurrentRuntimePackageJsonPath(),
): string | null {
    try {
        const installContext = resolveInstallContext(runtimePackageJsonPath);
        if (!installContext) {
            warn("[auto-update-checker] No install context found for auto-update");
            return null;
        }

        if (!ensureDependencyVersion(installContext.packageJsonPath, packageName, version))
            return null;

        const packageRemoved = removeInstalledPackage(installContext.installDir, packageName);
        const lockRemoved = removeFromPackageLock(installContext.installDir, packageName);

        if (!packageRemoved && !lockRemoved) {
            log(
                `[auto-update-checker] No cached package artifacts removed for ${packageName}; continuing with updated dependency spec`,
            );
        }

        return installContext.installDir;
    } catch (err) {
        warn(`[auto-update-checker] Failed to prepare package update: ${String(err)}`);
        return null;
    }
}

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
export async function runNpmInstallSafe(
    installDir: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | null = null;

    try {
        if (options.signal?.aborted) return false;
        // Use --no-audit --no-fund --no-progress to keep output minimal and
        // avoid noisy network calls during background auto-updates.
        // stdio: "ignore" (not "pipe"): we never read npm's output, and an
        // unread "pipe" deadlocks — once npm writes more than the ~64KB OS pipe
        // buffer it blocks on the write forever, the child never exits, and we
        // spuriously hit the timeout below. Discarding the streams avoids the
        // deadlock; failure is still detected via the exit code.
        const proc = spawn("npm", ["install", "--no-audit", "--no-fund", "--no-progress"], {
            cwd: installDir,
            stdio: "ignore",
        });

        const abortProcess = () => {
            try {
                proc.kill();
            } catch {
                // best-effort
            }
        };
        options.signal?.addEventListener("abort", abortProcess, { once: true });

        const exitPromise = new Promise<boolean>((resolveExit) => {
            proc.on("error", () => resolveExit(false));
            proc.on("exit", (code) => resolveExit(code === 0));
        });
        const timeoutPromise = new Promise<"timeout">((resolveTimeout) => {
            timeout = setTimeout(() => resolveTimeout("timeout"), options.timeoutMs ?? 60_000);
        });
        const result = await Promise.race([exitPromise, timeoutPromise]);
        options.signal?.removeEventListener("abort", abortProcess);

        if (result === "timeout" || options.signal?.aborted) {
            abortProcess();
            return false;
        }

        return result;
    } catch (err) {
        warn(`[auto-update-checker] npm install error: ${String(err)}`);
        return false;
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}
