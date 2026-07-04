import { type ToolDefinition } from "@opencode-ai/plugin";
import type { Database } from "../../shared/sqlite";
export interface CtxReduceToolDeps {
    db: Database;
    protectedTags: number;
    getSessionTokens?: (sessionId: string) => number;
}
export declare function createCtxReduceTools(deps: CtxReduceToolDeps): Record<string, ToolDefinition>;
//# sourceMappingURL=tools.d.ts.map