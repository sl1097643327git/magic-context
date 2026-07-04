import type { MagicContextPluginConfig } from "../../config";
import type { LiveSessionState } from "../../hooks/magic-context/live-session-state";
import type { PluginContext } from "../types";
/**
 * Map the full plugin config down to the per-session hook config. Pure and
 * exported so it can be unit-tested directly — without a module-level
 * `mock.module` of the hooks barrel, which in Bun leaks process-globally across
 * test files (mock.restore() does not undo it) and corrupts sibling suites that
 * import the real hook shape.
 */
export declare function buildMagicContextHookConfig(pluginConfig: MagicContextPluginConfig): {
    protected_tags: number;
    ctx_reduce_enabled: boolean;
    cache_ttl: string | {
        [modelKey: string]: string;
        default: string;
    };
    clear_reasoning_age: number;
    toast_duration_ms: number | undefined;
    execute_threshold_percentage: number | {
        [modelKey: string]: number;
        default: number;
    };
    execute_threshold_tokens: {
        [modelKey: string]: number | undefined;
        default?: number;
    } | undefined;
    historian: {
        two_pass: boolean;
        disallowed_tools: ("*" | "read" | "aft_outline" | "aft_zoom" | "aft_search")[];
        model?: string | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        prompt?: string | undefined;
        tools?: Record<string, boolean> | undefined;
        disable?: boolean | undefined;
        description?: string | undefined;
        mode?: "subagent" | "primary" | "all" | undefined;
        color?: string | undefined;
        maxSteps?: number | undefined;
        permission?: {
            edit?: "deny" | "allow" | "ask" | undefined;
            bash?: "deny" | "allow" | "ask" | Record<string, "deny" | "allow" | "ask"> | undefined;
            webfetch?: "deny" | "allow" | "ask" | undefined;
            doom_loop?: "deny" | "allow" | "ask" | undefined;
            external_directory?: "deny" | "allow" | "ask" | undefined;
        } | undefined;
        maxTokens?: number | undefined;
        variant?: string | undefined;
        fallback_models?: string | string[] | undefined;
        thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
    } | undefined;
    history_budget_percentage: number;
    historian_timeout_ms: number;
    memory: {
        enabled: boolean;
        injection_budget_tokens: number;
        auto_promote: boolean;
        retrieval_count_promotion_threshold: number;
        auto_search: {
            enabled: boolean;
            score_threshold: number;
            min_prompt_chars: number;
        };
        git_commit_indexing: {
            enabled: boolean;
            since_days: number;
            max_commits: number;
        };
    };
    sidekick: {
        timeout_ms: number;
        model?: string | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        prompt?: string | undefined;
        tools?: Record<string, boolean> | undefined;
        disable?: boolean | undefined;
        description?: string | undefined;
        mode?: "subagent" | "primary" | "all" | undefined;
        color?: string | undefined;
        maxSteps?: number | undefined;
        permission?: {
            edit?: "deny" | "allow" | "ask" | undefined;
            bash?: "deny" | "allow" | "ask" | Record<string, "deny" | "allow" | "ask"> | undefined;
            webfetch?: "deny" | "allow" | "ask" | undefined;
            doom_loop?: "deny" | "allow" | "ask" | undefined;
            external_directory?: "deny" | "allow" | "ask" | undefined;
        } | undefined;
        maxTokens?: number | undefined;
        variant?: string | undefined;
        fallback_models?: string | string[] | undefined;
        system_prompt?: string | undefined;
        thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
    } | undefined;
    dreamer: {
        tasks: {
            "map-memories": {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
            };
            verify: {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
            };
            "verify-broad": {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
            };
            curate: {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
            };
            "classify-memories": {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
            };
            retrospective: {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
            };
            "maintain-docs": {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
            };
            "evaluate-smart-notes": {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
            };
            "review-user-memories": {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                promotion_threshold?: number | undefined;
            };
            "promote-primers": {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                promotion_threshold?: number | undefined;
            };
            "refresh-primers": {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
            };
        };
        inject_docs: boolean;
        model?: string | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        prompt?: string | undefined;
        tools?: Record<string, boolean> | undefined;
        disable?: boolean | undefined;
        description?: string | undefined;
        mode?: "subagent" | "primary" | "all" | undefined;
        color?: string | undefined;
        maxSteps?: number | undefined;
        permission?: {
            edit?: "deny" | "allow" | "ask" | undefined;
            bash?: "deny" | "allow" | "ask" | Record<string, "deny" | "allow" | "ask"> | undefined;
            webfetch?: "deny" | "allow" | "ask" | undefined;
            doom_loop?: "deny" | "allow" | "ask" | undefined;
            external_directory?: "deny" | "allow" | "ask" | undefined;
        } | undefined;
        maxTokens?: number | undefined;
        variant?: string | undefined;
        fallback_models?: string | string[] | undefined;
        thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
    } | undefined;
    commit_cluster_trigger: {
        enabled: boolean;
        min_clusters: number;
    };
    system_prompt_injection: {
        enabled: boolean;
        skip_signatures: string[];
    };
    temporal_awareness: boolean;
    caveman_text_compression: {
        enabled: boolean;
        min_chars: number;
    };
};
export declare function createSessionHooks(args: {
    ctx: PluginContext;
    pluginConfig: MagicContextPluginConfig;
    liveSessionState: LiveSessionState;
}): {
    magicContext: {
        "experimental.chat.messages.transform": (_input: Record<string, never>, output: {
            messages: unknown[];
        }) => Promise<void>;
        "experimental.chat.system.transform": (input: {
            sessionID?: string;
        }, output: {
            system: string[];
        }) => Promise<void>;
        "experimental.text.complete": (_input: {
            sessionID: string;
            messageID: string;
            partID: string;
        }, output: {
            text: string;
        }) => Promise<void>;
        "chat.message": (input: {
            sessionID?: string;
            variant?: string;
            agent?: string;
            model?: {
                providerID?: string;
                modelID?: string;
            };
        }) => Promise<void>;
        event: (input: {
            event: {
                type: string;
                properties?: unknown;
            };
        }) => Promise<void>;
        "command.execute.before": (input: unknown, output: unknown) => Promise<unknown>;
        "tool.execute.after": (input: unknown, output?: unknown) => Promise<void>;
    } | null;
};
//# sourceMappingURL=create-session-hooks.d.ts.map