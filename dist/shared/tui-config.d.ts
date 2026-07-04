/**
 * Configure tui.json with the magic-context TUI plugin entry.
 *
 * Called ONLY from the CLI setup wizard and `doctor` (via the core export) —
 * never at plugin startup. Startup injection would re-add the entry on every
 * launch, so a user who deliberately removed the sidebar could never keep it
 * removed; opting in/out of the sidebar is the user's call, made explicitly
 * through setup or doctor.
 */
/**
 * Ensure tui.json has the magic-context TUI plugin entry.
 * Creates tui.json if it doesn't exist. Silently skips if already present.
 */
export declare function ensureTuiPluginEntry(): boolean;
//# sourceMappingURL=tui-config.d.ts.map