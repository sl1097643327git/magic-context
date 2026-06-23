---
title: Session modes
description: The three effective modes Magic Context runs in, depending on agent-driven reduction and whether the session is a subagent.
---

Magic Context runs in three effective modes depending on the `ctx_reduce_enabled` config setting and whether the session is a primary session or a subagent. The mode decides which features are active, while the core tagging and cleanup plumbing stays on everywhere.

## The three modes

### Primary with ctx_reduce on (default)

The full surface. Your agent gets the `ctx_reduce` tool, sees `§N§` tags in message text, and receives nudges to reduce context as pressure builds. The historian, compartments, memory, and all prompt injections run normally.

This is the recommended mode for most users. The agent actively manages its own context, which produces better results than fully automatic cleanup because the agent knows which tool outputs it's done with.

### Primary with ctx_reduce off

The automatic-only mode. The agent-facing reduction machinery is removed:

- No `ctx_reduce` tool registered
- No `§N§` tag prefixes in message text
- No Channel 1 or Channel 2 nudges

Everything else keeps running: the historian still compresses, heuristic drops still fire at the execute threshold, compartments still inject, memory still works, and synthetic-todowrite and auto-search hints still appear.

This mode is for users who want a fully automatic pipeline. You can optionally enable caveman text compression (`caveman_text_compression.enabled`) to recover some of the benefit that manual `ctx_reduce` provides for long user and assistant text parts. See the [configuration reference](/reference/configuration/) for the setting.

### Subagent

Subagent sessions (council members, historian, sidekick, dreamer child sessions) get a lightweight pass:

- Tagging and heuristic cleanup run normally
- No historian, no compartment injection, no prompt-adjunct blocks (`<project-docs>`, `<user-profile>`)
- No deferred-note nudges
- Heuristic drops run on **every** execute pass (not once-per-turn like primary sessions — subagents are effectively one parent turn)
- Overflow is handled via the overflow detection path without emergency-recovery state

Subagents are driven by a parent agent, have bounded lifetimes, and often run in parallel. Turning on the full feature set in each subagent would create redundant work and per-agent cache churn.

## Feature comparison

| Feature | Primary + reduce on | Primary + reduce off | Subagent |
|---------|:---:|:---:|:---:|
| Tag tracking | ✓ | ✓ | ✓ |
| `§N§` tags in message text | ✓ | | |
| `ctx_reduce` tool | ✓ | | |
| Historian and compartments | ✓ | ✓ | |
| `<session-history>` injection | ✓ | ✓ | |
| `<project-docs>`, `<user-profile>` | ✓ | ✓ | |
| Channel 1 nudge (tool-output reminder) | ✓ | | ✓ |
| Channel 2 ceiling nudge | ✓ | | |
| Deferred-note nudges | ✓ | | |
| Synthetic-todowrite injection | ✓ | ✓ | |
| Auto-search hints | ✓ | ✓ | |
| Heuristic drops at execute threshold | ✓ | ✓ | ✓ |
| 85% emergency drop | ✓ | ✓ | |
| 95% block and recovery | ✓ | ✓ | |
| Caveman text compression | | opt-in | |

## When to choose ctx_reduce_enabled: false

Choose automatic-only mode when:

- You want the agent to focus entirely on the task without context-management overhead.
- Your agent doesn't respond well to nudges or ignores `ctx_reduce` calls.
- You prefer a simpler mental model where the pipeline handles everything.
- You're running sessions with models that don't support the `ctx_reduce` tool well.

The trade-off: without agent-driven reduction, stale tool outputs accumulate until the heuristic cleanup fires at the execute threshold. The automatic path is less precise than an agent that actively drops what it's done with, but it's zero-effort and the historian still compresses everything behind the scenes.

## How it connects

Session modes are a lens on the full [context pipeline](/concepts/overview/). The default mode gives the agent the [context reduction](/concepts/context-reduction/) surface. The automatic mode relies on the [historian](/concepts/historian/) and heuristic cleanup. Both modes benefit from [memory](/concepts/memory/) and the [cache architecture](/concepts/cache-architecture/).
