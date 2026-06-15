export const CTX_EXPAND_DESCRIPTION = `Recover the original conversation from your compacted history.

Older parts of this session are summarized into <compartment> blocks inside <session-history> — e.g. <compartment start="120" end="245" title="Fixed tagger collision">. Each one replaces the raw messages in that ordinal range with a summary. When the summary isn't enough — you need exact wording, a specific value, an error message, or the reasoning behind a decision — expand the range:

ctx_expand(start=120, end=245)  ← the compartment's own start/end attributes

Returns the raw transcript as [N] U:/A: lines, capped at ~15K tokens; an oversized range returns the head and tells you where to continue. Also works with ordinals from ctx_search message results — expand a window around a hit (e.g. start=N-10, end=N+5). Ranges after the last compartment are your live tail — already visible in context, not expandable.

Two recovery modes for finer detail:
- ctx_expand(start=120, end=245, verbose=true) — lists each message SEPARATELY with its ordinal [N] and a per-part preview (each tool call shown with its output size). Use this to find the exact message or tool call you want, then recover it in full by ordinal.
- ctx_expand(message=138) — returns the FULL untruncated content of the message at that ordinal: every text part, and every tool call's complete input + output, read from stored history. This is the cheap way to get back a tool output you dropped with ctx_reduce — the original is still in storage even though the wire shows [dropped §N§]. If the message was deleted from history (session prune/revert), it says so.`;

export const CTX_EXPAND_TOKEN_BUDGET = 15_000;
