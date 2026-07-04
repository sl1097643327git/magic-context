import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import type { Database } from "../../shared/sqlite";
type ReadMessages = (sessionId: string) => RawMessage[];
type ReadSingleMessage = (sessionId: string, messageId: string) => RawMessage | null;
export declare function scheduleReconciliation(db: Database, sessionId: string, readMessages: ReadMessages): void;
export declare function scheduleIncrementalIndex(db: Database, sessionId: string, messageId: string, readSingleMessage: ReadSingleMessage): void;
export declare function scheduleClearAndReindex(db: Database, sessionId: string, readMessages: ReadMessages): void;
export declare function isSessionReconciled(sessionId: string): boolean;
export declare function clearSessionTracking(sessionId: string): void;
export declare function __resetMessageIndexAsyncForTests(): void;
export {};
//# sourceMappingURL=message-index-async.d.ts.map