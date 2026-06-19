---
title: Dreamer
description: The off-hours maintenance agent that consolidates memory, verifies facts against code, and keeps project documentation current.
---

The dreamer is an optional background agent that runs during idle time to maintain memory quality and project documentation. It spins up ephemeral child sessions, each focused on one maintenance task.

## When it runs

Each dreamer task runs on its **own cron schedule** — there is no single dreamer "run." A process-wide timer checks every task's schedule and runs the ones that are due. You can also trigger a run manually at any time with `/ctx-dream` (all enabled tasks) or `/ctx-dream <task>` (one specific task, run immediately).

Schedules are standard 5-field cron expressions, or `""` to disable a task:

| Cron | Meaning |
|------|---------|
| `0 3 * * *` | Every day at 3:00 AM (the default for memory tasks) |
| `0 3 * * 0` | Every Sunday at 3:00 AM |
| `0 */6 * * *` | Every 6 hours |
| `0 * * * *` | Every hour |
| `""` | Disabled (still runnable manually via `/ctx-dream <task>`) |

:::tip
The dreamer pairs well with local or inexpensive models. Nobody is waiting — it runs while you sleep or work on something else.
:::

## The tasks

The dreamer has eight tasks, each independently scheduled:

| Task | Default | What it does |
|------|---------|-------------|
| **consolidate** | nightly | Find semantically duplicate memories and merge each cluster into one canonical entry. |
| **verify** | nightly | Check memories against the current codebase — paths, configs, patterns — and update or archive stale ones. |
| **archive-stale** | nightly | Retire memories about removed features, old paths, or low-signal facts that waste the injection budget. |
| **improve** | nightly | Rewrite verbose or narrative memories into terse, operational form. |
| **maintain-docs** | off | Keep `ARCHITECTURE.md` and `STRUCTURE.md` at the project root synchronized with codebase changes. |
| **review-user-memories** | nightly | Promote recurring behavioral observations into your `<user-profile>` (privacy-sensitive — see below). |
| **key-files** | off | Pin frequently-read project files into a `<key-files>` block injected into the conversation. |
| **evaluate-smart-notes** | nightly | Check whether any smart-note conditions (`ctx_note` with a surface condition) have come true and surface the ready ones. |

Each task has its own schedule, an optional per-task model override (falling back to the dreamer-level model), and a timeout (default: 20 minutes). The four memory-mutating tasks (consolidate, verify, archive-stale, improve) share a per-project lease so they never run concurrently against the same memory store; the others run independently.

Configure all of this under `dreamer.tasks` in `magic-context.jsonc`, or visually in the dashboard config editor.

## Privacy: user-memory review

The **review-user-memories** task is privacy-sensitive. When scheduled, the historian extracts behavioral observations about how you work — communication style, review focus, working patterns — and this task reviews those candidates with a multi-session recurrence gate, promoting recurring patterns to stable user memories that inject into every session as a `<user-profile>` block.

:::caution
This task captures observations about your behavior. It only runs when you explicitly schedule it (set its schedule to `""` to turn it off, which is honored across upgrades).
:::

## Documentation maintenance

The maintain-docs task reads your codebase and writes or updates two files at the project root:

- **`ARCHITECTURE.md`** — layers, data flows, entry points, and key abstractions.
- **`STRUCTURE.md`** — directory layout, naming conventions, and where to add new code.

When `dreamer.inject_docs` is true (the default), these files inject into the conversation so the agent always has current architectural context. The dreamer checks `git log` since the last run to focus on what changed.

## Cost and model selection

The dreamer uses your configured dreamer model (and any `fallback_models` you set) and reads your codebase during verification and doc maintenance. Each task spawns a child session with its own context window. Budget accordingly — when several tasks come due together, each is a separate run.

Because it runs during idle time, the dreamer is a good fit for local models, even slow ones. Configure the default model in `magic-context.jsonc` under `dreamer.model`, or override it per task with `dreamer.tasks.<task>.model`.

## Circuit breaker

The dreamer aborts remaining tasks after three consecutive identical-error failures, surfacing a circuit-breaker entry in the run history. This prevents a misconfigured model or broken environment from burning through the full task suite.

## How it connects

The dreamer maintains the [project memory](/concepts/memory/) that the [historian](/concepts/historian/) builds. It runs on a schedule independent of your sessions. Its output feeds back into the [context pipeline](/concepts/overview/) — better memories mean better recall, and maintained docs mean the agent always has current architecture context.
