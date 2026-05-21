/**
 * Release-notes startup announcement shared by OpenCode plugin and Pi plugin.
 *
 * Bump `ANNOUNCEMENT_VERSION` and populate `ANNOUNCEMENT_FEATURES` *only* when a
 * release ships user-facing news worth surfacing once at startup. Patch releases
 * with no user-visible changes should leave both untouched — that way a user who
 * already dismissed the dialog for the current `ANNOUNCEMENT_VERSION` won't see
 * it again on the next bugfix bump.
 *
 * The persisted state is a single line of text (`last_announced_version`) under
 * `getMagicContextStorageDir()`. OpenCode and Pi share the same file because
 * they share the same storage root — so dismissing in one harness suppresses
 * the dialog in the other for the same announcement.
 *
 * Leave both empty (`""` and `[]`) to skip the dialog entirely.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getMagicContextStorageDir } from "./data-path";

/**
 * Bump only when there are user-visible changes worth a startup dialog.
 * Does NOT need to match the published package version.
 */
export const ANNOUNCEMENT_VERSION = "0.21.7";

/**
 * Short, user-facing bullet strings. Keep each line ~80 chars or shorter so the
 * TUI dialog renders cleanly without horizontal scroll on a typical terminal.
 */
export const ANNOUNCEMENT_FEATURES: ReadonlyArray<string> = [
    "Pi parity sweep: 44 audit findings fixed, including a critical SHIP-BLOCKER where /ctx-flush did not drain the pending Pi compaction queue.",
    "Pi historian recovery fix: empty/no-op historian returns now clear emergency recovery so sessions cannot loop forever at 95%.",
    "trimPiMessagesToBoundary now sweeps non-contiguous tool-result orphans, fixing provider 400s after compaction in long Pi sessions.",
    "Hidden subagent tool isolation: historian, dreamer, and sidekick can no longer spawn subagents or run unsafe tools.",
    "TUI sidebar and /ctx-status header now show execute threshold inline: '47.5% / 65%' on the left, '475K / 1.0M' on the right.",
    "doctor --issue now caps GitHub issue bodies at ~60KB with a dedicated 'Recent errors' section so reports stay submittable.",
    "Join us on Discord: https://discord.gg/F2uWxjGnU",
];

const STATE_FILENAME = "last_announced_version";

function getStateFilePath(): string {
    return path.join(getMagicContextStorageDir(), STATE_FILENAME);
}

/**
 * Read the most recently dismissed announcement version, or `""` if none.
 *
 * Best-effort: any read failure returns `""` (which forces the announcement to
 * re-show). The cost of a spurious second dialog is much smaller than the cost
 * of suppressing a real announcement due to a transient FS error.
 */
export function readLastAnnouncedVersion(): string {
    try {
        const file = getStateFilePath();
        if (!fs.existsSync(file)) return "";
        return fs.readFileSync(file, "utf-8").trim();
    } catch {
        return "";
    }
}

/**
 * Persist `version` as the most recently dismissed announcement. Best-effort:
 * write failures are swallowed so dialog-confirm flows never throw on storage
 * errors. Worst case the user sees the same dialog once more on next startup.
 */
export function markAnnouncementSeen(version: string): void {
    if (!version) return;
    try {
        const dir = getMagicContextStorageDir();
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(getStateFilePath(), version);
    } catch {
        // best-effort
    }
}

/**
 * True when the configured `ANNOUNCEMENT_VERSION` has not yet been dismissed
 * AND there is at least one feature to show. Used by both the TUI dialog path
 * and the Desktop ignored-message fallback.
 */
export function shouldShowAnnouncement(): boolean {
    if (!ANNOUNCEMENT_VERSION || ANNOUNCEMENT_FEATURES.length === 0) return false;
    return readLastAnnouncedVersion() !== ANNOUNCEMENT_VERSION;
}
