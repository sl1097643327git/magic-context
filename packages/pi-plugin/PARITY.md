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

Pi has no `makeSentinel` empty-text-part wire path; the empty-part-sentinel
provider gate is OpenCode-only by construction.

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
  prepends from its "all messages resolved" denominator. OpenCode messages all
  have intrinsic `info.id`, so it has no such id-less injected messages to exclude.
- **Dynamic `upgradeState`:** Pi derives `upgradeState` from the presence of
  legacy compartments at runtime.

---

## 9. ctx_reduce nudges — same effect, different delivery mechanism

The ctx_reduce nudge system (Channels 1 & 2) shares ALL metric math with OpenCode
via `@magic-context/core/.../ctx-reduce-nudge` (`decideChannel1`, `computePressure`,
`shouldTriggerChannel2`, both reminder builders, `tailToolTokensFromStrings`). Only
the harness I/O differs:

- **Channel 1 (in-turn tool-output nudge).** OpenCode appends the
  `<system-reminder>` to a tool's `output.output` string in `tool.execute.after`;
  Pi appends a `TextContent` block to `toolResult.content[]` in
  `pi.on("tool_result")` (returning `{ content: [...event.content, block] }`). Both
  persist (OpenCode→DB, Pi→JSONL via `appendMessage` on `message_end`) and replay
  verbatim — "free sticky", no anchor/CAS/replay machinery. The metric baseline is
  computed at the end of the pipeline (`pi.on("context")` / OpenCode transform) and
  read in the tool hook. The cadence/band state (`last_nudge_undropped` +
  `last_nudge_level`) is shared DB state so both harnesses suppress same-band
  repetition and reset after `ctx_reduce`. Pi tool output lives in
  `toolResult.content[].text`, not OpenCode's `parts[].state.output` —
  `computeTailToolTokensPi` extracts it, then defers to the shared
  `tailToolTokensFromStrings`.

- **Channel 2 (hidden ceiling nudge).** OpenCode MUST use a live-server
  `createOpencodeClient(serverUrl)` + `/session` probe to dodge the plugin
  runner-split bug (anomalyco/opencode#28202); Pi just calls the native
  `pi.sendMessage({ customType, content, display:false, details }, { deliverAs })`.
  **Pi has no #28202 workaround, no live-server client, and no probe** — it is
  single-process, so the message coalesces natively and lands at the tail after
  the current turn. **Hidden-render divergence (same intent, different mechanism):**
  OpenCode marks its promptAsync part `synthetic: true` (skips OC core's
  queued-message wrapper + the #129 flip-bust, drops from the user-message render,
  still model-visible); Pi has no such wrapper, so it achieves the same
  "model-visible but not a literal user turn" via a `sendMessage` custom message
  with `display:false` (Pi converts `role:"custom"`→user message for the model
  via convertToLlm, renders only when `display:true`). Neither presents the nudge
  as a user turn. The shared `channel2_nudge_state` lease
  (pending→claimed→delivered, TTL-scoped stale-claim heal, revert only on send
  failure) is used identically for the one-ceiling-per-lifetime cap; only the
  delivery call differs. Both
  deliver MID-TURN at step boundaries (the point
  of the channel: warn while the pile grows): OpenCode from `message.updated`
  (finish=tool-calls OR stop, queued message drains at the next run-loop step);
  Pi primarily from `tool_result` with deliverAs "steer" (queued, pulled at the
  next step), with `agent_end` + "followUp" as the idle fallback.

- **Removed in this redesign (both harnesses):** the rolling/iteration nudge
  (`nudger`/`injectPiNudge`/`nudge-injector.ts`) and the tool-heavy sticky reminder
  (`applyStickyTurnReminder`, `setPersistedStickyTurnReminder`, the `<instruction
  name="ctx_reduce_turn_cleanup">` text). Pi's now-removed `recordPiToolExecution`
  / `toolUsageSinceUserTurn` tracking backed only the deleted sticky reminder.
  Note-nudges and auto-search hints are UNCHANGED (still append to user messages
  via `appendReminderToUserMessageByIdPi`).

---

## 9b. Pi floors persisted pressure with live forward usage

**OpenCode:** pressure is refreshed per step through `message.updated` /
`step-finish`, so a tool-heavy turn sees context usage climb before the next
request is assembled. OpenCode also performs its own step-finish overflow check,
so no explicit forward floor is needed in the shared pressure path.

**Pi:** `message_end` persists `lastContextPercentage` only after the whole turn.
During a long multi-step turn that value can stay frozen while the live
`AgentMessage[]` grows. Pi therefore floors both scheduler and historian trigger
pressure with `ctx.getContextUsage().tokens`, which is recomputed from the live
message array each context pass.

The floor scales only the forward-pressure denominator (`contextLimit × 0.85`)
to compensate for Pi's estimate-token undercount. It does **not** mutate the real
context limit, and it passes the raw forward token count onward so emergency drop
planning still sees the current assembled size. The floor is monotonic: it never
lowers the persisted pressure, and missing/null forward usage preserves the old
behavior. Earlier Channel 1/2 ctx_reduce nudges can result because their
usable/reclaimable math consumes the same corrected input-token reading; those
nudges are persisted/replayed like the rest of Pi's sticky context hints.

Emergency drops remain cache-stable: repeated force passes on the same provider
usage sample are latched by `last_emergency_input_sample`, fresh same-turn
forward growth may force another pass, and a no-candidate force pass leaves wire
bytes unchanged.

---

## 10. Cleared reasoning keeps its original signature (matches OpenCode)

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

## 11b. Recomp / upgrade run detached in the background (mechanism differs, behaviour matches)

`/ctx-recomp` and `/ctx-session-upgrade` run DETACHED on both harnesses — the
REPL/TUI stays responsive while the multi-pass historian recomp runs — but the
mechanism differs because the process models differ:

- **OpenCode** runs `void runManagedRecomp(...)` / `void runManagedUpgrade(...)`
  in its separate server process; the TUI client keeps accepting input and shows
  a live progress bar via RPC polling.
- **Pi** is a single-process REPL where the command handler IS the turn, so an
  inline `await` froze all input. Pi instead spawns the recomp via
  `spawnPiRecompRun` (mirroring `spawnPiHistorianRun`): the handler returns
  immediately after the ack message, the run is tracked in an in-flight map for
  `session_shutdown` drain, and progress surfaces through `[ctx-status]`
  messages + the `recomp` status-line flag.

Because Pi's recomp runs in the background (not inside the user's turn), its
post-publish signals are the DEFERRED variants (`signalPiDeferredHistoryRefresh`
/ `signalPiDeferredMaterialization`) and the compaction marker is STAGED (pending
blob + deferred drain), never applied eagerly — exactly like the background
historian's `onPublished`. Eager signals / eager marker apply would force a
materialization (or mutate `getBranch()`) on whatever transform pass is running,
possibly mid-turn, busting the cache.

## 11. Work-metrics: Pi folds the in-memory wire array; OpenCode computes lazily in RPC

The TUI/status "work metrics" (new-work / total-input tokens) are a display-only
value. The two harnesses compute it from different sources, so the cost profiles
differ and the fixes differ:

- **Pi** (`context-handler.ts`) calls `computePiWorkMetrics(outputMessages)` — a
  fold over the already-in-memory wire array, bounded by the on-wire message
  count. It is cheap per pass and stays where it is.
- **OpenCode** previously called `computeOpenCodeWorkMetrics` on every transform
  pass — a window-function `json_extract` scan over EVERY assistant row of the
  session in OpenCode's DB (O(session age); ~250ms/pass at 47K rows). That was
  removed from the transform hot path. OpenCode now computes it lazily and
  incrementally in `buildSidebarSnapshot` (the only consumer) via
  `computeOpenCodeWorkMetricsIncremental` + a per-process watermark carry.

Pi does NOT need the incremental watermark machinery because its source is the
bounded wire array, not an ever-growing DB table. Do not "port" the OpenCode
lazy/incremental path to Pi — it would be solving a cost Pi does not have.

## 12. m[0] upgrade-state marker: both harnesses are dynamic (parity)

Both harnesses derive a per-session m[0] upgrade-state marker dynamically and use
it as a HARD-bust trigger so an upgraded session re-materializes m[0]. OpenCode
computes `getUpgradeState`; Pi computes `${PI_M0_UPGRADE_STATE}:${legacy|ready}`
from the presence of legacy compartments at render time
(`inject-compartments-pi.ts`), and the materialize stale-check compares it
(`current.upgradeState !== snapshotMarkers.upgradeState`).

This is **parity**, not a divergence. (Earlier revisions of this doc described
Pi's marker as a pinned constant — that is stale: Pi gained its own legacy→v2
`/ctx-session-upgrade` flow and the marker was made dynamic to refold m[0] when a
session crosses from legacy to upgraded. Pi's detached recomp/upgrade —
divergence #11b — additionally re-signals materialization through its own path.)

---

## 13. Instance-disposal cleanup: OpenCode `server.instance.disposed`, Pi `session_shutdown`

OpenCode wires the SDK `server.instance.disposed` event to an orderly per-instance
cleanup (stop the RPC server, unregister the dream-schedule timer, abort the
auto-update controller), gated on the disposed `directory` resolving to the
instance's own project identity (Desktop runs many instances per process, each
disposed independently). Pi has no `server.instance.disposed` event — it does the
equivalent teardown in its existing `session_shutdown` handler (drain in-flight
historian, etc.). Neither harness disposes the native ONNX embedding session on
teardown: forcing onnxruntime-node's destructor makes the Bun N-API exit crash
worse (tracked upstream at oven-sh/bun#30291); the OS reclaims that memory on exit.

---

## Schema-fence rejection surface

When the shared cross-harness `context.db` is migrated to a schema newer than
this binary supports, `openDatabase()` fail-closes (returns null) and the plugin
disables itself. Both harnesses log the reason. The **user-facing** surface
differs by necessity:

- **OpenCode** sends an ignored chat message via `sendSchemaFenceWarning`
  (Desktop has no visible console, so a silent disable would be invisible to the
  user). Gated on `getSchemaFenceRejection()`.
- **Pi** emits a terminal `warn()` only. Pi's fence check runs at extension
  init, before any session `ctx`/`ctx.ui` exists (it early-returns before
  registering hooks), and Pi always runs in a terminal where the log line is
  directly visible — so the OpenCode "invisible disable" failure mode does not
  apply. Adding a chat-surface warning would require deferring the fence check
  past hook registration, which contradicts fail-closed-before-any-work.

Same effective behavior (fail closed + tell the user); different delivery
because only OpenCode Desktop can hide the log.

---

## 14. Context-limit source: OpenCode reads the SDK; Pi reads its own runtime

Neither harness reads OpenCode's `models.json` (models.dev) file anymore — that
redundant read produced torn-read garbage (a 6748 "limit" for a session that had
run for hours) and let a stale on-disk copy out-vote the live auth-resolved cap
(922k vs the real Codex-OAuth 400k). Each harness now resolves the limit from its
own authoritative runtime source, then bounds it to a sane `[20k, 3M]` range
(shared `isSaneLimit`):

- **OpenCode** warms `apiCache` from the SDK `config.providers()` (OpenCode's
  fully-resolved config: models.dev + snapshot + opencode.json + auth-plugin
  caps), persisted for cold-start. `getSdkContextLimit()` returns the SDK value
  or `undefined`. Pi never warms `apiCache`, so for Pi that getter is unused.
- **Pi** resolves from its own runtime: `getContextUsage().contextWindow`,
  falling back to `ctx.model.contextWindow` (available at model-select, before
  any message). The detected-overflow limit still overrides both. This is Pi's
  equivalent of OpenCode's SDK — instant and auth-correct — so Pi does not call
  `getSdkContextLimit`/`resolveContextLimit`/`resolveTrustedContextLimit` at all.

Same effective behavior (authoritative per-harness limit, sane-bounded, overflow
override); different source because each harness exposes the resolved window
through a different API. Pi resolves that window once per trigger evaluation and
uses the same value for the trigger budget, boundary snapshot, and historian
runner stale-snapshot check; when the trigger re-resolves a scaled boundary, the
runner receives that trigger snapshot rather than the earlier probe snapshot.

---

## 15. HARD-bust tool-set hash: Removed on both harnesses

The m[0]/m[1] materialization decision (`mustMaterialize` / `mustMaterializePi`)
folds m[1] into m[0] on a HARD bust — a provider-side cache-eviction event where
the prompt cache was already dead, so folding is "free". The HARD trigger set is
identical across harnesses: model/provider change, system-prompt-hash change,
and idle>TTL.

The tool-set hash trigger was previously used to detect tool changes, but was
removed on both harnesses because the signal is process-global and produced
false-positive folds. Pi and OpenCode now both operate without this trigger.

---

## 16. Emergency-recovery disarm: Pi disarms inline; OpenCode uses a counter escape

Both harnesses face the same hazard: `needs_emergency_recovery` armed by an
overflow that the user then resolves (e.g. `/ctx-recomp`), leaving a session at
low real pressure with a non-runnable tail. The flag must not keep force-bumping
pressure to 95% forever, but it MUST stay armed for a *genuine* overflow whose
tail is one in-progress arc (the window becomes runnable once the arc closes).

- **OpenCode** keeps the flag armed and stops only the disruptive bump via a
  counter escape: `recovery_no_eligible_head_count >= RECOVERY_NO_HEAD_LIMIT (2)`
  (`transform.ts`, `protected-tail-boundary.ts`). It never auto-clears; the flag
  is cleared by a successful historian publish, a model switch, or a successful
  `/ctx-recomp` (runManagedRecomp "done").

- **Pi** does NOT increment that counter, so it disarms inline instead: inside
  `maybeFireHistorian`'s no-fire branch, when recovery is armed, no historian is
  in flight, there is no runnable compartment window, AND **real** pressure
  (`usage.percentage`, not the 95% bump) is `< FORCE_MATERIALIZATION_PERCENTAGE`
  → clear the flag. The low-pressure gate is what makes this safe: a genuine
  overflow arc sits near the limit, so it stays armed (matching OpenCode's
  intent); only a stale flag (post-recomp ~20%) disarms.

Both also clear the flag on a successful `/ctx-recomp` (OpenCode runManagedRecomp
"done"; Pi `result.published`) — the recomp IS the overflow resolution.

---

## Maintenance

Update this file whenever a deliberate Pi↔OpenCode divergence is introduced or
changed. Point audit/council/Oracle briefs at it so intentional divergences are
not re-reported as bugs each round.

---

## 8. Protected-tail true-raw parity is text + tool I/O only

**OpenCode:** raw session reads preserve full provider part JSON, including
reasoning/thinking and image payload metadata. The protected-tail true-raw
estimator can count those categories directly.

**Pi:** transcript shaping deliberately drops thinking parts and image payloads
before the shared protected-tail core sees the folded OpenCode-shaped messages.
Pi still preserves text and tool invocation/result I/O, so protected-tail sizing,
tool-arc fencing, and historian eligibility are parity-tested for those fields.

**Consequence:** thinking/image token parity is a known provider-shape divergence
and is deferred. Tests should assert text + tool-I/O parity and separately track
Pi's expected undercount for thinking/images rather than treating it as a silent
regression.
