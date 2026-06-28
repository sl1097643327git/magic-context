import { homedir } from "node:os";
import { join } from "node:path";

/** Stock OpenCode install location (~/.opencode/bin), OS-specific binary name. */
export function resolveStockOpenCodeBinary(): string {
    const isWindows = process.platform === "win32";
    return isWindows
        ? join(homedir(), ".opencode", "bin", "opencode.exe")
        : join(homedir(), ".opencode", "bin", "opencode");
}
