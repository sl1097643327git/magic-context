---
title: Dreamer
description: The off-hours maintenance agent that consolidates memory, verifies facts against code, and keeps project documentation current.
---

The dreamer is an optional background agent that runs during idle time to maintain memory quality and project documentation. It spins up ephemeral child sessions, each focused on one maintenance task, and works through them in sequence.

## When it runs

The dreamer runs on a configurable schedule, defaulting to a window between 2:00 AM and 6:00 AM. A 12-hour cooldown per project prevents re-enqueuing within the same schedule window. You can also trigger a run manually at any time with `/ctx-dream`.

:::tip
The dreamer pairs well with local or inexpensive models. Nobody is waiting — it runs while you sleep or work on something else.
:::

## The task suite

The dreamer runs up to five tasks per session, in order:

| Task | What it does |
|------|-------------|
| **Consolidate** | Find semantically duplicate memories and merge each cluster into one canonical entry. |
| **Verify** | Check memories against the current codebase — paths, configs, patterns — and update or archive stale ones. |
| **Archive stale** | Retire memories about removed features, old paths, or low-signal facts that waste the injection budget. |
| **Improve** | Rewrite verbose or narrative memories into terse, operational form. |
| **Maintain docs** | Keep `ARCHITECTURE.md` and `STRUCTURE.md` at the project root synchronized with codebase changes. |

The default task list includes the first four. Add `"maintain-docs"` to your `dreamer.tasks` config to enable documentation maintenance. Each task has a configurable timeout (default: 20 minutes).

## Optional phases

After the main task suite, the dreamer can run additional phases:

**User-memory review.** When `dreamer.user_memories.enabled` is true (the default), the historian extracts behavioral observations about how you work — communication style, review focus, working patterns. The dreamer reviews these candidates with a multi-session recurrence gate and promotes recurring patterns to stable user memories. These inject into every session as a `<user-profile>` block.

:::caution
User memories are a privacy-sensitive feature. They capture observations about your behavior. The pipeline is gated behind an explicit enable flag and only runs when the dreamer is active.
:::

**Smart-note evaluation.** If you've created smart notes (notes with open-ended surface conditions via `ctx_note`), the dreamer evaluates whether their conditions have come true and surfaces the ready ones.

**Key-file identification.** When `dreamer.pin_key_files.enabled` is true (off by default), the dreamer identifies frequently-read project files and pins them into a `<key-files>` block that injects into the conversation. This gives the agent instant access to files it reads repeatedly.

## Documentation maintenance

The maintain-docs task reads your codebase and writes or updates two files at the project root:

- **`ARCHITECTURE.md`** — layers, data flows, entry points, and key abstractions.
- **`STRUCTURE.md`** — directory layout, naming conventions, and where to add new code.

When `dreamer.inject_docs` is true (the default), these files inject into the conversation so the agent always has current architectural context. The dreamer checks `git log` since the last run to focus on what changed.

## Cost and model selection

The dreamer uses your configured dreamer model (or fallback chain) and reads your codebase during verification and doc maintenance. Each task spawns a child session with its own context window. Budget accordingly — a full dream run with all five tasks can be several API calls.

Because it runs during idle time, the dreamer is a good fit for local models, even slow ones. Configure the model in `magic-context.jsonc` under `dreamer.model`.

## Circuit breaker

The dreamer aborts remaining tasks after three consecutive identical-error failures, surfacing a circuit-breaker entry in the run history. This prevents a misconfigured model or broken environment from burning through the full task suite.

## How it connects

The dreamer maintains the [project memory](/concepts/memory/) that the [historian](/concepts/historian/) builds. It runs on a schedule independent of your sessions. Its output feeds back into the [context pipeline](/concepts/overview/) — better memories mean better recall, and maintained docs mean the agent always has current architecture context.
