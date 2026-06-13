---
title: Commands
description: Slash commands to inspect Magic Context, flush queues, rebuild history, augment prompts, and run dreamer.
---

You run these slash commands in your harness chat or command box. They execute in the plugin, not in the model. Names are registered as `ctx-status`, `ctx-flush`, `ctx-recomp`, `ctx-aug`, `ctx-dream`, `ctx-embed-history`, and `ctx-session-upgrade` (type them with a leading `/`).

## Is something stuck?

1. **`/ctx-status`** — Pending queue, cache TTL, tags, historian state. Start here.
2. **`/ctx-flush`** — Apply queued context operations now (usually pending drops).
3. **`/ctx-recomp`** — Rebuild compartments from raw history with the historian model; slow on long sessions. Use `/ctx-recomp <start>-<end>` for a partial range when only part of the timeline is wrong.

Use **`/ctx-session-upgrade`** for legacy session format upgrades, not `/ctx-recomp --upgrade` (deprecated).

## /ctx-status

**What it does.** Session status: tags, pending queue, cache TTL, execute threshold, compartments, last transform error, and related fields.

**When to use it.** Whenever you need a snapshot of Magic Context health.

**What you'll see.**

- **OpenCode TUI:** Opens a **native status dialog** (full report is not pasted into chat).
- **OpenCode Desktop:** `## Magic Status` message in chat.
- **Pi:** **Status overlay** when UI is available; otherwise a `/ctx-status` chat message.

## /ctx-flush

**What it does.** Force-processes pending Magic Context operations for this session and refreshes injection caches. Changes apply on the **next** model message.

**When to use it.** `/ctx-status` shows pending drops that have not applied, or you do not want to wait for TTL/threshold.

**What you'll see.** `Flushed: N dropped. Changes take effect on next message.` or `No pending operations to flush.` On Pi, a `/ctx-flush` message (requires an active session).

## /ctx-recomp

**What it does.** Rebuilds compartments from raw history — structure only. Recomp never writes memories or facts, so your curated project memory is untouched. Partial runs snap your range to compartment boundaries.

**When to use it.** Wrong or missing summaries/facts, or deliberate rebuild after historian config changes.

| Argument | Meaning |
| --- | --- |
| (none) | Full rebuild to the protected tail. |
| `<start>-<end>` | Partial rebuild, e.g. `/ctx-recomp 1-11322`. |
| `--upgrade` | Deprecated — run `/ctx-session-upgrade`. |

:::caution
Uses historian-model tokens; full recomp on long sessions can take a long time.
:::

**What you'll see.**

- **OpenCode TUI:** Confirmation **dialog** for `/ctx-recomp` (typed range args are not wired through the dialog yet).
- **OpenCode Desktop:** **Double-tap** — warning first, same command within **60 seconds** confirms. Partial recomp previews the snapped range.
- **Pi:** Same double-tap confirmation; recomp runs **in the background** with `/ctx-recomp` progress messages. Partial ranges work on the command line.

## /ctx-aug

**What it does.** Runs **sidekick** on your text, optionally wraps results in `<sidekick-augmentation>`, and submits the prompt as a new user turn.

**When to use it.** You want memory-aware context prepended without pasting it yourself.

**Usage.** `/ctx-aug <your prompt>`

**What you'll see.** A short preparing notice, then the augmented prompt is sent. Requires sidekick in [Configuration](/reference/configuration/). Pi sends the original prompt if sidekick fails.

## /ctx-dream

**What it does.** Enqueues and runs the **dreamer** task list for this project immediately (memory maintenance, smart notes, and other configured tasks).

**When to use it.** Manual dreamer run instead of waiting for the schedule.

**What you'll see.** `Starting dream run...` then `## /ctx-dream` with per-task timings, or configuration/queue errors.

## /ctx-embed-history

**What it does.** Embeds **all of this session's history compartments** for semantic search in one pass, instead of waiting for the slow background backfill. Idempotent and resumable — re-running embeds only what's still missing. Runs under the project's embedding lock, so it won't collide with the passive sweep or a sibling process.

**When to use it.** After a long session, or when you want `/ctx-search` semantic recall over older history immediately. Requires an embedding provider (or the built-in local model) and `memory.enabled`.

**What you'll see.** On OpenCode, a live **Embed** progress bar in the sidebar/status (`N/M embedded`), then `Embedded N compartments of history for semantic search.` On Pi, a single `## /ctx-embed-history` completion message. If everything is already embedded: `All of this session's history is already embedded.`

## /ctx-session-upgrade

**What it does.** Upgrades **this session** to the current history layout (full recomp of legacy compartments) and runs **once-per-project** memory category migration when available.

**When to use it.** After upgrades when compartments are legacy or docs recommend upgrading session history.

**What you'll see.** `## Session Upgrade` / recomp progress in chat. Requires an attached session (send a message first if needed). Pi keeps the REPL usable while historian work runs in the background.
