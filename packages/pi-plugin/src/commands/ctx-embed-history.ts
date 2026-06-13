import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { embedSessionCompartmentChunks } from "@magic-context/core/features/magic-context/project-embedding-registry";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { ensureProjectRegisteredFromPiDirectory } from "../embedding-bootstrap";
import { resolveSessionId, sendCtxStatusMessage } from "./pi-command-utils";

/**
 * `/ctx-embed-history` (Pi) — backfill ALL of this session's compartment chunk
 * embeddings in one pass. Pi has no recomp progress sidebar, so it reports a
 * single completion status message instead of OpenCode's live bar. Parity note:
 * the embedding drain itself (lease, idempotence, oldest-first) is the SHARED
 * core `embedSessionCompartmentChunks` used by both harnesses.
 */
export function registerCtxEmbedHistoryCommand(
	pi: ExtensionAPI,
	deps: {
		db: ContextDatabase;
		projectDir: string;
		projectIdentity: string;
		memoryEnabled?: boolean;
		resolveProject?: (ctx: { cwd: string }) => {
			projectDir: string;
			projectIdentity: string;
		};
	},
): void {
	pi.registerCommand("ctx-embed-history", {
		description:
			"Embed all of this session's history compartments for semantic search, in one pass",
		handler: async (_args, ctx) => {
			const sessionId = resolveSessionId(ctx);
			if (!sessionId) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-embed-history",
					text: "## /ctx-embed-history\n\nNo active Pi session is available.",
					level: "error",
				});
				return;
			}
			if (deps.memoryEnabled === false) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-embed-history",
					text: "## /ctx-embed-history\n\nMemory is disabled for this project, so there is no semantic embedding to backfill.",
					level: "info",
				});
				return;
			}

			const project = deps.resolveProject?.(ctx) ?? {
				projectDir: deps.projectDir,
				projectIdentity: deps.projectIdentity,
			};
			await ensureProjectRegisteredFromPiDirectory(project.projectDir, deps.db);

			const outcome = await embedSessionCompartmentChunks(
				deps.db,
				project.projectIdentity,
				sessionId,
			);

			const { text, level } = ((): {
				text: string;
				level: "success" | "info";
			} => {
				switch (outcome.status) {
					case "nothing":
						return {
							text: "## /ctx-embed-history\n\nAll of this session's history is already embedded.",
							level: "info",
						};
					case "disabled":
						return {
							text: "## /ctx-embed-history\n\nNo embedding provider is configured, so there is nothing to embed.",
							level: "info",
						};
					case "busy":
						return {
							text: `## /ctx-embed-history\n\nEmbedding is already running for this project — ${outcome.total} compartment${outcome.total === 1 ? "" : "s"} still pending. Try again shortly.`,
							level: "info",
						};
					default:
						return {
							text: `## /ctx-embed-history\n\nEmbedded ${outcome.embedded} compartment${outcome.embedded === 1 ? "" : "s"} of history for semantic search.`,
							level: "success",
						};
				}
			})();

			sendCtxStatusMessage(
				pi,
				{ title: "/ctx-embed-history", text, level },
				{
					sessionId,
					projectIdentity: project.projectIdentity,
					status: outcome.status,
					embedded: outcome.embedded,
					total: outcome.total,
				},
			);
		},
	});
}
