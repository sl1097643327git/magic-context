import { type PluginEntryInfo } from "./types";
export declare function extractChannel(version: string | null): string;
export declare function getLocalDevVersion(directory: string): string | null;
export declare function getCurrentRuntimePackageJsonPath(currentModuleUrl?: string): string | null;
export declare function findPluginEntry(directory: string): PluginEntryInfo | null;
export declare function getCachedVersion(spec?: string | null): string | null;
export declare function updatePinnedVersion(configPath: string, oldEntry: string, newVersion: string): boolean;
export declare function getLatestVersion(channel?: string, options?: {
    registryUrl?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}): Promise<string | null>;
//# sourceMappingURL=checker.d.ts.map