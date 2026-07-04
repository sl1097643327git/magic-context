/**
 * OpenCode adapter for the harness-agnostic transcript interface.
 *
 * This is a thin proxy over OpenCode's `MessageLike[]` (i.e. `{ info,
 * parts: unknown[] }[]`) — it does NOT copy data. Mutations through
 * `setText`/`setToolOutput`/`replaceWithSentinel` write directly into
 * the source `parts[]` arrays, exactly as the existing OpenCode-only
 * transform code does today. `commit()` is a no-op because OpenCode's
 * AI SDK reads `parts[]` back from the same array we mutated.
 *
 * This module is the boundary that lets the rest of the transform code
 * (which moves to use the Transcript interface in 4b.2) work both for
 * OpenCode and Pi without branching on harness type. By the end of 4b
 * the only OpenCode-aware code in the plugin is this file plus
 * `messages-transform.ts`.
 *
 * ## Mutation contract recap
 *
 * Magic Context's transform mutates message parts in three ways:
 *
 *  1. **Tag prefix injection** — prepends `§N§ ` to text parts and
 *     tool result outputs. Repeated tagging is idempotent because
 *     `prependTag` strips any existing prefix first.
 *
 *  2. **Sentinel replacement** — when a queued drop fires, the part is
 *     replaced with a `[dropped §N§]` or `[truncated §N§]` placeholder.
 *     The original tag number is preserved so the agent's mental
 *     model of "what was here" survives.
 *
 *  3. **Structural noise stripping** — `step-start`/`step-finish`
 *     wrappers and similar structural metadata are replaced with empty
 *     sentinel parts so they don't consume tag numbers or get tagged
 *     themselves.
 *
 * The OpenCode adapter implements (1) and (2) by editing `part.text` /
 * `part.state.output` in place. For (3), structural parts surface as
 * `kind: "structural"` so callers can filter them out. Adapter does NOT
 * itself perform stripping — that's the transform pipeline's job, called
 * after the adapter wraps the messages.
 *
 * Step 4b.1 ships the adapter alone. The existing OpenCode transform
 * code keeps using `MessageLike[]` directly until 4b.2 migrates the
 * tagging+drops layer to use Transcript instances.
 */
import type { Transcript } from "./transcript";
/**
 * The OpenCode `MessageLike` shape. Re-declared here to avoid a circular
 * import with `tag-messages.ts` (which lives in the magic-context hooks
 * tree and depends on storage). Keeping a local minimal type also makes
 * the adapter trivially unit-testable without booting OpenCode SDK
 * types.
 *
 * MUST stay structurally compatible with `tag-messages.ts MessageLike` —
 * if that file's MessageLike adds a required field, this one needs to
 * add it too. The build will fail loudly if the shapes diverge.
 */
export interface OpenCodeMessageLike {
    info: {
        id?: string;
        role?: string;
        sessionID?: string;
    };
    parts: unknown[];
}
/**
 * Wrap an existing `MessageLike[]` as a Transcript. Zero copies — every
 * `TranscriptPart` returned proxies the matching entry in the source
 * `parts` array, and mutations are reflected immediately.
 */
export declare function createOpenCodeTranscript(messages: OpenCodeMessageLike[]): Transcript;
//# sourceMappingURL=transcript-opencode.d.ts.map