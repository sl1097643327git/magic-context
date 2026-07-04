import type { DreamerConfig, SidekickConfig } from "../../config/schema/magic-context";
import { type DreamTaskName } from "../../features/magic-context/dreamer/task-registry";
import type { ManualRunResult } from "../../features/magic-context/dreamer/task-scheduler";
import type { PluginContext } from "../../plugin/types";
import type { Database } from "../../shared/sqlite";
import { type PartialRecompRange } from "./compartment-runner-partial-recomp";
import type { NotificationParams } from "./send-session-notification";
/** Parse `/ctx-recomp` arguments.
 *
 *  Accepted forms:
 *  - empty / whitespace-only → full recomp
 *  - `<start>-<end>`         → partial recomp with explicit inclusive range
 *  - `--upgrade`            → upgrade legacy compartments (dispatch stub until Wave 3)
 *
 *  Returns an error object for unparseable or nonsensical inputs. */
export declare function parseRecompArgs(raw: string): {
    kind: "full";
} | {
    kind: "partial";
    range: PartialRecompRange;
} | {
    kind: "upgrade";
} | {
    kind: "error";
    message: string;
};
export interface CommandExecuteInput {
    command: string;
    sessionID: string;
    arguments: string;
}
export interface CommandExecuteOutput {
    parts: Array<{
        type: string;
        text?: string;
    }>;
}
export type ManualDreamSummary = ManualRunResult;
export declare function createMagicContextCommandHandler(deps: {
    db: Database;
    protectedTags: number;
    executeThresholdPercentage?: number | {
        default: number;
        [modelKey: string]: number;
    };
    executeThresholdTokens?: {
        default?: number;
        [modelKey: string]: number | undefined;
    };
    historyBudgetPercentage?: number;
    commitClusterTrigger?: {
        enabled: boolean;
        min_clusters: number;
    };
    getLiveModelKey?: (sessionId: string) => string | undefined;
    /** Optional live context limit resolver — used for tokens-based threshold display. */
    getContextLimit?: (sessionId: string) => number | undefined;
    onFlush?: (sessionId: string) => void;
    /** Runs /ctx-recomp. When `range` is provided, runs partial recomp over
     *  that range (snapped to enclosing compartment boundaries). When omitted,
     *  runs full recomp from message 1 to the protected tail. */
    executeRecomp?: (sessionId: string, options?: {
        range?: PartialRecompRange;
    }) => Promise<string>;
    /** Runs the once-per-project 5-cat memory migration for /ctx-session-upgrade.
     *  Optional: when unavailable, /ctx-session-upgrade still upgrades compartments
     *  via recomp and skips the memory re-evaluation. */
    runUpgrade?: (sessionId: string) => Promise<string>;
    /** `/ctx-embed start` — backfill this session's compartment embeddings. */
    executeEmbedHistory?: (sessionId: string, options?: {
        signal?: AbortSignal;
        silent?: boolean;
    }) => Promise<string>;
    pauseEmbedDrain?: (sessionId: string) => string;
    getEmbedStatusText?: (sessionId: string) => string;
    sendNotification: (sessionId: string, text: string, params: NotificationParams) => Promise<void>;
    /** Configured toast lifetime (ms) forwarded into diagnostics logs. */
    toastDurationMs?: number;
    sidekick?: {
        config: SidekickConfig;
        projectPath: string;
        sessionDirectory?: string;
        client: PluginContext["client"];
        language?: string;
    };
    dreamer?: {
        config: DreamerConfig;
        projectPath: string;
        /** Dreamer v2 manual `/ctx-dream` entry — runs tasks now via the per-task
         *  scheduler (one forced task, or all enabled). Wired in hook.ts. */
        runManual: (task?: DreamTaskName) => Promise<ManualRunResult>;
    };
}): {
    "command.execute.before": (input: CommandExecuteInput, _output: CommandExecuteOutput, _params: NotificationParams) => Promise<void>;
};
//# sourceMappingURL=command-handler.d.ts.map