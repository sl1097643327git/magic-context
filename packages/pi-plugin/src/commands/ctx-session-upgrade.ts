import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { isMemoryMigrationDone } from "@magic-context/core/features/magic-context/memory/memory-migration";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { COMPARTMENT_AGENT_SYSTEM_PROMPT } from "@magic-context/core/hooks/magic-context/compartment-prompt";
import { executeContextRecompWithResult } from "@magic-context/core/hooks/magic-context/compartment-runner";
import type { RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { setRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import {
	contextualizeUpgradeReason,
	extractRecompReason,
	isRecompFailure,
} from "@magic-context/core/hooks/magic-context/recomp-orchestrator";
import { describeError } from "@magic-context/core/shared/error-message";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import {
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
} from "../context-handler";
import { runPiMemoryMigration } from "../pi-memory-migration";
import { createPiHistorianClient } from "../pi-recomp-client-shared";
import { readPiSessionMessages } from "../read-session-pi";
import { setMagicContextRecompActive, updateStatusLine } from "../status-line";
import { resolveSessionId, sendCtxStatusMessage } from "./pi-command-utils";

/**
 * /ctx-session-upgrade (E6b/E6c parity with OpenCode E3.1/E3.2).
 *
 * Upgrades THIS Pi session to the v2 history format:
 *   1. Full recomp — rebuilds every legacy v1 compartment into the v2 tiered
 *      shape (recomp emits NO facts, so curated memories are untouched here).
 *   2. Memory migration — re-evaluates the project's memories into the v2
 *      5-category taxonomy (once per project, idempotent).
 *
 * Session-scoped recomp + project-scoped (once-per-project) migration. Uses the
 * historian model/runner, so it works even when the dreamer is disabled.
 */
export function registerCtxSessionUpgradeCommand(
	pi: ExtensionAPI,
	deps: {
		db: ContextDatabase;
		runner: SubagentRunner;
		historianModel: string | undefined;
		historianChunkTokens: number;
		historianFallbacks?: readonly string[];
		historianTimeoutMs?: number;
		historianThinkingLevel?: string;
		memoryEnabled: boolean;
		autoPromote: boolean;
		userMemoriesEnabled?: boolean;
	},
): void {
	pi.registerCommand("ctx-session-upgrade", {
		description:
			"Upgrade this session to the current Magic Context history format and re-organize project memories",
		handler: async (_args, ctx) => {
			const sessionId = resolveSessionId(ctx);
			if (!sessionId) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-session-upgrade",
					text: "## Session Upgrade\n\nNo active Pi session is available.",
					level: "error",
				});
				return;
			}
			if (!deps.historianModel) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-session-upgrade",
					text: "## Session Upgrade\n\nUnavailable because `historian.model` is not configured.",
					level: "error",
				});
				return;
			}

			// "Upgradable" = lacks usable v2 tiers: a pre-v2 `legacy=1` row OR a
			// malformed `legacy=0` row with no `p1` (interrupted recomp / older
			// partial-v2 build). Matching ONLY `legacy=1` would trap a session
			// whose rows are tierless-but-not-flagged-legacy (parity with
			// OpenCode runManagedUpgrade; dogfood 2026-05-30 AFT).
			const compartments = getCompartments(deps.db, sessionId);
			const upgradableCount = compartments.filter(
				(c) => c.legacy === 1 || !c.p1 || c.p1.trim() === "",
			).length;

			// The session main model leads the migration chain (parity with
			// OpenCode's primaryModelId): a quality-sensitive consolidation should
			// run on the user's working model, not the (possibly misconfigured)
			// historian model. Historian model + fallbacks remain the safety net.
			const sessionMainModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;

			// Migration runs only when memory is enabled — parity with OpenCode,
			// whose orchestrator gates on `runMigration = memory.enabled !== false
			// && historian.model` (recomp-orchestrator drives migration off that
			// flag, NOT unconditionally). With memory disabled there is no memory
			// pool to re-organize, so re-categorizing would be a no-op at best and
			// could touch a pool the user opted out of at worst.
			const migrationEnabled = deps.memoryEnabled;

			const runMigration = async (): Promise<string> => {
				if (!migrationEnabled) {
					return "Memory migration skipped (memory disabled).";
				}
				// runPiMemoryMigration further self-gates via its own
				// once-per-project / empty-pool / USER_* guards.
				try {
					const outcome = await runPiMemoryMigration({
						db: deps.db,
						runner: deps.runner,
						primaryModel: sessionMainModel,
						model: deps.historianModel as string,
						fallbackModels: deps.historianFallbacks,
						timeoutMs: deps.historianTimeoutMs,
						thinkingLevel: deps.historianThinkingLevel,
						directory: ctx.cwd,
						sessionId,
						userMemoriesEnabled: deps.userMemoriesEnabled,
					});
					return outcome.summary;
				} catch (error) {
					return `Memory migration skipped (error): ${describeError(error).brief}`;
				}
			};

			// ── Guard: already-upgraded session (parity with OpenCode) ──────────
			// No upgradable compartments → don't run a wasteful/risky full recomp.
			//   • none + migration already done → no-op "already upgraded"
			//   • none + migration still pending → migration only (skip recomp)
			if (upgradableCount === 0) {
				const projectPath = resolveProjectIdentity(ctx.cwd);
				// migrationPending mirrors OpenCode: only pending when memory is
				// enabled AND the project hasn't been migrated yet.
				const migrationPending =
					migrationEnabled && !isMemoryMigrationDone(deps.db, projectPath);
				if (!migrationPending) {
					sendCtxStatusMessage(pi, {
						title: "/ctx-session-upgrade",
						text: [
							"## Session Upgrade — Already Up To Date",
							"",
							compartments.length === 0
								? "This session has no compartment history to upgrade yet."
								: "This session's compartments are already in the current format.",
						].join("\n"),
						level: "info",
					});
					return;
				}
				// Compartments current but project memories never migrated — run
				// migration only.
				sendCtxStatusMessage(pi, {
					title: "/ctx-session-upgrade",
					text: "## Session Upgrade\n\nCompartments are already current. Re-organizing project memories. This may take a while.",
					level: "info",
				});
				const summary = await runMigration();
				sendCtxStatusMessage(pi, {
					title: "/ctx-session-upgrade",
					text: ["## Session Upgrade — Complete", "", summary].join("\n"),
					level: "info",
				});
				return;
			}

			sendCtxStatusMessage(pi, {
				title: "/ctx-session-upgrade",
				text: "## Session Upgrade\n\nRebuilding compartments into the v2 format and re-organizing project memories. This may take a while.",
				level: "info",
			});

			const provider = {
				readMessages: () => readPiSessionMessages(ctx),
			} satisfies RawMessageProvider;
			const unregister = setRawMessageProvider(sessionId, provider);
			setMagicContextRecompActive(sessionId, true);
			updateStatusLine(ctx, { db: deps.db, projectIdentity: ctx.cwd });

			try {
				// Step 1 — compartment upgrade via full recomp.
				const recompResult = await executeContextRecompWithResult(
					{
						client: createPiHistorianClient({
							runner: deps.runner,
							model: deps.historianModel,
							fallbackModels: deps.historianFallbacks,
							timeoutMs: deps.historianTimeoutMs,
							thinkingLevel: deps.historianThinkingLevel,
							directory: ctx.cwd,
							accountingSessionId: sessionId,
							systemPrompt: COMPARTMENT_AGENT_SYSTEM_PROMPT,
							notify: (text) =>
								sendCtxStatusMessage(pi, {
									title: "/ctx-session-upgrade",
									text,
									level: "info",
								}),
						}) as never,
						db: deps.db,
						sessionId,
						historianChunkTokens: deps.historianChunkTokens,
						directory: ctx.cwd,
						historianTimeoutMs: deps.historianTimeoutMs,
						memoryEnabled: deps.memoryEnabled,
						autoPromote: deps.autoPromote,
					},
					{},
				);

				// Gate migration + "Complete" on `published` — the GROUND TRUTH
				// that recomp actually rebuilt compartments (parity with OpenCode
				// runManagedUpgrade). A recomp can no-op WITHOUT a "— Failed/Skipped"
				// heading (lease/activeRuns guard returns "Historian already
				// running…"), which isRecompFailure misses. Running migration +
				// declaring Complete on a skipped recomp leaves tierless rows but
				// migrated memories + a project-wide cache-bust from the epoch bump
				// (dogfood 2026-05-30, AFT false-complete under concurrent processes).
				if (!recompResult.published || isRecompFailure(recompResult.message)) {
					const reason = contextualizeUpgradeReason(
						isRecompFailure(recompResult.message)
							? extractRecompReason(recompResult.message)
							: `Compartments were not rebuilt: ${extractRecompReason(recompResult.message)}`,
					);
					sendCtxStatusMessage(pi, {
						title: "/ctx-session-upgrade",
						text: `## Session Upgrade — Incomplete\n\n${reason}`,
						level: "error",
					});
					return;
				}

				signalPiHistoryRefresh(sessionId);
				signalPiPendingMaterialization(sessionId);

				// Step 2 — memory migration (once per project, idempotent).
				const migrationSummary = await runMigration();

				sendCtxStatusMessage(pi, {
					title: "/ctx-session-upgrade",
					text: [
						"## Session Upgrade — Complete",
						"",
						upgradableCount > 0
							? `Rebuilt ${upgradableCount} legacy compartment${upgradableCount === 1 ? "" : "s"} into the v2 format.`
							: "Rebuilt this session's compartments into the v2 format.",
						migrationSummary ? `\n${migrationSummary}` : "",
						"",
						recompResult.message,
					].join("\n"),
					level: "info",
				});
			} catch (error) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-session-upgrade",
					text: `## Session Upgrade — Failed\n\n${describeError(error).brief}`,
					level: "error",
				});
			} finally {
				setMagicContextRecompActive(sessionId, false);
				updateStatusLine(ctx, { db: deps.db, projectIdentity: ctx.cwd });
				unregister();
			}
		},
	});
}
