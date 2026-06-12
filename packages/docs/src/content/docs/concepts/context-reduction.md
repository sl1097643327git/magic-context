---
title: Context reduction
description: How the agent-facing reduction surface works — tagging, ctx_reduce, nudges, and the automatic safety nets that kick in at high pressure.
---

Context reduction is how Magic Context keeps the live conversation window small enough to stay fast and cheap. The agent marks spent tool outputs and stale messages for removal, and the system applies those drops at cache-safe moments.

## §N§ tags

Every message, file attachment, and tool output in your session gets a `§N§` tag prefix — a small numbered marker like `§42§` that identifies a trackable unit of content. Tags are the atoms of context management: the system uses them to track what's active, what's been dropped, and what's pending removal.

You see these tags in the conversation text. The agent uses them to tell `ctx_reduce` what to drop.

## ctx_reduce

The `ctx_reduce` tool lets the agent queue content for removal:

```text
ctx_reduce(drop="3-5,8,12-15")
```

Drops are **queued, not immediate**. The system applies them at the next cache-safe moment — typically when the prompt cache is already being rebuilt for other reasons. This means reduction never thrashes the cache.

Tags in the most recent conversation (the "protected tail") are deferred rather than dropped immediately, so the agent doesn't lose its bearings mid-task.

When a tag is dropped, the content is replaced with a `[dropped §N§]` placeholder. Recent drops keep a `[truncated]` skeleton so the agent can still see the shape of what was there.

## The nudge system

Magic Context nudges the agent to reduce context as pressure builds. Two channels deliver reminders:

**Channel 1 — gentle in-turn reminders.** A `<system-reminder>` is appended to tool outputs when reclaimable tool output accumulates. The severity scales with both the amount of unreduced output and how close context is to the execute threshold. Three levels escalate: gentle, firm, and urgent. A disciplined agent that reduces regularly never hears them.

**Channel 2 — ceiling nudge.** When reclaimable tool output reaches a third of the agent's usable working range, a stronger one-time synthetic message is delivered at the next step boundary. This is the "you really should reduce now" signal. It fires at most once per session.

Both channels suppress themselves after the agent calls `ctx_reduce` — no nagging an agent that's actively managing context.

## What happens without agent action

If the agent doesn't reduce and pressure keeps building, automatic safety nets kick in:

**Execute threshold.** At the configured execute threshold (default: 65% of context), the system runs heuristic cleanup: deduplicating identical tool calls, stripping system injections, and clearing old reasoning. This is routine maintenance, not an emergency.

**85% — tiered emergency drop.** At 85% usage, a target-headroom eviction kicks in. Tool outputs are dropped oldest-first across three tiers: miscellaneous tools first (bash, web), then edit/search tools, then navigation tools last. The newest 20% of navigation and edit tools are reserved as continuation context. This is a cache-busting pass — the prompt cache rebuilds, but the system was heading there anyway.

**95% — block and recover.** At 95%, the session blocks new messages and runs emergency recovery. This is the last-resort safety net. In practice, the historian and emergency drop prevent sessions from reaching this point.

:::note
These thresholds are safety nets, not the normal path. A well-behaved session with an agent that uses `ctx_reduce` stays well below the execute threshold and never triggers emergency drops.
:::

## Automatic-only mode

Set `ctx_reduce_enabled: false` in your config to remove the agent-facing reduction machinery entirely:

- No `ctx_reduce` tool
- No `§N§` tag prefixes in message text
- No nudges

The deterministic parts keep running: the historian still compresses, heuristic drops still fire, compartments still inject, and memory still works. Stale tool output is shed automatically by age.

This mode is for users who want a fully automatic pipeline. You can optionally enable caveman text compression to recover some of the benefit that manual `ctx_reduce` provides for long user and assistant text. See the [configuration reference](/reference/configuration/) for the setting.

See [session modes](/concepts/session-modes/) for the full feature comparison across modes.

## How it connects

Context reduction is the agent's side of the [context pipeline](/concepts/overview/). The [historian](/concepts/historian/) handles the background side — compressing what reduction leaves behind. The [cache architecture](/concepts/cache-architecture/) ensures that drops and compartment renders don't thrash the prompt cache.
