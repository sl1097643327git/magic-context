import type { SmartNoteCapabilityApi } from "./capabilities";
import { type SmartNoteCheckResult } from "./types";
export interface RunCompiledSmartNoteCheckOptions {
    compiledCheck: string;
    capabilities: SmartNoteCapabilityApi;
    signal?: AbortSignal;
    timeoutMs?: number;
    heapLimitBytes?: number;
    stackLimitBytes?: number;
}
export interface RunCompiledSmartNoteCheckSuccess {
    ok: true;
    result: SmartNoteCheckResult;
}
export interface RunCompiledSmartNoteCheckFailure {
    ok: false;
    error: string;
    network: boolean;
}
export type RunCompiledSmartNoteCheckResult = RunCompiledSmartNoteCheckSuccess | RunCompiledSmartNoteCheckFailure;
export declare function runCompiledSmartNoteCheck(options: RunCompiledSmartNoteCheckOptions): Promise<RunCompiledSmartNoteCheckResult>;
//# sourceMappingURL=sandbox-runner.d.ts.map