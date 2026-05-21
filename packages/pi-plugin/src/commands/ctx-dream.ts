import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { enqueueDream } from "@magic-context/core/features/magic-context/dreamer/queue";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { sessionLog } from "@magic-context/core/shared/logger";
import { runPiDreamForProject } from "../dreamer";
import { sendCtxStatusMessage } from "./pi-command-utils";

export function registerCtxDreamCommand(
	pi: ExtensionAPI,
	deps: {
		db: ContextDatabase;
		projectDir: string;
		projectIdentity: string;
		resolveProject?: (ctx: { cwd: string }) => {
			projectDir: string;
			projectIdentity: string;
		};
		dreamerEnabled?: boolean;
		onProjectSeen?: (projectIdentity: string) => void;
	},
): void {
	pi.registerCommand("ctx-dream", {
		description: "Run a Magic Context dreamer cycle for this project now",
		handler: async (_args, ctx) => {
			const project = deps.resolveProject?.(ctx) ?? {
				projectDir: deps.projectDir,
				projectIdentity: deps.projectIdentity,
			};
			deps.onProjectSeen?.(project.projectIdentity);
			if (deps.dreamerEnabled === false) {
				sendCtxStatusMessage(
					pi,
					{
						title: "/ctx-dream",
						text: "## /ctx-dream\n\nDreamer is not configured for this project (`dreamer.enabled=false`).",
						level: "info",
					},
					{
						projectDir: project.projectDir,
						projectIdentity: project.projectIdentity,
					},
				);
				return;
			}
			const enqueued = enqueueDream(
				deps.db,
				project.projectIdentity,
				"manual",
				true,
			);
			if (!enqueued) {
				// Already queued or actively running. Mirrors OpenCode's
				// behavior at command-handler.ts:230 — if enqueue returns
				// null we don't kick off another cycle.
				sendCtxStatusMessage(
					pi,
					{
						title: "/ctx-dream",
						text: [
							"## /ctx-dream",
							"",
							`Dream already queued or running for ${project.projectIdentity}.`,
						].join("\n"),
						level: "info",
					},
					{
						projectDir: project.projectDir,
						projectIdentity: project.projectIdentity,
						entry: null,
					},
				);
				return;
			}

			// Tell the user we're starting a real run, not just queueing.
			sendCtxStatusMessage(
				pi,
				{
					title: "/ctx-dream",
					text: [
						"## /ctx-dream",
						"",
						`Starting dream run #${enqueued.id} for ${project.projectIdentity}…`,
						`Project directory: ${project.projectDir}`,
					].join("\n"),
					level: "info",
				},
				{
					projectDir: project.projectDir,
					projectIdentity: project.projectIdentity,
					entry: enqueued,
				},
			);

			// OpenCode parity (command-handler.ts:236-246): immediately drain
			// the dream queue from the same registered client/config the
			// timer uses. Pi previously left this to the 15-min timer, so
			// /ctx-dream felt broken.
			try {
				const result = await runPiDreamForProject(project.projectIdentity);
				let summary: string;
				if (!result) {
					summary =
						"Dream queued, but another worker is already processing the queue.";
				} else if (result.tasks.length === 0) {
					summary =
						"Dreamer is configured, but no dream tasks are enabled for this project.";
				} else {
					const taskLines = result.tasks
						.map((task) => {
							const status = task.error ? `error: ${task.error}` : "ok";
							return `- ${task.name} (${(task.durationMs / 1000).toFixed(1)}s) — ${status}`;
						})
						.join("\n");
					const failureCount = result.tasks.filter((t) => t.error).length;
					summary = [
						`Dream run complete in ${((result.finishedAt - result.startedAt) / 1000).toFixed(1)}s.`,
						`- Tasks: ${result.tasks.length} (${failureCount} failed)`,
						`- Smart notes surfaced: ${result.smartNotesSurfaced}, pending: ${result.smartNotesPending}`,
						"",
						taskLines,
					].join("\n");
				}

				sendCtxStatusMessage(
					pi,
					{
						title: "/ctx-dream",
						text: ["## /ctx-dream", "", summary].join("\n"),
						level: result ? "success" : "info",
					},
					{
						projectDir: project.projectDir,
						projectIdentity: project.projectIdentity,
						entry: enqueued,
					},
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sessionLog(
					project.projectIdentity,
					`/ctx-dream failed to drain queue: ${message}`,
				);
				sendCtxStatusMessage(
					pi,
					{
						title: "/ctx-dream",
						text: [
							"## /ctx-dream",
							"",
							`Dream run failed: ${message}`,
							"The queued entry remains; the registered timer will retry on its next tick.",
						].join("\n"),
						level: "error",
					},
					{
						projectDir: project.projectDir,
						projectIdentity: project.projectIdentity,
						entry: enqueued,
					},
				);
			}
		},
	});
}
