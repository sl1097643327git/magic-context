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

let queue: RpcNotification[] = [];
let nextNotificationId = 1;

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

// Live sinks replace the old poll-drain-timestamp inference. "TUI connected for
// a session" is now exact socket liveness — accurate and immediate — instead of
// "did a 500ms poll drain within the last 3s". Per-session scoping still matters:
// one process can serve MANY sessions (a TUI on session A plus an OpenCode
// Desktop opened on session B for the same project, whose newer RPC server this
// TUI's port discovery then selects). Each sink carries ITS session, so a
// B-scoped producer (`/ctx-status`, upgrade reminder) only sees B's TUI as
// connected and routes its dialog there, never to A.
const sinks = new Set<NotificationSink>();

/** Register a live TUI sink. Returns an unregister fn (call on socket close). */
export function registerNotificationSink(sink: NotificationSink): () => void {
    sinks.add(sink);
    return () => {
        sinks.delete(sink);
    };
}

/** Whether a given notification may be delivered to a given sink. A global
 *  notification (no sessionId) reaches every sink; a session-scoped one reaches
 *  only sinks for that session (or session-less sinks). Mirrors the drain filter
 *  from the sink's perspective. */
function notificationMatchesSink(notification: RpcNotification, sink: NotificationSink): boolean {
    return (
        notification.sessionId === undefined ||
        sink.sessionId === undefined ||
        notification.sessionId === sink.sessionId
    );
}

/** Push a notification to the TUI. Fans out to any live WS sink immediately and
 *  also enqueues it so a TUI that is momentarily disconnected (reconnecting, or
 *  not yet connected) still receives it on its next hello via the backlog drain.
 *  At-least-once: a live push that the socket drops is re-delivered from the
 *  queue on reconnect (pruned only when the client acks via `lastReceivedId`). */
export function pushNotification(
    type: string,
    payload: Record<string, unknown>,
    sessionId?: string,
): void {
    const notification: RpcNotification = { id: nextNotificationId++, type, payload, sessionId };
    queue.push(notification);
    // Fan out to every live sink this notification is scoped to. A delivery throw
    // (dead socket mid-send) must not block other sinks or the caller.
    for (const sink of sinks) {
        if (!notificationMatchesSink(notification, sink)) continue;
        try {
            sink.send(notification);
        } catch {
            // Socket died between liveness check and send; the close handler will
            // unregister it, and the queue backlog re-delivers on reconnect.
        }
    }
    // Cap queue size to prevent unbounded growth if a TUI is not draining.
    // Session-FAIR eviction: a naive `slice(-50)` drops the globally-oldest
    // items, so a noisy session could evict ANOTHER session's single unseen
    // notification. Instead, always retain each session's newest item, then
    // fill the rest of the budget with the newest overall — no session can
    // starve another's pending dialog out of the window.
    if (queue.length > 100) {
        const newestPerSession = new Map<string | undefined, number>();
        for (const n of queue) {
            const prev = newestPerSession.get(n.sessionId);
            if (prev === undefined || n.id > prev) {
                newestPerSession.set(n.sessionId, n.id);
            }
        }
        const mustKeep = new Set(newestPerSession.values());
        const byNewest = [...queue].sort((a, b) => b.id - a.id);
        const kept: RpcNotification[] = [];
        for (const n of byNewest) {
            if (kept.length < 50 || mustKeep.has(n.id)) kept.push(n);
        }
        queue = kept.sort((a, b) => a.id - b.id);
    }
}

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
export function drainNotifications(lastReceivedId = 0, sessionId?: string): RpcNotification[] {
    const matchesClient = (notification: RpcNotification): boolean =>
        sessionId === undefined ||
        notification.sessionId === undefined ||
        notification.sessionId === sessionId;
    if (lastReceivedId > 0) {
        // Prune only notifications THIS client both owns (session-matched) and has
        // acked (id <= lastReceivedId). Other sessions' notifications survive.
        queue = queue.filter(
            (notification) => !(notification.id <= lastReceivedId && matchesClient(notification)),
        );
    }
    return queue.filter(
        (notification) => notification.id > lastReceivedId && matchesClient(notification),
    );
}

/** Whether a TUI client is connected via a live notification socket.
 *  Now exact socket liveness (a registered WS sink), not a poll-drain timestamp.
 *
 *  Pass `sessionId` (preferred) to ask whether a TUI is connected FOR THAT
 *  SESSION — this is what producers (`/ctx-status`, `/ctx-recomp`, the upgrade
 *  reminder) must use to decide dialog-vs-message, so a TUI on a different
 *  session in the same process does not misroute their delivery. A session-less
 *  sink (legacy/global) counts for any session query. Omit `sessionId` only for
 *  callers with no session context; they get "any sink connected". */
export function isTuiConnected(sessionId?: string): boolean {
    if (sinks.size === 0) return false;
    if (sessionId === undefined) return true;
    for (const sink of sinks) {
        if (sink.sessionId === undefined || sink.sessionId === sessionId) return true;
    }
    return false;
}
