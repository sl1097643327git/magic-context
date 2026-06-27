import { execSync } from "node:child_process";
import { isOpenCodeInstalledOnSystem } from "./opencode-install";

export function isOpenCodeInstalled(): boolean {
    return isOpenCodeInstalledOnSystem();
}

export function getOpenCodeVersion(): string | null {
    try {
        return execSync("opencode --version", { stdio: "pipe" }).toString().trim();
    } catch {
        return null;
    }
}

export function getAvailableModels(): string[] {
    try {
        const output = execSync("opencode models", { stdio: "pipe" }).toString().trim();
        return output
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}


