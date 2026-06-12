# Workspaces call-site inventory (plugin side)

Generated from grep over `packages/plugin/src` and `packages/pi-plugin/src` for:
`getMemoriesByProject`, `getMaxMemoryId`, `getMemoryMutationsForRender`,
`getMaxMemoryMutationId`, `readNewMemoriesForM1`, `searchMemoriesFTS`, and
`getProjectMemoryEpoch`.

Test-only call sites are intentionally omitted below; they exercise the single-project primitives directly unless named as new workspace regressions.

## packages/plugin

| File:line | Call | Status | Justification |
| --- | --- | --- | --- |
| `src/hooks/magic-context/inject-compartments.ts:320` | `getMemoriesByProject` in legacy `prepareCompartmentInjection` | gated-single-identity | Legacy v1 compartment injection path uses the existing `memory_block_cache` contract. The m[0]/m[1] path below is the workspace-aware path; single-project bytes stay unchanged here. |
| `src/hooks/magic-context/inject-compartments.ts:870` | local `getMaxMemoryId` helper definition | gated-single-identity | Preserved for the byte-identity path. Workspace callers use `getMaxMemoryIdForProjects`. |
| `src/hooks/magic-context/inject-compartments.ts:900` | local `getProjectMemoryEpoch` helper definition | gated-single-identity | Preserved for the byte-identity path. Workspace HARD decisions compare `computeWorkspaceEpochFingerprint`. |
| `src/hooks/magic-context/inject-compartments.ts:925` | `getProjectMemoryEpoch` in `readCurrentM0SnapshotMarkers` | converted | Workspace marker also records `workspaceFingerprint`; `mustMaterialize` compares fingerprint when `identities.length > 1`, plain epoch otherwise. |
| `src/hooks/magic-context/inject-compartments.ts:933` | `getMaxMemoryId` in `readCurrentM0SnapshotMarkers` | converted | Workspace branch uses `getMaxMemoryIdForProjects(expandedIdentities)`, single branch calls original helper. |
| `src/hooks/magic-context/inject-compartments.ts:939` | `getMaxMemoryMutationId` in `readCurrentM0SnapshotMarkers` | converted | Workspace branch uses `getMaxMemoryMutationIdForProjects(expandedIdentities)`, single branch unchanged. |
| `src/hooks/magic-context/inject-compartments.ts:1501` | `getMemoriesByProject` in `materializeM0` | converted | Workspace branch reads `getMemoriesByProjects(expandedIdentities)` and applies source attribution/fair trim; single branch unchanged. |
| `src/hooks/magic-context/inject-compartments.ts:1589` | `getMaxMemoryId` in Phase-3 stale read | converted | Workspace branch uses union max; single branch unchanged. |
| `src/hooks/magic-context/inject-compartments.ts:1596` | `getMaxMemoryMutationId` in Phase-3 stale read | converted | Workspace branch uses union max; single branch unchanged. |
| `src/hooks/magic-context/inject-compartments.ts:1828` | `getMemoryMutationsForRender` in memory-updates | converted | Workspace branch uses `getMemoryMutationsForRenderByProjects(expandedIdentities)`, single branch unchanged. |
| `src/hooks/magic-context/inject-compartments.ts:1887` | `readNewMemoriesForM1` in `renderM1WithMetadata` | converted | Workspace branch uses `readNewMemoriesForM1Union(expandedIdentities)`, single branch unchanged. |
| `src/hooks/magic-context/inject-compartments.ts:2187` | `getMemoriesByProject` in `renderFreshM0NonPersisted` | converted | Workspace fallback reads union memories and applies attribution/fair trim; single fallback unchanged. |
| `src/features/magic-context/search.ts:392` | `searchMemoriesFTS` | converted | Workspace branch uses `searchMemoriesFTSUnion(expandedIdentities)`; single branch unchanged. |
| `src/features/magic-context/search.ts:516` | `getMemoriesByProject` | converted | Workspace branch uses `getMemoriesByProjects(expandedIdentities)`; single branch unchanged. |
| `src/tools/ctx-memory/tools.ts:376` | `getMemoriesByProject` for `list` | gated-single-identity | `list` remains a project-local/dreamer maintenance listing; requested widening is update/archive visibility. |
| `src/hooks/magic-context/m0-token-breakdown.ts:98` | `getMemoriesByProject` cold-start token estimate | gated-single-identity | Token sidebar falls back only before m[0] exists; materialized m[0] is measured from bytes. It is not a render/tool/search behavior path. |
| `src/hooks/magic-context/compartment-runner-incremental.ts:349` | `getMemoriesByProject` for historian prompt context | gated-single-identity | Historian memory extraction remains session-own-project scoped; workspace rendering/search/tool visibility does not change write/extraction scope. |
| `src/features/magic-context/memory/storage-memory.ts:534` | union helper calls `getMemoriesByProject` when arity=1 | gated-single-identity | Intentional byte-identity short-circuit. |
| `src/features/magic-context/memory/storage-memory-fts.ts:88` | union helper calls `searchMemoriesFTS` when arity=1 | gated-single-identity | Intentional byte-identity short-circuit. |
| `src/features/magic-context/storage-memory-mutation-log.ts:181` | union helper calls `getMemoryMutationsForRender` when arity=1 | gated-single-identity | Intentional byte-identity short-circuit. |
| `src/features/magic-context/storage-memory-mutation-log.ts:214` | union helper calls `getMaxMemoryMutationId` when arity=1 | gated-single-identity | Intentional byte-identity short-circuit. |

## packages/pi-plugin

| File:line | Call | Status | Justification |
| --- | --- | --- | --- |
| `src/inject-compartments-pi.ts:815` | `getMaxMemoryMutationId` in current markers | converted | Workspace branch uses `getMaxMemoryMutationIdForProjects(expandedIdentities)`, single branch unchanged. |
| `src/inject-compartments-pi.ts:976` | `getMemoriesByProject` in direct `renderM0Pi` | converted | Workspace branch uses `getMemoriesByProjects(expandedIdentities)` with source attribution/fair trim; single branch unchanged. |
| `src/inject-compartments-pi.ts:1145` | `getMemoriesByProject` in frozen m[0] inputs | converted | Workspace branch reads union memories in the frozen transaction; single branch unchanged. |
| `src/inject-compartments-pi.ts:1166` | `getMaxMemoryMutationId` in frozen markers | converted | Workspace branch uses union max; single branch unchanged. |
| `src/inject-compartments-pi.ts:1487` | `getMemoryMutationsForRender` in Pi memory-updates | converted | Workspace branch uses `getMemoryMutationsForRenderByProjects(expandedIdentities)`, single branch unchanged. |
| `src/inject-compartments-pi.ts:1586` | `getMemoriesByProject` for Pi new memories | converted | Workspace branch uses `readNewMemoriesForM1Union(expandedIdentities)`, single branch unchanged for byte identity. |
| `src/inject-compartments-pi.ts:2203` | `getMemoriesByProject` for result memory count | converted | Workspace branch counts `getMemoriesByProjects(expandedIdentities)`, single branch unchanged. |
| `src/tools/ctx-memory.ts:347` | `getMemoriesByProject` for `list` | gated-single-identity | `list` remains project-local maintenance; update/archive are widened to workspace visibility. |
| `src/pi-historian-runner.ts:426` | `getMemoriesByProject` in historian runner | gated-single-identity | Historian extraction/prompting remains session-own-project scoped; workspace visibility is render/search/tool-time only. |

## Definitions and tests

The primitive definitions (`storage-memory.ts`, `storage-memory-fts.ts`, `storage-memory-mutation-log.ts`) and their unit tests deliberately continue to call the single-project APIs. New union helpers have arity-1 short-circuits so un-workspaced callers keep the exact existing SQL/order/bytes.
