/**
 * In-memory notification queue for server→TUI push.
 * Replaces SQLite plugin_messages table.
 *
 * Also tracks whether a TUI client is actively connected (polling).
 * The server plugin cannot use `process.env.OPENCODE_CLIENT` to detect TUI
 * because the server runs in a separate process from the TUI client.
 */
export interface RpcNotification {
    id: number;
    type: string;
    payload: Record<string, unknown>;
    sessionId?: string;
}
/**
 * A connected TUI notification sink — one per authenticated WebSocket. The RPC
 * server registers a sink when a TUI socket authenticates (hello) and removes
 * it on close. `send` is sink-agnostic (the server owns the actual WS socket)
 * so this module stays free of Bun/WS types.
 */
export interface NotificationSink {
    /** The TUI's active session at connect time (its hello scope). */
    sessionId?: string;
    /** Deliver one notification over this sink's live socket. */
    send: (notification: RpcNotification) => void;
}
/** Register a live TUI sink. Returns an unregister fn (call on socket close). */
export declare function registerNotificationSink(sink: NotificationSink): () => void;
/** Push a notification to the TUI. Fans out to any live WS sink immediately and
 *  also enqueues it so a TUI that is momentarily disconnected (reconnecting, or
 *  not yet connected) still receives it on its next hello via the backlog drain.
 *  At-least-once: a live push that the socket drops is re-delivered from the
 *  queue on reconnect (pruned only when the client acks via `lastReceivedId`). */
export declare function pushNotification(type: string, payload: Record<string, unknown>, sessionId?: string): void;
/** Return pending notifications after acking the client's last received id.
 *
 *  Session scoping: when `sessionId` is provided, only notifications tagged for
 *  that session (or session-less/global ones) are returned and pruned — a
 *  notification tagged for a DIFFERENT session is never handed to this client
 *  and is never pruned by this client's ack. This matters because the in-memory
 *  queue is per-process but a TUI can end up bound to a process that also serves
 *  OTHER sessions: e.g. opening OpenCode Desktop on the same project starts a
 *  newer RPC server that the TUI's port discovery (newest-pid-wins) then selects,
 *  so a Desktop-session upgrade-dialog action would otherwise surface in an
 *  unrelated TUI session. Each client also tracks its own `lastReceivedId`, so a
 *  global watermark prune would let session A's ack drop session B's still-unseen
 *  notification — scoping the prune to the acking session prevents that too.
 *
 *  Delivery is at-least-once (non-destructive return + prune-on-ack): a returned
 *  notification stays queued until a later call acks it via a higher
 *  `lastReceivedId`, so a dropped WS socket re-delivers the backlog on reconnect
 *  (the client sends its `lastReceivedId` in the hello). */
export declare function drainNotifications(lastReceivedId?: number, sessionId?: string): RpcNotification[];
/** Whether a TUI client is connected via a live notification socket.
 *  Now exact socket liveness (a registered WS sink), not a poll-drain timestamp.
 *
 *  Pass `sessionId` (preferred) to ask whether a TUI is connected FOR THAT
 *  SESSION — this is what producers (`/ctx-status`, `/ctx-recomp`, the upgrade
 *  reminder) must use to decide dialog-vs-message, so a TUI on a different
 *  session in the same process does not misroute their delivery. A session-less
 *  sink (legacy/global) counts for any session query. Omit `sessionId` only for
 *  callers with no session context; they get "any sink connected". */
export declare function isTuiConnected(sessionId?: string): boolean;
//# sourceMappingURL=rpc-notifications.d.ts.map