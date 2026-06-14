import type { ContextDatabase } from "../../features/magic-context/storage";
import {
    getPendingOps,
    getTagsBySession,
    removePendingOp,
    updateTagDropMode,
    updateTagStatus,
} from "../../features/magic-context/storage";
import type { TagEntry } from "../../features/magic-context/types";
import { stripSystemInjection } from "./system-injection-stripper";
import type { TagTarget } from "./tag-messages";
import { stripTagPrefix } from "./tag-part-guards";

// Max characters kept from the original user content when a user-message tag
// is dropped. ~250 characters maps to ~50 Claude tokens (1 token ≈ 4-5 chars
// for English prose). Keeps the ai-tokenizer dependency in scripts only.
const USER_DROP_PREVIEW_CHARS = 250;

/**
 * Agent-initiated (ctx_reduce) drops of a tool call within the newest N tool
 * calls keep a structural skeleton — the tool_use/tool_result pair survives
 * with `[truncated]` content — instead of being removed outright.
 *
 * WHY: when every recent tool call vanishes from the wire, models (especially
 * smaller ones) lose the anchors showing what they actually did and start
 * hallucinating fake tool-call shapes (the §N§ cargo-culting failure mode).
 * Keeping skeletons in the recent band structurally prevents that class.
 * Older drops still remove the full structure — deep history needs no anchors.
 *
 * CACHE SAFETY: the mode is decided once, at drop time (always a
 * cache-busting pass), persisted in `tags.drop_mode`, and replayed
 * byte-identically by `applyFlushedStatuses` on every later pass. A skeleton
 * is NEVER demoted to a full drop afterwards — that second mutation would be
 * a mid-prefix rewrite on some later pass (the volatile-boundary bust class).
 * Emergency drops and heuristic dedup stay full-drop: emergency wants max
 * reclaim on an already-busting pass, and dedup keeps the newest duplicate's
 * full content as the nearby anchor.
 */
const RECENT_TOOL_SKELETON_WINDOW = 20;

/**
 * Build the replacement content for a dropped message tag.
 *
 * Assistant messages (and unknown-role messages) get a full `[dropped §N§]`
 * placeholder — these are typically tool chatter / plugin-generated content
 * where preserving a preview has no value.
 *
 * User messages get a truncated preview instead of a full drop. Rationale:
 *   1. Dropping a user message entirely and then stripping its shell would
 *      collapse the turn boundary, causing the AI SDK's Anthropic adapter to
 *      merge consecutive assistants around it. That merged block can contain
 *      signed thinking blocks whose signature no longer matches the merged
 *      content, triggering: "thinking or redacted_thinking blocks in the
 *      latest assistant message cannot be modified" (400 from Anthropic).
 *   2. User messages often start with the actual question or command, with
 *      bulky paste content following. Preserving the first ~50 tokens keeps
 *      that intent visible while still reclaiming the bulk.
 *
 * The truncation format uses `[truncated §N§]` so downstream code can detect
 * it (unlike `[dropped §N§]`, it does NOT match DROPPED_PLACEHOLDER_PATTERN
 * and therefore is never stripped from the message list).
 */
export function buildReplacementContent(tagId: number, target: TagTarget): string {
    const role = target.message?.info.role;
    if (role !== "user") {
        return `[dropped \u00a7${tagId}\u00a7]`;
    }

    const currentContent = target.getContent?.() ?? "";

    // A system-injected user message (todo continuation, skill reminder, etc.)
    // that strips to empty is canonicalized to `[dropped §N§]` — the SAME bytes
    // heuristic-cleanup writes when it drops such a message on an execute pass.
    // Without this, the execute pass writes `[dropped]` while this replay (which
    // runs on every pass, including defer) re-derives `[truncated …]` from the
    // raw rebuilt content, flipping one block of message[0] on the next defer
    // pass and busting the prompt-cache prefix. Both paths must agree byte-for-
    // byte. (heuristic-cleanup.ts uses the identical strip+empty predicate.)
    const strippedInjection = stripSystemInjection(currentContent);
    if (strippedInjection !== null && stripTagPrefix(strippedInjection).trim().length === 0) {
        return `[dropped \u00a7${tagId}\u00a7]`;
    }

    // Strip the §N§ tag prefix the tagger prepends so we truncate the actual
    // user text, not the tag marker.
    const originalText = stripTagPrefix(currentContent);

    if (originalText.length <= USER_DROP_PREVIEW_CHARS) {
        // Text is already short — preserve it as-is (just mark that the tag
        // was dropped so context budgeting accounting stays consistent).
        return `[truncated \u00a7${tagId}\u00a7]\n${originalText}`;
    }

    // Cut at the nearest whitespace boundary within the last 30 chars of the
    // preview window to avoid slicing mid-word.
    const hardCut = originalText.slice(0, USER_DROP_PREVIEW_CHARS);
    const softCutIndex = hardCut.search(/\s\S*$/);
    const preview =
        softCutIndex > USER_DROP_PREVIEW_CHARS - 30 ? hardCut.slice(0, softCutIndex) : hardCut;

    return `[truncated \u00a7${tagId}\u00a7]\n${preview}\u2026`;
}
export function applyPendingOperations(
    sessionId: string,
    db: ContextDatabase,
    targets: Map<number, TagTarget>,
    protectedTags: number = 0,
    preloadedTags?: TagEntry[],
    preloadedPendingOps?: ReturnType<typeof getPendingOps>,
): boolean {
    let didMutateMessage = false;
    db.transaction(() => {
        const tags = preloadedTags ?? getTagsBySession(db, sessionId);
        const tagStatusById = new Map(tags.map((tag) => [tag.tagNumber, tag.status] as const));
        const tagTypeById = new Map(tags.map((tag) => [tag.tagNumber, tag.type] as const));
        const protectedTagIds =
            protectedTags > 0
                ? new Set(
                      tags
                          .filter((tag) => tag.status === "active")
                          .map((tag) => tag.tagNumber)
                          .sort((left, right) => right - left)
                          .slice(0, protectedTags),
                  )
                : new Set<number>();

        const pendingOps = preloadedPendingOps ?? getPendingOps(db, sessionId);

        // Newest-K tool calls at THIS moment — the skeleton window. Computed
        // once per apply pass over all tool tags (any status: the window
        // reflects conversation recency, not droppability).
        const skeletonWindow = new Set(
            tags
                .filter((tag) => tag.type === "tool")
                .map((tag) => tag.tagNumber)
                .sort((left, right) => right - left)
                .slice(0, RECENT_TOOL_SKELETON_WINDOW),
        );

        for (const pendingOp of pendingOps) {
            const tagStatus = tagStatusById.get(pendingOp.tagId);
            if (tagStatus === "compacted" || tagStatus === "dropped") {
                removePendingOp(db, sessionId, pendingOp.tagId);
                continue;
            }

            if (protectedTagIds.has(pendingOp.tagId)) {
                continue;
            }

            const target = targets.get(pendingOp.tagId);
            const isToolTag = tagTypeById.get(pendingOp.tagId) === "tool";

            if (isToolTag) {
                if (skeletonWindow.has(pendingOp.tagId)) {
                    const truncResult = target?.truncate?.() ?? "absent";
                    if (truncResult === "incomplete") {
                        continue;
                    }
                    if (truncResult === "truncated") {
                        didMutateMessage = true;
                    }
                    updateTagDropMode(db, sessionId, pendingOp.tagId, "truncated");
                } else {
                    const dropResult = target?.drop?.() ?? "absent";
                    if (dropResult === "incomplete") {
                        continue;
                    }
                    if (dropResult === "removed") {
                        didMutateMessage = true;
                    }
                    updateTagDropMode(db, sessionId, pendingOp.tagId, "full");
                }
            } else if (target) {
                const changed = target.setContent(buildReplacementContent(pendingOp.tagId, target));
                if (changed) didMutateMessage = true;
            }

            updateTagStatus(db, sessionId, pendingOp.tagId, "dropped");
            removePendingOp(db, sessionId, pendingOp.tagId);
        }
    })();
    return didMutateMessage;
}

export function applyFlushedStatuses(
    sessionId: string,
    db: ContextDatabase,
    targets: Map<number, TagTarget>,
    preloadedTags?: TagEntry[],
): boolean {
    let didMutateMessage = false;
    const tags = preloadedTags ?? getTagsBySession(db, sessionId);

    for (const tag of tags) {
        if (tag.status === "dropped") {
            const target = targets.get(tag.tagNumber);
            if (tag.type === "tool") {
                if (tag.dropMode === "truncated") {
                    const truncResult = target?.truncate?.() ?? "absent";
                    if (truncResult === "truncated") {
                        didMutateMessage = true;
                    }
                } else {
                    const dropResult = target?.drop?.() ?? "absent";
                    if (dropResult === "removed") {
                        didMutateMessage = true;
                    }
                }
            } else if (target) {
                const changed = target.setContent(buildReplacementContent(tag.tagNumber, target));
                if (changed) didMutateMessage = true;
            }
        }
    }
    return didMutateMessage;
}
