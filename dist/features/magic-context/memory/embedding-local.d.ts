import type { EmbeddingProvider, EmbeddingPurpose } from "./embedding-provider";
export declare function isNativeRuntimeMissingError(error: unknown): boolean;
export declare class LocalEmbeddingProvider implements EmbeddingProvider {
    readonly modelId: string;
    readonly maxInputTokens: number;
    private readonly model;
    private pipeline;
    private initPromise;
    private inFlight;
    private disposing;
    private disposePromise;
    private readonly inFlightWaiters;
    constructor(model?: string, maxInputTokens?: number);
    initialize(): Promise<boolean>;
    private waitForInFlightToDrain;
    private finishInFlight;
    embed(text: string, signal?: AbortSignal, _purpose?: EmbeddingPurpose): Promise<Float32Array | null>;
    embedBatch(texts: string[], signal?: AbortSignal, _purpose?: EmbeddingPurpose): Promise<(Float32Array | null)[]>;
    dispose(): Promise<void>;
    isLoaded(): boolean;
}
//# sourceMappingURL=embedding-local.d.ts.map