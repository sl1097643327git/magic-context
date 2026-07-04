/**
 * Resolve from the in-memory transform message array (preferred — free).
 * Caches the verdict on first resolution.
 */
export declare function resolveCtxReduceAvailabilityFromMessages(sessionId: string, messages: ReadonlyArray<{
    info?: {
        role?: string;
        tools?: unknown;
    };
}>): boolean;
/**
 * Resolve from the OpenCode DB (system-prompt hook path — may run before the
 * transform has seen any messages). Falls back to "available" when the DB is
 * absent (Pi-only installs) or the read fails.
 */
export declare function resolveCtxReduceAvailability(sessionId: string): boolean;
export declare function clearCtxReduceAvailability(sessionId: string): void;
//# sourceMappingURL=ctx-reduce-availability.d.ts.map