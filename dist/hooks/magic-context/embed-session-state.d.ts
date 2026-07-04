import type { RecompProgress } from "./compartment-runner-types";
/** Per-session user pause for embedding drain (in-memory only). */
export declare const embedPauseBySession: Set<string>;
/** AbortController for the active embed drain per session. */
export declare const embedRunStateBySession: Map<string, AbortController>;
/** One auto-drain attempt per session per process lifetime. */
export declare const autoEmbedAttemptedBySession: Set<string>;
export type EmbedDrainUiStatus = "idle" | "running" | "paused" | "stopped";
export declare function getEmbedDrainUiStatus(sessionId: string, progress: RecompProgress | undefined): {
    status: EmbedDrainUiStatus;
    detail?: string;
};
export declare function clearEmbedSessionState(sessionId: string): void;
//# sourceMappingURL=embed-session-state.d.ts.map