---
title: Dashboard
description: The Magic Context desktop app for memories, session history, cache diagnostics, dreamer, and config editing.
---

The **Magic Context Dashboard** is a Tauri desktop app that reads and writes the same SQLite store and config files as the plugin. Use it when you want to browse or fix memories, inspect compartment history, debug provider cache behavior, inspect dreamer schedules and runs, or edit `magic-context.jsonc` without hand-editing JSON in an editor.

## Install and updates

Build from source: see the dashboard `README` in the [magic-context](https://github.com/cortexkit/magic-context) repo (`packages/dashboard`). Production builds use Tauri’s updater against the project release manifest (`latest.json` on the project GitHub Pages site).

When an update is available, the app shows an **Update available** toast with **Install & Restart**. You can also use the tray **Check for Updates** action for an interactive download-and-install flow.

The plugin must have run at least once so `context.db` exists (see dashboard README for default paths on your OS).

## Mem (memories)

Cross-session **project memories**: search, filter by project/category/status, and open a detail panel.

**What you can do.**

- **Edit** content and change status (`active`, `permanent`, `archived`).
- **Archive** or **permanently delete** individual memories (delete is confirmed in the UI).
- **Bulk select** rows and **bulk archive** or **bulk delete** with confirmation.
- View metadata: category, source (`historian`, `agent`, `dreamer`, `user`), merge lineage, embeddings flag.

Changes write to the shared database; **running sessions pick up memory updates automatically** on subsequent turns without restarting the harness.

<!-- screenshot: memories-page -->

## Hist (sessions / history)

Browse OpenCode and Pi sessions: compartments, facts, notes, smart notes, token breakdown, cache events per session, and subagent stats.

**What you can do.**

- Filter by harness, project, search, and hide subagent sessions.
- Open a session and switch tabs: messages, **compartments**, facts, notes, historian runs, tokens, cache.
- **Compartment viewer:** message ranges, v2 **tiers** (`p1`–`p4`) with the same fallback chain as runtime rendering, **importance** bands (critical/high/medium/low/minimal), and episode tags.
- Edit or dismiss **session notes** and manage **smart notes** for that session.
- Edit or delete **session facts**.

Use this when `/ctx-status` is not enough and you need to read what the historian actually stored.

<!-- screenshot: sessions-compartments -->

## Cache (diagnostics)

Live **provider cache** telemetry: per-turn cache read/write, input tokens, and severity.

**How to read the timeline.**

- Each turn is a bar: **green** when cache hit ratio is high (about ≥90%), **amber** mid, **red** low — quick scan for turns that re-sent most of the prompt.
- Severity icons per turn: `stable`, `info`, `warning`, `warming`, `bust`, `full_bust`. A **bust** (red/black) means the cached prefix was largely invalidated — expect higher fresh token use on the next call.
- Expand a turn to see step-level events and bust causes recorded by the plugin.
- **Recent sessions** cards summarize hit counts and bust counts; select a session to focus the chart. **Show all** loads the cross-session corpus (heavier on large DBs). Polling can be paused.

Subagent sessions can be hidden to reduce noise.

<!-- screenshot: cache-timeline -->

## Dream (dreamer)

Per-task **schedules**, global state, and recent **runs** grouped by project.

**What you can do.**

- See each task's next scheduled run (and overdue tasks), last run time, and last failure.
- Expand a run for per-task duration, token usage, smart-note surfacing counts, and memory change breakdown (written/archived/merged).
- Trigger runs from your session with `/ctx-dream` (the dashboard reflects schedule state read-only; it does not run the dreamer itself).

<!-- screenshot: dreamer-panel -->

## User (user memories)

Experimental **user-level** memories (separate from project memory): promoted entries and **candidates** awaiting promotion.

**What you can do.**

- **Promote** a candidate into an active user memory.
- **Edit** content, **dismiss**, or **delete** promoted memories.
- **Delete** candidates you do not want promoted.

Controlled by `dreamer.user_memories.enabled` (on by default; set `false` to disable collection).

<!-- screenshot: user-memories -->

## Config

Visual editor for Magic Context JSONC: **OpenCode user**, **Pi user**, and **per-project** overrides.

**What you can do.**

- Toggle and edit fields that mirror `magic-context.schema.json` (the editor links the schema URL and parses JSONC including comments and trailing commas).
- **Save** writes real files on disk (`saveConfig` / `savePiConfig` / `saveProjectConfig` via the Tauri backend) — not a preview buffer.
- Model pickers use cached provider model lists refreshed in the background.

Use [Configuration](/reference/configuration/) for the full generated key reference; use this tab for day-to-day edits.

<!-- screenshot: config-editor -->

## Logs

Optional **log tail** for `magic-context.log` with filtering — useful alongside Cache when correlating busts with plugin log lines. Open from the sidebar **Logs** item.
