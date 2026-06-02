# Audit Known Issues

This document records findings that recurring audits (Oracle, Athena council,
blind review) tend to surface but that are **accepted as-is** — either correct
by design, a deliberate tradeoff, or a bounded/negligible cost we have chosen
not to pay down yet.

**For auditors (human, Oracle, or council):** the items below are NOT bugs to
re-report. Each one has been investigated against source and a deliberate
decision was made. If you believe one is genuinely wrong, argue against the
**reasoning** recorded here — don't just re-flag "X looks suspicious."

Pi↔OpenCode mechanism differences live in `packages/pi-plugin/PARITY.md`. This
file is for cross-cutting / OpenCode-core / dashboard items.

---

## Accepted by design (not bugs)

### A1. `trimMemoriesToBudgetV2` uses `continue`, not `break`

`inject-compartments.ts` — when a memory doesn't fit the remaining budget the
loop `continue`s instead of `break`ing. This is a **greedy knapsack fill**, and
it is correct: memories are pre-sorted `permanent → importance DESC → id ASC`,
so the highest-value memories are placed first. `continue` only lets a *smaller,
lower-ranked* memory drop into leftover budget that a larger one couldn't use —
it can never displace a higher-ranked memory. `break` would waste that leftover
budget. Do not change to `break`.

### A2. `memories.importance` exists but is not yet populated

The `importance` column (migration v22, nullable `INTEGER`) is read by
`trimMemoriesToBudgetV2`'s sort, but no current write path sets it — promotion
and `ctx_memory write` leave it NULL (treated as the default 50). The sort is
therefore currently inert (it collapses to `id` order). This is intended: the
column is in place for a future historian/promotion change that scores memory
importance. A NULL/50 default is harmless until then. Do not flag the column as
"unused" or the sort as "dead."

### A3. Decay budget-guard demotes oldest-first, one step at a time

`decay-render.ts` — after the decay curve assigns tiers, a guard loop demotes
compartments until the rendered block fits the budget. It demotes the *oldest*
eligible compartment first, fully, before touching newer ones. This is a
**rarely-fired safety net** (the curve already targets the budget; the guard
only corrects estimate drift or an unusually tight budget), and oldest-first
demotion *aligns* with the decay philosophy (older history is the first to lose
fidelity). A round-robin / even-distribution demotion would add complexity for a
path that seldom runs and whose bias is already the desired one. Accepted.

### A4. `ctx_memory merge` does not enforce single-project ownership

`tools.ts` — unlike `update`/`delete`/`archive` (which guard that the target
belongs to the current project), `merge` intentionally allows cross-identity
consolidation. The merge loop supersedes each source memory under **its own**
project identity and queues a per-project supersede-delta row, so every affected
project's m[1] reconciles correctly. This is a supported dreamer capability
(see the "merging across identities" test). Do not add an ownership guard to
`merge`.

### A5. Re-observing a fact does not revive an archived memory

`getMemoryByHash` does not filter by status, so when a fact whose prior instance
was archived is re-observed, it matches the archived row, bumps its `seen_count`
(recurrence is still recorded), and does **not** re-insert or un-archive it.
Archiving is a deliberate dreamer/user suppression; a recurring mention must not
silently override curation. Revival happens only through an explicit restore
(which bumps the project epoch). Accepted; locked by a characterization test in
`promotion.test.ts`.

### A6b. `ctx_memory delete` archives rather than hard-deletes

`tools.ts` — the `delete` action calls `archiveMemory` (soft delete: sets
`status='archived'`) and queues a `delete` mutation-log row, then returns
`"Archived memory [ID: N]."`. This is a deliberate data-safety choice: a memory
the agent "deletes" is recoverable via restore, and hard-deletion is reserved
for explicit dashboard bulk-delete. The return text honestly says "Archived,"
not "Deleted," so there is no misleading success semantic. The mutation-type is
`delete` (vs `archive`) only to distinguish agent-intent in the log; both render
as "removed" in m[1]. Do not change `delete` to a hard `DELETE`.

### A6. Deferred-materialization signal can be consumed mid-turn

Both harnesses include the deferred-materialization signal in
`isCacheBustingPass` / `shouldRunHeuristics` regardless of mid-turn state, so a
background historian/recomp publish can cause an m[0]/m[1] re-render on the next
transform pass even mid-turn. This is accepted because the signal is only *set*
at safe points (publish completes atomically) and the re-render is byte-stable
when nothing material changed, so the worst case is one extra cache-busting pass,
not corruption. Tightening this to gate on `!midTurn` is a possible future
refinement, not a correctness fix. (OpenCode and Pi behave identically here.)

---

### A7. Legacy `trimMemoriesToBudget` (`break`) and `renderMemoryBlock` (v1) are dead in v2

`inject-compartments.ts` still defines `trimMemoriesToBudget` (which uses `break`,
not the V2 `continue`) and `renderMemoryBlock`, reached via
`prepareCompartmentInjection` → the postprocess `else if (pendingCompartmentInjection)`
branch. In v2 that branch is **unreachable**: `m0M1Enabled` gates on
`projectPath || projectDirectory`, and `projectDirectory` (the session directory)
is always present, so the m[0]/m[1] path always runs and owns the wire. The v1
`memory_block_cache` it would populate is not injected. Auditors flag the `break`
as under-filling vs A1's V2 `continue` — true in isolation, but the function does
not reach the wire. (`renderMemoryBlock` is still used by the historian reference
block, where it is cosmetic — dedup is content-based.) Do not "fix" the legacy
`break`; if anything, the dead v1 path is a future deletion candidate.

### A8. m[1] TTL-expiry has no `mustMaterialize` trigger (accepted cache tradeoff)

`materializeM0` snapshots active memories (some with `expires_at`) and pins the
expiry cutoff to `materializedAt`; `mustMaterialize` has no `expires_at`-based
trigger. A memory can therefore stay rendered briefly past its TTL until the next
natural materialization. This is the deliberate cache-stability tradeoff: a live
`Date.now()` expiry check would mutate m[1] bytes between defer passes and bust
the prompt cache (the exact bug fixed by freezing the cutoff). TTL precision is
sacrificed for byte-stable replay; the memory drops on the next cache-busting
pass. Do not add an expiry trigger to `mustMaterialize`.

### A9. Key-files render last-known-good content for one pass when disk drifts

`key-files-block.ts` — the render loop emits every stored `project_key_files`
row regardless of its `staleReason` (or a freshness check that just detected
drift); the freshness check only skips re-*checking* an already-stale row, never
re-*rendering* it, and the stale flag is flushed AFTER the render. So a file that
was deleted or content-drifted on disk still renders its last-known-good stored
content for one pass, then corrects on the next key-file refresh. This is the
documented design (ARCHITECTURE.md: "Injection renders only stored DB content.
Disk drift queues a CAS-protected stale update and never changes the bytes
already being rendered; stale writes do not bump the version because they do not
affect `<key-files>` output."). Skipping stale rows at render time would change
the rendered bytes every time a pinned file changed mid-session — the exact m[0]
cache bust the design avoids. Accepted.

### A10. ctx_memory non-additive mutations don't reselect or reorder m[0]

`tools.ts` — `delete`/`update`/`archive`/`merge` route through
`queueMemoryMutation` (supersede-delta m[1] rows), NOT a `project_memory_epoch`
bump, so they deliberately do not re-materialize m[0]. Two consequences are
within this accepted tradeoff:
- **Freed budget isn't reclaimed immediately.** After an archive/delete frees
  injection budget, a memory that was previously trimmed out of m[0] is not
  pulled back in until the next natural m[0] materialization. Reclaiming it
  would require re-materializing m[0] = a cache bust on a routine mutation.
- **Status-promotion reordering lags.** `merge` can promote the canonical to
  `permanent` (if any source was permanent); since selection is permanent-first
  only under budget pressure, the reorder doesn't take effect in m[0] until the
  next materialization. The canonical stays present throughout; only its
  trim-priority is briefly stale, and only under budget pressure.
Both self-heal on the next hard bust. This is the supersede-delta design: m[1]
deltas express add/remove/update, not reselection/reordering, precisely so
routine memory edits don't bust the m[0] prefix. (The dashboard differs — it
bumps the epoch on status changes — because an external editor cannot otherwise
signal a running session; see the dashboard's own path.) Accepted.

> **A8 addendum (materialize-boundary cutoff):** within a single `materializeM0`,
> the m[0] baseline memories are read with a `Date.now()` expiry cutoff a sub-ms
> before `materializedAt` is stamped, so a memory expiring in that window can
> render in m[0] one cycle past its TTL. This is the same TTL-precision-at-the-
> boundary tradeoff A8 already accepts (m[0] stays internally consistent and the
> memory drops on the next materialization); m[1]'s `id > maxMemoryId` filter
> prevents any double-render. Not a separate bug.

### A11. Key-files pickup after a Dreamer commit is lazy (next natural cache-bust), not eager

When the Dreamer commits new/updated key-files mid-session, OpenCode does NOT
force a refresh — the new `<key-files>` content is picked up on the next natural
cache-busting pass (`buildKeyFilesBlock` is re-read fresh whenever m[1] is
recomputed). This is **deliberate**: key-files live in m[1], so any pickup
necessarily rewrites the m[1] cache prefix; forcing that on every Dreamer commit
would bust the Anthropic cache for a low-urgency content change. Lazy pickup is
the chosen behavior (cache-stability over freshness for an infrequently-changing
block).

**Not a Pi divergence in v2** (the audit's "Pi eager vs OpenCode lazy" framing
predates the v2 layout): in v1, key-files lived in the system prompt and Pi's
Dreamer fired `onAdjunctsRefreshNeeded → systemPromptRefreshSessions` to refresh
it. In v2 the system block is guidance-only (`system-prompt.ts` explicitly never
emits `<key-files>`/`<project-docs>`/`<user-profile>`), and that signal targets
the **system-prompt** refresh set, NOT `historyRefreshSessions` (which drives
m[1]). So Pi also picks up key-files lazily via m[1]'s natural busts — same
effective behavior as OpenCode. Pi's lingering system-prompt refresh on Dreamer
commit is a near-no-op in v2 (guidance text doesn't change), not an extra m[1]
bust. Accepted on both harnesses.

## Growing-data factors (bounded or slow; future cleanup)

These are intentionally listed so a future cleanup/maintenance task can address
them as a batch, and so audits stop re-flagging them as "leaks."

### G1. `memory_mutation_log` and `m0_mutation_log` have no GC

Both tables grow append-only over a project's lifetime; nothing prunes old rows.
Growth is slow (one row per non-additive memory mutation / m[0]-affecting
compartment op) and the render-time reads are cursor-bounded (`id >` watermark)
and target-id-filtered, so query cost does not grow with table size — only disk
does. A future maintenance task should prune rows older than the oldest live
session's m[0] materialization cursor. Low priority.

### G2. `docsCache` (`project-docs-hash.ts`) is an unbounded `Map`

Keyed by canonical project directory → `{directoryMtimeMs, files[], cachedHash,
cachedRendered}` (the rendered `<project-docs>` block + hash + file
fingerprints). One entry per project directory the process ever rendered, each a
few KB. Bounded by the number of distinct projects in a single long-lived
process (a handful in practice), **not** by sessions or time. Negligible; not a
real leak. Documented for completeness.

---

## Deferred low-priority fixes (tracked, not yet done)

These are genuine (small) fixes that are accepted as worth doing but not yet
scheduled. They are listed here so audits know they're already triaged; an
auditor re-finding one adds no new information.

- **Pi non-UI `/ctx-status`** uses the shared `executeStatus` text and does not
  render the m[0] Docs/User-Profile/Compartments breakdown the TUI dialog shows.
  Display-only; the dialog path (the common case) is correct.
- **Dashboard bulk-restore epoch TOCTOU** (`db.rs bulk_update_memory_status`):
  `is_restore`/`is_archive` are latched from Phase-A status outside the
  transaction, and bulk restore bumps every affected identity's epoch regardless
  of each row's prior status. Worst case is a redundant epoch bump (an extra m[0]
  re-materialization), not data loss.
- **Dashboard work-metrics carry** has no invalidation on message removal (stale
  warm-start value until restart; the lazy RPC recompute self-heals on cold
  read).
- **Dashboard token breakdown** is still v1-shaped (no Docs/User-Profile buckets;
  reads the legacy `memory_block_cache`) — a display divergence from the TUI
  sidebar's v2 breakdown.
