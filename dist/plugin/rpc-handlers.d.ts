/**
 * Server-side RPC handlers. Queries the server's own SQLite DB
 * and returns typed responses for TUI consumption.
 */
import type { MagicContextConfig } from "../config/schema/magic-context";
import { type ContextDatabase as Database } from "../features/magic-context/storage";
import type { LiveSessionState } from "../hooks/magic-context/live-session-state";
import type { MagicContextRpcServer } from "../shared/rpc-server";
import type { SidebarSnapshot, StatusDetail } from "../shared/rpc-types";
export declare function buildSidebarSnapshot(db: Database, sessionId: string, directory: string, liveSessionState?: LiveSessionState, injectionBudgetTokens?: number, config?: Record<string, unknown>): SidebarSnapshot;
export declare function buildStatusDetail(db: Database, sessionId: string, directory: string, modelKey?: string, config?: Record<string, unknown>, liveSessionState?: LiveSessionState, injectionBudgetTokens?: number): StatusDetail;
/**
 * Register all RPC handlers on the server.
 */
export declare function registerRpcHandlers(rpcServer: MagicContextRpcServer, args: {
    directory: string;
    config: MagicContextConfig;
    client: unknown;
    liveSessionState: LiveSessionState;
}): void;
//# sourceMappingURL=rpc-handlers.d.ts.map