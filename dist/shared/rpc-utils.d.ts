export interface RpcPortFileRecord {
    port: number;
    pid: number;
    started_at: number;
    /**
     * Per-process bearer token. The server requires it on all non-health RPC
     * calls so a random local process or browser-origin script that merely
     * discovers/guesses the port cannot drive side-effecting endpoints
     * (recomp/upgrade/dismiss). Optional in the type for forward/backward
     * compatibility with port files written by older builds (treated as "no
     * auth required" only when the server itself didn't set one).
     */
    token?: string;
}
/**
 * Stable hash for a project directory — scopes RPC port files per-project
 * so multiple OpenCode instances don't collide.
 */
export declare function projectHash(directory: string): string;
/** Directory containing per-process RPC discovery files for a project. */
export declare function rpcPortDir(storageDir: string, directory: string): string;
/** Per-process RPC port file path. */
export declare function rpcPortFilePath(storageDir: string, directory: string, pid?: number): string;
/** Legacy single-port file used by v0.18.0 and earlier. */
export declare function legacyRpcPortFilePath(storageDir: string, directory: string): string;
export declare function isPidAlive(pid: number): boolean;
export declare function parseRpcPortFile(content: string, fallbackPid?: number): RpcPortFileRecord | null;
//# sourceMappingURL=rpc-utils.d.ts.map