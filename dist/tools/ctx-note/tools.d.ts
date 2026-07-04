import { type ToolDefinition } from "@opencode-ai/plugin";
import type { Database } from "../../shared/sqlite";
export interface CtxNoteToolDeps {
    db: Database;
    dreamerEnabled?: boolean;
    /**
     * Resolve the project identity for the session's directory at call time.
     * See CtxMemoryToolDeps.resolveProjectPath for why this is a function.
     * Optional — when undefined, smart-note creation is rejected with an
     * explanatory error.
     */
    resolveProjectPath?: (directory: string) => string;
}
export declare function createCtxNoteTools(deps: CtxNoteToolDeps): Record<string, ToolDefinition>;
//# sourceMappingURL=tools.d.ts.map