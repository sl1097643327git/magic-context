/**
 * Pi-side wrapper for the `ctx_memory` tool.
 *
 * Action surface mirrors OpenCode's `packages/plugin/src/tools/ctx-memory/tools.ts`.
 * Two tiers of actions:
 *
 *  Primary (for any agent that can call ctx_memory):
 *    - write: insert a new memory (or no-op + bump seenCount on dedup hit)
 *    - archive: soft-delete a memory (status = 'archived'), optional reason
 *    - update: rewrite a memory's content (recomputes normalized_hash + queues re-embed)
 *    - merge: combine N memories into one canonical, supersede the rest
 *
 *  Dreamer-only (gated on `allowDreamerActions: true`):
 *    - list: list active memories for the current project
 *
 * Allowlist gating mirrors OpenCode's `allowedActions` deps field. In OpenCode,
 * the dreamer subagent gets the full action surface because `toolContext.agent
 * === DREAMER_AGENT`. Pi has no agent identity inside child processes, so we
 * use an explicit flag (`--magic-context-dreamer-actions`) wired through the
 * subagent extension entry. Same effective behavior, different transport.
 *
 * Parity reference (OpenCode):
 *   - `tools/ctx-memory/types.ts` for action enum
 *   - `tools/ctx-memory/tools.ts` for handler logic
 *   - `plugin/tool-registry.ts` for the primary allowedActions (CTX_MEMORY_ACTIONS)
 *
 * Memories are project-scoped via `resolveProjectIdentity(ctx.cwd)` and stored
 * in the shared cortexkit DB, so a memory written from the pi-plugin is
 * immediately visible to OpenCode sessions on the same project (and vice
 * versa).
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	archiveMemory,
	CATEGORY_PRIORITY,
	getMemoriesByProject,
	getMemoryByHash,
	getMemoryById,
	insertMemory,
	type Memory,
	type MemoryCategory,
	mergeMemoryStats,
	saveEmbedding,
	supersededMemory,
	updateMemoryContent,
	updateMemorySeenCount,
} from "@magic-context/core/features/magic-context/memory";
import {
	embedTextForProject,
	getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/memory/embedding";
import { computeNormalizedHash } from "@magic-context/core/features/magic-context/memory/normalize-hash";
import {
	normalizeStoredProjectPath,
	resolveProjectIdentity,
	storedPathBelongsToIdentity,
} from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	type ContextDatabase,
	queueMemoryMutation,
} from "@magic-context/core/features/magic-context/storage";
import { log } from "@magic-context/core/shared/logger";
import { type Static, Type } from "typebox";

const DEFAULT_LIST_LIMIT = 10;
const VALID_CATEGORIES = new Set<string>(CATEGORY_PRIORITY);

function isMemoryCategory(value: string): value is MemoryCategory {
	return VALID_CATEGORIES.has(value);
}

// Mirrors OpenCode CTX_MEMORY_DREAMER_ACTIONS. `delete` was removed — it was an
// exact alias of `archive` (both soft-archive); `archive` is the single
// soft-remove action. Primary agents get write/archive/update/merge on the
// memories they already see (with ids) in the injected project-memory block;
// only `list` (bulk enumeration) stays dreamer-only.
const ALL_ACTIONS = ["write", "archive", "update", "merge", "list"] as const;
type CtxMemoryAction = (typeof ALL_ACTIONS)[number];

const DREAMER_ONLY_ACTIONS: ReadonlySet<CtxMemoryAction> = new Set(["list"]);

const ParamsSchema = Type.Object({
	action: Type.Union(
		ALL_ACTIONS.map((a) => Type.Literal(a)),
		{ description: "Action to perform on memories" },
	),
	content: Type.Optional(
		Type.String({
			description: "Memory content (required for write, update, merge)",
		}),
	),
	category: Type.Optional(
		Type.String({
			description:
				"Memory category (required for write, optional filter for list, optional override for merge). One of: " +
				CATEGORY_PRIORITY.join(", "),
		}),
	),
	id: Type.Optional(
		Type.Number({
			description: "Memory ID (required for archive, update)",
		}),
	),
	ids: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Memory IDs to merge (required for merge)",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum results to return for list (default: 10)",
		}),
	),
	reason: Type.Optional(
		Type.String({ description: "Archive reason (optional for archive)" }),
	),
});

type CtxMemoryParams = Static<typeof ParamsSchema>;

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function err(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: undefined,
		isError: true,
	};
}

function normalizeLimit(limit?: number): number {
	if (typeof limit !== "number" || !Number.isFinite(limit))
		return DEFAULT_LIST_LIMIT;
	return Math.max(1, Math.floor(limit));
}

function formatMemoryList(memories: Memory[]): string {
	if (memories.length === 0) return "No active memories found.";

	const rows = memories.map((m) => ({
		id: String(m.id),
		category: m.category,
		status: m.status,
		updated: new Date(m.updatedAt).toISOString(),
		content: m.content.replace(/\s+/g, " ").trim(),
	}));
	const widths = {
		id: Math.max(2, ...rows.map((r) => r.id.length)),
		category: Math.max(8, ...rows.map((r) => r.category.length)),
		status: Math.max(6, ...rows.map((r) => r.status.length)),
		updated: Math.max(7, ...rows.map((r) => r.updated.length)),
	};
	const fmt = (r: (typeof rows)[number]) =>
		[
			r.id.padEnd(widths.id),
			r.category.padEnd(widths.category),
			r.status.padEnd(widths.status),
			r.updated.padEnd(widths.updated),
			r.content,
		].join(" | ");
	return [
		`Found ${rows.length} active ${rows.length === 1 ? "memory" : "memories"}:`,
		"",
		...rows.map(fmt),
	].join("\n");
}

function queueEmbedding(args: {
	deps: CtxMemoryToolDeps;
	projectIdentity: string;
	memoryId: number;
	content: string;
}) {
	const snapshot = getProjectEmbeddingSnapshot(args.projectIdentity);
	if (!snapshot?.enabled) return;
	void (async () => {
		try {
			const result = await embedTextForProject(
				args.projectIdentity,
				args.content,
			);
			if (!result) {
				log(
					`[magic-context-pi] embedding skipped for memory ${args.memoryId}: provider unavailable.`,
				);
				return;
			}
			saveEmbedding(args.deps.db, args.memoryId, result.vector, result.modelId);
			log(`[magic-context-pi] proactively embedded memory ${args.memoryId}.`);
		} catch (error) {
			log(
				`[magic-context-pi] embedding failed for memory ${args.memoryId}:`,
				error,
			);
		}
	})();
}

export interface CtxMemoryToolDeps {
	db: ContextDatabase;
	ensureProjectRegistered?: (
		directory: string,
		db: ContextDatabase,
	) => Promise<void>;
	memoryEnabled?: boolean;
	embeddingEnabled?: boolean;
	/** When true, the dreamer-only `list` action is exposed. Set by the subagent
	 *  extension entry when the parent passes `--magic-context-dreamer-actions`.
	 *  Default: false (primary set only: write/archive/update/merge). */
	allowDreamerActions?: boolean;
}

export function createCtxMemoryTool(
	deps: CtxMemoryToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	const dreamerAllowed = deps.allowDreamerActions === true;
	const description = dreamerAllowed
		? "Manage cross-session project memories. Memories persist across sessions and are " +
			"shared with OpenCode sessions on the same project. " +
			"Supported actions: write, archive, update, merge, list."
		: "Manage cross-session project memories. Memories persist across sessions and are " +
			"shared with OpenCode sessions on the same project. " +
			"Supported actions: write, archive, update, merge.";

	return {
		name: "ctx_memory",
		label: "Magic Context: Memory",
		description,
		parameters: ParamsSchema,
		async execute(
			_toolCallId,
			params: CtxMemoryParams,
			_signal,
			_onUpdate,
			ctx,
		) {
			// Gate dreamer-only actions on the allowlist flag. Mirrors
			// OpenCode's `if (toolContext.agent !== DREAMER_AGENT && !allowedActions.includes(args.action))`.
			if (!dreamerAllowed && DREAMER_ONLY_ACTIONS.has(params.action)) {
				return err(
					`Error: Action '${params.action}' is not allowed in this context.`,
				);
			}

			const projectIdentity = resolveProjectIdentity(ctx.cwd);
			await deps.ensureProjectRegistered?.(ctx.cwd, deps.db);
			const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
			if (
				snapshot
					? !snapshot.features.memoryEnabled
					: deps.memoryEnabled === false
			) {
				return err("Cross-session memory is disabled for this project.");
			}
			const sessionId = ctx.sessionManager.getSessionId();

			if (params.action === "write") {
				const content = params.content?.trim();
				if (!content)
					return err("Error: 'content' is required when action is 'write'.");

				const rawCategory = params.category?.trim();
				if (!rawCategory) {
					return err("Error: 'category' is required when action is 'write'.");
				}
				if (!isMemoryCategory(rawCategory)) {
					return err(
						`Error: Unknown memory category '${rawCategory}'. Valid: ${CATEGORY_PRIORITY.join(", ")}`,
					);
				}

				const existing = getMemoryByHash(
					deps.db,
					projectIdentity,
					rawCategory,
					computeNormalizedHash(content),
				);
				if (existing) {
					updateMemorySeenCount(deps.db, existing.id);
					return ok(
						`Memory already exists [ID: ${existing.id}] in ${rawCategory} (seen count incremented).`,
					);
				}

				const memory = insertMemory(deps.db, {
					projectPath: projectIdentity,
					category: rawCategory,
					content,
					sourceSessionId: sessionId,
					sourceType: dreamerAllowed ? "dreamer" : "agent",
				});

				queueEmbedding({ deps, projectIdentity, memoryId: memory.id, content });
				// Do NOT invalidate the m[0]/m[1] cache here. An additive write is a
				// supersede-delta operation: it surfaces in m[1] via the maxMemoryId
				// watermark (renderM1 reads memories with id > cachedM0MaxMemoryId) on
				// the next cache-busting pass, WITHOUT busting m[0]. Clearing the cache
				// re-materialized m[0] for every session (the call was global over
				// session_meta), defeating the whole additive/non-additive split and
				// busting unrelated projects. Matches OpenCode's write path, which
				// likewise does no cache invalidation.
				return ok(`Saved memory [ID: ${memory.id}] in ${rawCategory}.`);
			}

			if (params.action === "list") {
				const limit = normalizeLimit(params.limit);
				const filtered = getMemoriesByProject(deps.db, projectIdentity);
				const category = params.category?.trim();
				const filtered2 = category
					? filtered.filter((m) => m.category === category)
					: filtered;
				return ok(formatMemoryList(filtered2.slice(0, limit)));
			}

			if (params.action === "update") {
				if (typeof params.id !== "number" || !Number.isInteger(params.id)) {
					return err("Error: 'id' is required when action is 'update'.");
				}
				const content = params.content?.trim();
				if (!content) {
					return err("Error: 'content' is required when action is 'update'.");
				}

				const memory = getMemoryById(deps.db, params.id);
				if (
					!memory ||
					!storedPathBelongsToIdentity(memory.projectPath, projectIdentity)
				) {
					return err(`Error: Memory with ID ${params.id} was not found.`);
				}

				const normalizedHash = computeNormalizedHash(content);
				const duplicate = getMemoryByHash(
					deps.db,
					projectIdentity,
					memory.category,
					normalizedHash,
				);
				if (duplicate && duplicate.id !== memory.id) {
					return err(
						`Error: Memory content already exists as ID ${duplicate.id}; merge or archive duplicates instead.`,
					);
				}

				deps.db.transaction(() => {
					updateMemoryContent(deps.db, memory.id, content, normalizedHash);
					queueMemoryMutation(deps.db, {
						projectPath: projectIdentity,
						mutationType: "update",
						targetMemoryId: memory.id,
						category: memory.category,
						newContent: content,
					});
				})();
				queueEmbedding({ deps, projectIdentity, memoryId: memory.id, content });
				return ok(`Updated memory [ID: ${memory.id}] in ${memory.category}.`);
			}

			if (params.action === "merge") {
				const ids = params.ids?.filter((id): id is number =>
					Number.isInteger(id),
				);
				if (!ids || ids.length < 2) {
					return err(
						"Error: 'ids' must include at least two memory IDs when action is 'merge'.",
					);
				}

				const content = params.content?.trim();
				if (!content) {
					return err("Error: 'content' is required when action is 'merge'.");
				}

				const sourceMemories = ids
					.map((id) => getMemoryById(deps.db, id))
					.filter((memory): memory is Memory => Boolean(memory));
				if (sourceMemories.length !== ids.length) {
					return err("Error: One or more source memories were not found.");
				}

				// Cross-identity consolidation is a DREAMER-ONLY capability: each
				// source is superseded under ITS OWN project identity with a
				// per-project supersede-delta row (see the supersede loop below),
				// so every affected project's m[1] reconciles correctly. But
				// `merge` is in the primary action set too, and a primary agent
				// must not reach into ANOTHER project's memories — mirror
				// update/archive ownership (parity with OpenCode).
				if (!dreamerAllowed) {
					const foreign = sourceMemories.find(
						(memory) =>
							!storedPathBelongsToIdentity(memory.projectPath, projectIdentity),
					);
					if (foreign) {
						return err(`Error: Memory with ID ${foreign.id} was not found.`);
					}
				}

				const requestedCategory = params.category?.trim();
				if (requestedCategory && !isMemoryCategory(requestedCategory)) {
					return err(
						`Error: Unknown memory category '${requestedCategory}'. Valid: ${CATEGORY_PRIORITY.join(", ")}`,
					);
				}
				const requestedCategoryTyped: MemoryCategory | undefined =
					requestedCategory && isMemoryCategory(requestedCategory)
						? requestedCategory
						: undefined;
				const fallbackCategory = sourceMemories[0]?.category;
				const category: MemoryCategory | undefined =
					requestedCategoryTyped ?? fallbackCategory;
				if (!category) {
					return err(
						"Error: A valid category is required when action is 'merge'.",
					);
				}

				if (
					!requestedCategoryTyped &&
					sourceMemories.some((memory) => memory.category !== category)
				) {
					return err(
						"Error: Mixed-category merges require an explicit 'category'.",
					);
				}

				const normalizedHash = computeNormalizedHash(content);
				const duplicate = getMemoryByHash(
					deps.db,
					projectIdentity,
					category,
					normalizedHash,
				);
				const canonicalExisting =
					duplicate && ids.includes(duplicate.id) ? duplicate : null;
				if (duplicate && !canonicalExisting) {
					return err(
						`Error: Memory content already exists as ID ${duplicate.id}; update or archive existing duplicates instead.`,
					);
				}

				// Aggregate stats from all source memories.
				const mergedSeenCount = sourceMemories.reduce(
					(sum, memory) => sum + memory.seenCount,
					0,
				);
				const mergedRetrievalCount = sourceMemories.reduce(
					(sum, memory) => sum + memory.retrievalCount,
					0,
				);
				// `mergedFrom` is JSON-stringified in the DB. Flatten any prior
				// merge chains so the lineage stays accurate when merging
				// already-merged memories. Mirrors OpenCode's parity construction
				// at packages/plugin/src/tools/ctx-memory/tools.ts:381-405.
				const mergedFromIds = Array.from(
					new Set(
						sourceMemories.flatMap((memory) => {
							let parsed: unknown[] = [];
							try {
								parsed = memory.mergedFrom ? JSON.parse(memory.mergedFrom) : [];
							} catch {
								parsed = [];
							}
							const priorIds = Array.isArray(parsed)
								? parsed.filter(
										(value): value is number => typeof value === "number",
									)
								: [];
							return [memory.id, ...priorIds];
						}),
					),
				).sort((left, right) => left - right);
				const mergedFrom = JSON.stringify(mergedFromIds);
				const mergedStatus: "active" | "permanent" = sourceMemories.some(
					(memory) => memory.status === "permanent",
				)
					? "permanent"
					: "active";

				let canonicalMemory!: Memory;
				deps.db.transaction(() => {
					let canonicalContentChanged = false;
					if (canonicalExisting) {
						// One of the source memories already has the merged content.
						// Update it in place to absorb stats from the others.
						canonicalMemory = canonicalExisting;
						canonicalContentChanged =
							canonicalMemory.content !== content ||
							canonicalMemory.normalizedHash !== normalizedHash;
						if (canonicalContentChanged) {
							updateMemoryContent(
								deps.db,
								canonicalMemory.id,
								content,
								normalizedHash,
							);
						}
					} else {
						// Insert a fresh canonical memory with the merged content.
						canonicalMemory = insertMemory(deps.db, {
							projectPath: projectIdentity,
							category,
							content,
							sourceSessionId: sessionId,
							sourceType: dreamerAllowed ? "dreamer" : "agent",
						});
					}

					mergeMemoryStats(
						deps.db,
						canonicalMemory.id,
						mergedSeenCount,
						mergedRetrievalCount,
						mergedFrom,
						mergedStatus,
					);

					for (const memory of sourceMemories) {
						if (memory.id === canonicalMemory.id) {
							continue;
						}
						supersededMemory(deps.db, memory.id, canonicalMemory.id);
						queueMemoryMutation(deps.db, {
							// Normalize the stored path to the resolved identity
							// before queueing — the render-side mutation-log reader
							// matches exact project_path, and OpenCode + dashboard
							// both normalize first. A legacy raw filesystem path here
							// would write a row that normalized git:/dir: sessions
							// never read (the supersede delta would silently vanish).
							projectPath: normalizeStoredProjectPath(memory.projectPath),
							mutationType: "superseded",
							targetMemoryId: memory.id,
							supersededById: canonicalMemory.id,
						});
					}

					if (canonicalExisting && canonicalContentChanged) {
						queueMemoryMutation(deps.db, {
							projectPath: normalizeStoredProjectPath(
								canonicalMemory.projectPath,
							),
							mutationType: "update",
							targetMemoryId: canonicalMemory.id,
							category,
							newContent: content,
						});
					}
				})();

				queueEmbedding({
					deps,
					projectIdentity,
					memoryId: canonicalMemory.id,
					content,
				});
				const supersededIds = sourceMemories
					.map((memory) => memory.id)
					.filter((id) => id !== canonicalMemory.id);
				return ok(
					`Merged memories [${ids.join(", ")}] into canonical memory [ID: ${canonicalMemory.id}] in ${category}; superseded [${supersededIds.join(", ")}].`,
				);
			}

			if (params.action === "archive") {
				if (typeof params.id !== "number" || !Number.isInteger(params.id)) {
					return err("Error: 'id' is required when action is 'archive'.");
				}
				const memory = getMemoryById(deps.db, params.id);
				if (
					!memory ||
					!storedPathBelongsToIdentity(memory.projectPath, projectIdentity)
				) {
					return err(`Error: Memory with ID ${params.id} was not found.`);
				}
				deps.db.transaction(() => {
					archiveMemory(deps.db, params.id as number, params.reason);
					queueMemoryMutation(deps.db, {
						projectPath: projectIdentity,
						mutationType: "archive",
						targetMemoryId: params.id as number,
					});
				})();
				const reasonSuffix = params.reason ? ` (${params.reason})` : "";
				return ok(`Archived memory [ID: ${params.id}]${reasonSuffix}.`);
			}

			return err("Error: Unknown action.");
		},
	};
}
