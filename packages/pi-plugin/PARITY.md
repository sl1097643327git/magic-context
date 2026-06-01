# Pi ↔ OpenCode: Intentional Divergences

This document records **deliberate** differences between the Pi plugin
(`packages/pi-plugin/`) and the OpenCode plugin (`packages/plugin/src/hooks/magic-context/`).

**For auditors (human, Oracle, or council):** the items below are NOT bugs. They
are architectural consequences of how Pi differs from OpenCode. Do not flag them
as parity gaps. If you believe one is wrong, argue against the *rationale* here —
don't just report "Pi differs from OpenCode."

The two implementations share a single SQLite DB (`cortexkit/magic-context`) and
the same `packages/plugin/src` core (storage, decay rendering, tag-transcript,
search). They must produce the **same effective behavior** (cache stability,
overflow protection, decay tiers), but the *mechanism* differs where the host
runtimes differ. "Same effective behavior, different mechanism" is the rule.

---

## 1. Pi has no native subagents → no reduced-mode (`fullFeatureMode`) gate

**OpenCode:** users spawn native subagents (via `task()`), which share the
plugin process and reach `experimental.chat.messages.transform`. OpenCode gates
historian / m[0]m[1] injection / nudges / auto-search behind `fullFeatureMode`
(i.e. `!isSubagent`), and detects subagents via OpenCode's `session.parent_id`.

**Pi:** Pi has **no native subagent concept**. The *only* subagents that exist
are the ones Magic Context itself spawns (historian, dreamer, sidekick), and each
runs as a **separate `pi --print` process** loading only the lean
`subagent-entry.js`, whose recursion guard **never wires `pi.on("context")`**
(see `subagent-entry.ts` header). A Pi subagent therefore *cannot* reach the
context-handler pipeline at all.

**Consequence:** `is_subagent` is **never written `true`** for any Pi session.
There is nothing to gate, so Pi does NOT need OpenCode's `fullFeatureMode`
reduced-mode enforcement in `context-handler.ts`. The vestigial `!isSubagent`
checks that exist in the Pi context handler are harmless (always take the
non-subagent branch); they are not the enforcement OpenCode has and adding that
gate would be dead code.

> Recurring false positive: blind councils pattern-match OpenCode's subagent
> gate onto Pi and report "reduced mode not enforced." It does not apply.

---

## 2. Placeholder stripping: Pi REMOVES (splices); OpenCode NEUTRALIZES (sentinel)

**OpenCode** (`strip-content.ts`): replaces a placeholder-only message's parts
with a single empty-text **sentinel**, leaving the message in the array so the
array length / structure stays stable for proxy caches. Safe to run discovery on
any execute pass.

**Pi** (`strip-placeholders-pi.ts`): Pi rebuilds `AgentMessage[]` from JSONL every
pass, so there is no need to preserve array structure — it **splices** the
message out entirely.

**Consequence:** Pi gates placeholder *discovery* to **history-refresh passes
only** (`args.isCacheBusting`), NOT the broader `shouldApplyPendingOps ||
shouldRunHeuristics` OpenCode uses. A freshly-dropped tool stub renders as
`[dropped §N§]`, which `isDroppedOnlyText` matches — so discovering on the *same
execute pass that created the drop* would splice out the just-dropped turn and
collapse it. Discovery is therefore deferred to the next refresh boundary;
replay still runs every pass. (This was learned the hard way — broadening the
gate to `executedWorkThisPass` caused a turn-collapse regression.)

Both harnesses **never neutralize/remove user-role messages** — they anchor turn
boundaries. In Pi's raw array tool results carry role `"toolResult"`; the
synthetic-user folds live only in the transcript *view* (never written back), so
only genuine prompts are user-role in the stripped array.

---

## 3. No `session.deleted` event → `session_before_switch` is reversible

**OpenCode:** `session.deleted` is terminal — the session is gone. OpenCode's
handler clears both in-memory maps AND durable per-session DB state.

**Pi:** Pi has no `session.deleted`. The closest event is
`session_before_switch`, which fires when the user switches *away* — but the
session can be switched back. So the Pi switch handler clears **only in-memory
maps** (the actual per-swap leak) and must **NOT** clear durable DB caches
(`cached_m0_*`, boundary). Clearing the durable m[0] cache on switch would force
a full re-materialization (cache bust) on switch-back. The DB cache is bounded
(one `session_meta` row) and self-invalidates via epoch/version/docs-hash.

`clearSession()` (full durable cleanup) only runs where Pi has a genuine terminal
signal; it is intentionally NOT wired to `session_before_switch`.

---

## 4. Pi owns compaction via `session_before_compact`

**Pi** cancels native Pi compaction (`session_before_compact` → `{cancel:true}`)
and owns the boundary itself: Magic Context stages a native compaction marker
(`pending_pi_compaction_marker_state`) and drains it on the next materializing
pass so `getBranch()` returns the compacted tail. The **wire/context trim**
(`trimPiMessagesToBoundary`) runs every injection pass **independent** of the
native JSONL marker — so even if the marker lags (e.g. a crash window), the
model-visible context is still trimmed. OpenCode uses its own
deferred-compaction-marker mechanism (`compaction-marker.ts`); the two are
mechanism-parallel, not identical.

---

## 5. Pi rebuilds `AgentMessage[]` from JSONL every pass

**Consequence:** Pi does not need OpenCode's in-place sentinel persistence for
array-shape stability. Byte-stability across defer passes is achieved by
replaying persisted state (tags, dropped-status, `stripped_placeholder_ids`,
note/sticky anchors, caveman depth, `source_contents`) deterministically each
pass. The transcript adapter's `commit()` writes part-level mutations back into
the source array for dirty indices only.

---

## 6. Transient UI: Pi uses `ctx.ui.notify` toasts, not persistent dialogs

**OpenCode:** TUI dialogs (upgrade prompt, `/ctx-status`, `/ctx-recomp`) via RPC,
with an ignored-message fallback for Desktop/Web. Notification drain is
**session-scoped** (a notification tagged for one session never surfaces in
another) because one process can serve multiple sessions and TUI port discovery
is newest-pid-wins.

**Pi:** transient terminal notifications. The upgrade reminder passes
`deliveryPersists=false` on Pi, so it does NOT durably stamp `upgrade_reminded_at`
on display (the toast vanishes, leaving no scrollback) — it re-prompts each Pi
start until the session is actually upgraded. OpenCode (persistent chat message)
stamps on send.

---

## 7. Storage & process model

- Pi sessions are JSONL (`~/.pi/agent/sessions/*.jsonl`); OpenCode uses its own
  SQLite DB. Both write the *shared* Magic Context DB, tagged with a `harness`
  discriminator on session-scoped tables.
- Pi subagents spawn via `PiSubagentRunner` (`pi --print --mode json`). Large
  prompts (> ~96 KiB, e.g. a 50K-token historian chunk) are delivered via piped
  **stdin** (Pi concatenates stdin + positional) to avoid Linux `MAX_ARG_STRLEN`
  / E2BIG; the positional is omitted when piping.
- `--no-session` keeps subagent JSONL out of the user's session picker.

---

## 8. Pi-only mechanisms (no OpenCode counterpart)

- **`synth-user-<realId>` folding:** Pi folds runs of `toolResult` entries into a
  synthetic user message (the toolResult→assistant transition). Tail tool-result
  runs (no following user) get a `synth-user-<firstToolResultEntryId>` id so the
  tail tool output is taggable/droppable. Consumers handle the prefix differently
  by design: compaction-boundary selection (`findFirstKeptEntryId`) **defers**
  (returns null) on a synthetic boundary; boundary trim **resolves** it to the
  underlying real entry id.
- **`pi_stable_id_scheme` (migration v25):** a one-time forced-execute cutover
  that re-keys persisted tag/drop/caveman/placeholder state from `pi-msg-<index>`
  ids to real `SessionEntry` ids. OpenCode has stable message ids natively.
- **`syntheticLeadingCount`:** anchor-GC excludes the id-less m[0]/m[1] synthetic
  prepends (and any rolling-nudge synthetic) from its "all messages resolved"
  denominator. OpenCode messages all have intrinsic `info.id`, so it has no such
  id-less injected messages to exclude.
- **Dynamic `upgradeState`:** Pi derives `upgradeState` from the presence of
  legacy compartments at runtime.

---

## 9. Cleared reasoning keeps its original signature (matches OpenCode)

When Magic Context clears an aged reasoning/thinking block, it rewrites the
thinking text to a `[cleared]` placeholder but **preserves the original
`thinkingSignature`/`thoughtSignature`**. This is INTENTIONAL and byte-for-byte
matches OpenCode's shipped `clearOldReasoning` (`strip-content.ts`), which runs
in production against Anthropic.

- Pi: `reasoning-replay-pi.ts` `setPiThinkingCleared` keeps the signature.
- OpenCode: `clearOldReasoning` keeps the signature.

Why it does NOT cause provider rejection: the cleared block is replayed only to
the SAME provider that produced the signature, and the signature still matches
the (now-placeholder) block's position in the assistant turn. Stripping the
signature would be MORE likely to trigger a rejection, not less. Do not "fix"
this by nulling the signature — that diverges from the shipped OpenCode behavior
and removes the provider's own integrity token.

---

## 10. m[1] recompute gate uses Pi pipeline work, not history-refresh flag

OpenCode gates m[1] recompute on `isCacheBustingPass` (`shouldApplyPendingOps || shouldRunHeuristics`); Pi gates on `executedWorkThisPass || rematerialized` — same effective set, different assembly.

---

## Maintenance

Update this file whenever a deliberate Pi↔OpenCode divergence is introduced or
changed. Point audit/council/Oracle briefs at it so intentional divergences are
not re-reported as bugs each round.
