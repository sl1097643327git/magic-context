/**
 * Pi-side `<session-history>` injection — mirrors OpenCode's
 * `prepareCompartmentInjection` + `renderCompartmentInjection`
 * (packages/plugin/src/hooks/magic-context/inject-compartments.ts).
 *
 * Pi differences:
 *   - Pi messages have `content: string | (TextContent | ImageContent)[]`,
 *     not OpenCode's `parts: unknown[]`. We project Pi messages into a
 *     minimal MessageLike-shaped view so the shared
 *     `prepareCompartmentInjection` can do its DB read + cache lookup +
 *     boundary trim. The actual render writes back to Pi shape.
 *   - Pi messages don't have a stable per-message id at the AgentMessage
 *     layer. We synthesize one using the same `pi-msg-${index}-${ts}-${role}`
 *     scheme `transcript-pi.ts` uses, so the boundary-trim cutoff comparison
 *     stays consistent across passes.
 *
 * Cache safety:
 *   - `prepareCompartmentInjection` honors its own injection cache. On
 *     defer passes (`isCacheBusting=false`) the cached prepared block is
 *     replayed, the boundary trim is re-applied, and we just re-write the
 *     cached block into Pi message[0]. Provider prompt cache stays stable.
 *   - On cache-busting passes (historian/compressor publish, /ctx-flush)
 *     the cache is rebuilt and the new block is written. Caller is
 *     responsible for setting `isCacheBusting` correctly via the shared
 *     historyRefreshSessions signal.
 */

import { getMemoriesByProject } from "@magic-context/core/features/magic-context/memory/storage-memory";
import type { Memory } from "@magic-context/core/features/magic-context/memory/types";
import {
	type ContextDatabase,
	clearCachedM0,
	escapeXmlContent,
	GLOBAL_USER_PROFILE_PROJECT_PATH,
	getCompartments,
	getMaxM0MutationId,
	getOrCreateSessionMeta,
	getProjectState,
	persistCachedM0,
	readProjectDocsCanonical,
} from "@magic-context/core/features/magic-context/storage";
import {
	getActiveUserMemories,
	type UserMemory,
} from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import {
	DEFAULT_HISTORY_BUDGET_TOKENS,
	extractM0Block,
	renderCompartmentAtTier,
	renderDecayedCompartments,
} from "@magic-context/core/hooks/magic-context/decay-render";
import {
	DEFAULT_MEMORY_BUDGET_TOKENS,
	DEFAULT_USER_PROFILE_BUDGET_TOKENS,
	type PreparedCompartmentInjection,
	prepareCompartmentInjection,
	renderMemoryBlockV2,
	trimMemoriesToBudgetV2,
	trimUserMemoriesToBudget,
} from "@magic-context/core/hooks/magic-context/inject-compartments";
import { buildKeyFilesBlock } from "@magic-context/core/hooks/magic-context/key-files-block";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import type { MessageLike } from "@magic-context/core/hooks/magic-context/tag-messages";
import { sessionLog as logSession } from "@magic-context/core/shared/logger";

/**
 * Pi message shapes — kept structurally compatible with
 * `@earendil-works/pi-coding-agent`'s `AgentMessage` union. Same minimal
 * subset transcript-pi.ts uses.
 */
type PiTextContent = { type: "text"; text: string; textSignature?: string };
type PiImageContent = { type: "image"; data: string; mimeType: string };
type PiUserMessage = {
	role: "user";
	content: string | (PiTextContent | PiImageContent)[];
	timestamp?: number;
};
type PiAssistantMessage = {
	role: "assistant";
	content: unknown[];
	timestamp?: number;
};
type PiToolResultMessage = {
	role: "toolResult";
	content: unknown[];
	timestamp?: number;
};
type PiAgentMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

/**
 * Resolve the cross-pass-stable id for the i-th Pi message.
 *
 * Pi historian writes boundary IDs into the `compartments.start_message_id`
 * / `end_message_id` columns using SessionEntry IDs (the JSONL entry UUIDs)
 * via `read-session-pi.ts` → `RawMessage.id = entry.id`. Boundary lookup
 * MUST use the same scheme — otherwise injected `<session-history>` cannot
 * trim raw history because the cutoff id never matches anything in the
 * AgentMessage[] view.
 *
 * Pi's `pi.on("context")` event delivers `AgentMessage[]` only, with no
 * back-reference to the SessionEntry layer. Caller is responsible for
 * walking `ctx.sessionManager.getBranch()`, filtering to message-type
 * entries (the same filter `buildSessionContext` applies), and producing
 * an `entryIds: (string | undefined)[]` array indexed 1:1 with `piMessages`.
 *
 * When `entryIds[i]` is missing or undefined we fall back to a synthesized
 * `pi-msg-${index}-${ts}-${role}` id. That synthesized form has zero
 * cross-pass stability (the index moves whenever earlier messages are
 * trimmed) but is harmless because no compartment boundary will ever
 * match it. The fallback only exists so that the projection has *some*
 * id field for the trim machinery; it never produces a real cutoff.
 */
function resolveStableId(
	msg: PiAgentMessage,
	index: number,
	entryIds: readonly (string | undefined)[] | undefined,
): string {
	const provided = entryIds?.[index];
	if (typeof provided === "string" && provided.length > 0) return provided;
	const ts = msg.timestamp;
	const role = msg.role;
	if (typeof ts !== "number") return `pi-msg-${index}-${role}`;
	return `pi-msg-${index}-${ts}-${role}`;
}

/**
 * Build a minimal MessageLike-shaped projection of Pi messages so the
 * shared compartment-injection trim logic can run. Only the `info.id`
 * field is read (for the `findIndex(m => m.info.id === lastEndMessageId)`
 * cutoff search). `parts` stays empty because the trim logic doesn't
 * read part content.
 *
 * The returned array is a brand-new array, NOT a live view into Pi
 * messages. The shared `prepareCompartmentInjection` calls `splice` on
 * this projection to remove covered messages — those mutations stay
 * local to the projection and we map the resulting cutoff back to Pi
 * messages ourselves.
 */
function buildMessageLikeProjection(
	piMessages: PiAgentMessage[],
	entryIds: readonly (string | undefined)[] | undefined,
): MessageLike[] {
	const projection: MessageLike[] = [];
	for (let i = 0; i < piMessages.length; i++) {
		const msg = piMessages[i];
		if (!msg) continue;
		projection.push({
			info: {
				id: resolveStableId(msg, i, entryIds),
				role: msg.role,
				sessionID: undefined,
			},
			parts: [],
		});
	}
	return projection;
}

/**
 * Mutate `piMessages` in place: remove every message whose synthesized
 * id appears at or before the cutoff. Preserves the rest of the array.
 *
 * Mirrors the `messages.splice(0, cutoffIndex+1)` behavior the shared
 * `prepareCompartmentInjection` does on its (OpenCode) MessageLike[].
 *
 * Returns the count of messages removed — used for log parity.
 */
function trimPiMessagesToBoundary(
	piMessages: PiAgentMessage[],
	entryIds: readonly (string | undefined)[] | undefined,
	cutoffMessageId: string,
): number {
	if (cutoffMessageId.length === 0) return 0;
	let cutoffIndex = -1;
	for (let i = 0; i < piMessages.length; i++) {
		const msg = piMessages[i];
		if (msg && resolveStableId(msg, i, entryIds) === cutoffMessageId) {
			cutoffIndex = i;
			break;
		}
	}
	if (cutoffIndex < 0) return 0;

	// Start with the same prefix trim as the shared OpenCode projection, then
	// repeatedly sweep both directions across Pi's split tool-call shape:
	//   - removed assistant toolCall -> any kept toolResult is orphaned
	//   - removed toolResult -> any kept assistant carrying that toolCall is unsafe
	// Tool results are not guaranteed to be contiguous with their calls once Pi
	// has injected user turns, custom messages, or other extension output, so a
	// simple "advance while next message is toolResult" leaves non-contiguous
	// provider-invalid orphans in the visible request.
	const remove = new Set<number>();
	for (let i = 0; i <= cutoffIndex; i++) remove.add(i);

	let changed = true;
	while (changed) {
		changed = false;
		const removedCallIds = new Set<string>();
		const removedResultIds = new Set<string>();

		for (const index of remove) {
			const msg = piMessages[index];
			if (!msg) continue;
			if (msg.role === "assistant") {
				for (const callId of getPiToolCallIds(msg)) removedCallIds.add(callId);
			} else if (msg.role === "toolResult") {
				const callId = getPiToolResultCallId(msg);
				if (callId) removedResultIds.add(callId);
			}
		}

		for (let i = 0; i < piMessages.length; i++) {
			if (remove.has(i)) continue;
			const msg = piMessages[i];
			if (!msg) continue;
			if (msg.role === "toolResult") {
				const callId = getPiToolResultCallId(msg);
				if (callId && removedCallIds.has(callId)) {
					remove.add(i);
					changed = true;
				}
				continue;
			}
			if (msg.role === "assistant") {
				const callIds = getPiToolCallIds(msg);
				if (callIds.some((callId) => removedResultIds.has(callId))) {
					remove.add(i);
					changed = true;
				}
			}
		}
	}

	const kept = piMessages.filter((_, index) => !remove.has(index));
	const removed = piMessages.length - kept.length;
	piMessages.splice(0, piMessages.length, ...kept);
	return removed;
}

function getPiToolCallIds(message: PiAssistantMessage): string[] {
	if (!Array.isArray(message.content)) return [];
	const ids: string[] = [];
	for (const part of message.content) {
		if (
			part &&
			typeof part === "object" &&
			(part as Record<string, unknown>).type === "toolCall" &&
			typeof (part as Record<string, unknown>).id === "string"
		) {
			ids.push((part as Record<string, unknown>).id as string);
		}
	}
	return ids;
}

function getPiToolResultCallId(message: PiToolResultMessage): string | null {
	const callId = (message as Record<string, unknown>).toolCallId;
	return typeof callId === "string" && callId.length > 0 ? callId : null;
}

export const __test = {
	trimPiMessagesToBoundary,
};

/**
 * Find the first user message in the Pi AgentMessage[] and prepend the
 * `<session-history>` block to its first text content. Mirrors
 * OpenCode's `findFirstTextPart` + `textPart.text = block + textPart.text`
 * write pattern.
 *
 * Pi user messages can have `content: string` (legacy) or
 * `content: (TextContent | ImageContent)[]`. For the string case we
 * convert to an array first. For the array case we prepend a new text
 * content block at index 0 (matching how OpenCode injects ahead of any
 * existing text part).
 *
 * If no user message exists at all (e.g. session starts with assistant
 * output, edge case) we synthesize a leading user message holding only
 * the history block — same fallback OpenCode uses (`messages.unshift({
 * info: { role: "user", ... }, parts: [{ type: "text", text: block }] })`).
 *
 * Returns true when an injection happened.
 */
function injectHistoryBlockIntoFirstUserMessage(
	piMessages: PiAgentMessage[],
	historyBlock: string,
): boolean {
	for (let i = 0; i < piMessages.length; i++) {
		const msg = piMessages[i];
		if (!msg || msg.role !== "user") continue;

		const userMsg = msg as PiUserMessage;
		if (typeof userMsg.content === "string") {
			// Convert string → array form so the history block sits as a
			// distinct text block ahead of the user's text. Matches the
			// OpenCode write pattern (block + "\n\n" + existing text).
			piMessages[i] = {
				...userMsg,
				content: [
					{ type: "text", text: `${historyBlock}\n\n${userMsg.content}` },
				],
			};
			return true;
		}
		if (Array.isArray(userMsg.content)) {
			// Find the first text content; prepend block to it. Falls back
			// to inserting a new text block at the front when the array is
			// image-only or empty.
			const contentArr = userMsg.content;
			const firstTextIndex = contentArr.findIndex(
				(p) =>
					p &&
					typeof p === "object" &&
					(p as { type?: unknown }).type === "text",
			);
			if (firstTextIndex >= 0) {
				const existing = contentArr[firstTextIndex] as PiTextContent;
				const newContent = contentArr.slice();
				newContent[firstTextIndex] = {
					...existing,
					text: `${historyBlock}\n\n${existing.text}`,
				};
				piMessages[i] = { ...userMsg, content: newContent };
			} else {
				const newContent = [
					{ type: "text" as const, text: historyBlock },
					...contentArr,
				];
				piMessages[i] = { ...userMsg, content: newContent };
			}
			return true;
		}

		// Unknown content shape — replace with array containing only the
		// history block. Defensive; AgentMessage's shape doesn't allow
		// other content forms today.
		piMessages[i] = {
			...userMsg,
			content: [{ type: "text", text: historyBlock }],
		};
		return true;
	}

	// No user message anywhere — inject a synthetic leading user message
	// holding only the history block. Same fallback OpenCode uses.
	piMessages.unshift({
		role: "user",
		content: [{ type: "text", text: historyBlock }],
		timestamp: Date.now(),
	});
	return true;
}

const PI_M1_PLACEHOLDER =
	"<session-history-since>(no new content since last materialization)</session-history-since>";
// Pi uses a STATIC upgrade-state marker, intentionally diverging from OpenCode's
// dynamic getUpgradeState(db, sessionId). OpenCode flips this per-session when a
// `/ctx-session-upgrade` recomp transitions legacy→v2, forcing an m[0] refold.
// Pi has no equivalent per-session upgrade-state transition wired into the m[0]
// markers yet, so a static const is internally consistent (stored marker and
// current marker always match → never falsely triggers, never misses a real Pi
// transition because there is none). Revisit if Pi gains a session-upgrade flow
// that must invalidate m[0].
const PI_M0_UPGRADE_STATE = "pi-m0m1-v2";

/**
 * Real-tokenizer size of ONLY the <session-history> slice of a rendered m[0]
 * (parity with OpenCode's historySliceTokens). The over-budget tightening loop
 * must measure the history block against the history budget, not the whole m[0]
 * — m[0] also carries <project-docs>/<user-profile>/<project-memory>, each with
 * its own budget. Charging those against the history budget over-tightens decay
 * and starves session-history. Returns 0 when there's no history slice.
 */
function historySliceTokensPi(m0Text: string): number {
	const slice = extractM0Block(m0Text, "session-history");
	return slice ? estimateTokens(slice) : 0;
}

export interface PiM0M1State {
	sessionId: string;
	projectIdentity: string;
	projectDirectory: string;
	/** Memory-block trim budget (~4K). Bounds the <project-memory> block. */
	injectionBudgetTokens?: number;
	/** v2 decay-render history budget (~60K). Drives compartment tier demotion.
	 *  Distinct from injectionBudgetTokens — using the memory budget here would
	 *  over-demote every compartment. */
	historyBudgetTokens?: number;
	keyFilesEnabled?: boolean;
	keyFilesTokenBudget?: number;
	/** User-profile block budget (~4K). The m[1] new-user-profile delta is
	 *  trimmed to 25% of this (matches OpenCode renderM1). Defaults when unset. */
	userProfileBudgetTokens?: number;
}

export interface PiM0SnapshotMarkers {
	maxCompartmentSeq: number;
	maxMemoryId: number;
	maxMutationId: number;
	projectMemoryEpoch: number;
	projectUserProfileVersion: number;
	projectDocsHash: string;
	sessionFactsVersion: number;
	materializedAt: number;
	upgradeState: string;
}

export interface PiMaterializeDecision {
	value: boolean;
	reason: string | null;
}

export interface PiM0M1InjectionResult extends PiInjectionResult {
	m0Materialized: boolean;
	m0Reason: string | null;
	m0Bytes: number;
	m1Bytes: number;
}

function decodeCachedM0(value: Buffer | Uint8Array | null): string | null {
	if (!value) return null;
	return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
		"utf8",
	);
}

// v2: session_facts is retired as a render source (facts = promoted memories).
// The m[0] snapshot still carries a sessionFactsVersion field for shape
// stability, but it is pinned to 0 so it never drives re-materialization —
// fact changes no longer affect rendered bytes.
function getSessionFactsVersion(
	_db: ContextDatabase,
	_sessionId: string,
): number {
	return 0;
}

function getCachedMarkers(
	db: ContextDatabase,
	state: PiM0M1State,
): PiM0SnapshotMarkers | null {
	const meta = getOrCreateSessionMeta(db, state.sessionId);
	if (!meta.cachedM0Bytes) return null;
	if (meta.cachedM0MaxCompartmentSeq === null) return null;
	if (meta.cachedM0MaxMemoryId === null) return null;
	return {
		maxCompartmentSeq: meta.cachedM0MaxCompartmentSeq,
		maxMemoryId: meta.cachedM0MaxMemoryId,
		maxMutationId: meta.cachedM0MaxMutationId ?? 0,
		projectMemoryEpoch: meta.cachedM0ProjectMemoryEpoch ?? 0,
		projectUserProfileVersion: meta.cachedM0ProjectUserProfileVersion ?? 0,
		projectDocsHash: meta.cachedM0ProjectDocsHash ?? "",
		sessionFactsVersion: meta.cachedM0SessionFactsVersion ?? 0,
		materializedAt: meta.cachedM0MaterializedAt ?? 0,
		upgradeState: meta.cachedM0UpgradeState ?? "",
	};
}

function readCurrentMarkers(
	db: ContextDatabase,
	state: PiM0M1State,
	projectDocsHash?: string,
): PiM0SnapshotMarkers {
	const compartments = getCompartments(db, state.sessionId);
	const memories = getMemoriesByProject(db, state.projectIdentity, [
		"active",
		"permanent",
	]);
	const projectState = getProjectState(db, state.projectIdentity);
	const globalState = getProjectState(db, GLOBAL_USER_PROFILE_PROJECT_PATH);
	return {
		maxCompartmentSeq:
			compartments.length > 0
				? Math.max(...compartments.map((compartment) => compartment.sequence))
				: 0,
		maxMemoryId:
			memories.length > 0
				? Math.max(...memories.map((memory) => memory.id))
				: 0,
		maxMutationId: getMaxM0MutationId(db, state.sessionId) ?? 0,
		projectMemoryEpoch: projectState?.projectMemoryEpoch ?? 0,
		projectUserProfileVersion: globalState?.projectUserProfileVersion ?? 0,
		projectDocsHash:
			projectDocsHash ??
			readProjectDocsCanonical(state.projectDirectory).canonicalHash,
		sessionFactsVersion: getSessionFactsVersion(db, state.sessionId),
		materializedAt: Date.now(),
		// Dynamic upgrade state (parity with OpenCode getUpgradeState): suffix
		// "legacy" when any legacy=1 compartment remains, else "ready". This makes
		// `/ctx-session-upgrade` (legacy→v2 conversion) flip the marker so m[0]
		// re-materializes with the upgraded tiered content. A static const would
		// leave Pi serving stale legacy-rendered m[0] after an upgrade.
		upgradeState: `${PI_M0_UPGRADE_STATE}:${
			compartments.some((c) => c.legacy === 1) ? "legacy" : "ready"
		}`,
	};
}

export function mustMaterializePi(
	state: PiM0M1State,
	db: ContextDatabase,
): PiMaterializeDecision {
	const meta = getOrCreateSessionMeta(db, state.sessionId);
	const current = readCurrentMarkers(db, state);
	if (!meta.cachedM0Bytes) return { value: true, reason: "first_render" };
	if (meta.cachedM0UpgradeState !== current.upgradeState) {
		return { value: true, reason: "renderer_upgrade" };
	}
	if (current.projectDocsHash !== (meta.cachedM0ProjectDocsHash ?? "")) {
		return { value: true, reason: "project_docs_change" };
	}
	if (current.projectMemoryEpoch !== (meta.cachedM0ProjectMemoryEpoch ?? 0)) {
		return { value: true, reason: "project_memory_change" };
	}
	if (
		current.projectUserProfileVersion !==
		(meta.cachedM0ProjectUserProfileVersion ?? 0)
	) {
		return { value: true, reason: "user_profile_change" };
	}
	// Use !== (not >), matching OpenCode mustMaterialize: a max-id that DECREASES
	// (revert / message.removed shrinking the compartment or mutation set) must
	// still invalidate m[0]. A '>' comparison would miss a decrease and serve a
	// stale cached baseline.
	if (current.maxMutationId !== (meta.cachedM0MaxMutationId ?? 0)) {
		return { value: true, reason: "pending_mutations" };
	}
	if (current.maxCompartmentSeq !== (meta.cachedM0MaxCompartmentSeq ?? 0)) {
		return { value: true, reason: "new_compartment" };
	}
	// maxMemoryId is deliberately NOT a materialization trigger (parity with
	// OpenCode): new memories are additive and surface in m[1] via the
	// maxMemoryId watermark, so they must not bust the m[0] cache. Non-additive
	// memory mutations bump project_memory_epoch instead. session_facts is
	// retired as a render source (facts = promoted memories), so its version is
	// pinned to 0 and never triggers either.
	return { value: false, reason: null };
}

function renderUserProfileBlock(
	db: ContextDatabase,
	wrapper = "user-profile",
	memoriesOverride?: UserMemory[],
): string {
	const memories = memoriesOverride ?? getActiveUserMemories(db);
	if (memories.length === 0) return "";
	return `<${wrapper}>\n${memories
		.map((memory) => `- ${escapeXmlContent(memory.content)}`)
		.join("\n")}\n</${wrapper}>`;
}

export function renderM0Pi(
	state: PiM0M1State,
	db: ContextDatabase,
	projectDocs = readProjectDocsCanonical(state.projectDirectory).renderedBlock,
	decayPressureMultiplier = 1,
	// Atomic-snapshot override: when materializeM0Pi reads markers + memories in
	// one transaction, it passes the SAME memory set here so the rendered m[0]
	// can't include a memory whose id is above the persisted maxMemoryId watermark
	// (which would duplicate it across the m[0]/m[1] split). Mirrors OpenCode,
	// where renderM0 takes memories as a parameter rather than re-reading.
	memoriesOverride?: Memory[],
): string {
	const allMemories =
		memoriesOverride ??
		getMemoriesByProject(db, state.projectIdentity, ["active", "permanent"]);
	// Use the V2 trim + render helpers (shared with OpenCode) so both harnesses
	// emit the SAME structured <project-memory><memory id= category= importance=>
	// shape and the same permanent-first / importance-DESC ordering. A divergent
	// shape here would put different bytes on the wire between OpenCode and Pi.
	// Always trim with the default memory-budget fallback (matching OpenCode),
	// not gated on a truthy injectionBudgetTokens — an unset budget must NOT mean
	// "render every memory untrimmed", which would grow m[0] without bound.
	const memories =
		allMemories.length > 0
			? trimMemoriesToBudgetV2(
					state.sessionId,
					allMemories,
					state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS,
				).renderOrder
			: allMemories;
	const memoryBlock =
		memories.length > 0 ? renderMemoryBlockV2(memories) : undefined;
	// v2: decay-render compartments via the shared module (same validated curve
	// as OpenCode). Facts are NOT rendered (v2 faithful: facts = promoted
	// memories, surfaced via memoryBlock / <project-memory>).
	// The decay-pressure multiplier maps to a proportionally tighter effective
	// budget (lower budget → higher curve pressure → more demotion), keeping the
	// shared decay-curve as the single source of pressure math — same approach as
	// OpenCode renderM0. The materialize loop escalates it when m[0] is over budget.
	const baseHistoryBudget =
		state.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS;
	const decayed = renderDecayedCompartments({
		compartments: getCompartments(db, state.sessionId),
		// v2: use the HISTORY budget (~60K), not the memory injection budget (~4K).
		// Falling back to the memory budget would over-demote every compartment.
		historyBudgetTokens:
			baseHistoryBudget / Math.max(1, decayPressureMultiplier),
	});
	// Sibling-block layout MUST match OpenCode renderM0 exactly (otherwise the
	// two harnesses put different bytes on the wire for the same state):
	//   <project-docs>   — sibling
	//   <user-profile>   — sibling
	//   <session-history>…decayed COMPARTMENTS ONLY…</session-history>
	//   <project-memory> — sibling
	// The <session-history> wrapper contains ONLY the decayed compartments — it
	// does NOT envelope project-docs / user-profile / project-memory. Sections
	// joined by "\n\n".
	const sections: string[] = [];
	if (projectDocs.length > 0) sections.push(projectDocs);
	// Baseline user-profile MUST be trimmed to budget, matching OpenCode renderM0.
	// Rendering all active user memories untrimmed would put different (larger)
	// bytes on the wire than OpenCode for the same state, and let m[0] grow
	// without bound as the global user-profile accumulates.
	const trimmedProfile = trimUserMemoriesToBudget(
		getActiveUserMemories(db),
		state.userProfileBudgetTokens ?? DEFAULT_USER_PROFILE_BUDGET_TOKENS,
	);
	const userProfile = renderUserProfileBlock(
		db,
		"user-profile",
		trimmedProfile,
	);
	if (userProfile.length > 0) sections.push(userProfile);
	sections.push(
		decayed.length > 0
			? `<session-history>\n${decayed}\n</session-history>`
			: "<session-history></session-history>",
	);
	if (memoryBlock) sections.push(memoryBlock);
	return sections.join("\n\n").trim();
}

/** Raised when the m[0] snapshot changed between the read-markers phase and the
 *  persist phase (a concurrent writer — sibling Pi/OpenCode process sharing the
 *  same SQLite DB, or the historian — mutated state mid-materialization). Caught
 *  by the retry wrapper so we never cache m[0] bytes that no longer match the
 *  markers they were rendered from. */
export class PiMaterializeContentionError extends Error {
	constructor(reason: string) {
		super(`pi m[0] materialization contention: ${reason}`);
		this.name = "PiMaterializeContentionError";
	}
}

export function materializeM0Pi(
	state: PiM0M1State,
	db: ContextDatabase,
): { m0: string; snapshotMarkers: PiM0SnapshotMarkers } {
	// Phase 1 (no lock): read markers + render. Rendering can be slow, so we do
	// it OUTSIDE the write lock to keep the BEGIN IMMEDIATE critical section tiny.
	const docs = readProjectDocsCanonical(state.projectDirectory);
	const snapshotMarkers = readCurrentMarkers(db, state, docs.canonicalHash);
	// Capture the memory set ATOMICALLY with the marker read so the rendered m[0]
	// uses exactly the memories the maxMemoryId watermark was computed from. These
	// are back-to-back synchronous reads on the single better-sqlite3 connection
	// with no await between, so no writer can interleave. Passing this set into
	// every renderM0Pi call below prevents a memory whose id is above the
	// watermark from rendering in m[0] AND m[1] (duplicate across the split).
	const snapshotMemories = getMemoriesByProject(db, state.projectIdentity, [
		"active",
		"permanent",
	]);
	// Derive the maxMemoryId watermark from the SAME set we render, not from the
	// separate read inside readCurrentMarkers above. A memory inserted between
	// those two reads would otherwise give a watermark LOWER than the max id we
	// rendered, so that memory would appear in m[0] (rendered here) AND m[1]
	// (id > persisted watermark) — duplicated across the split. Binding the
	// watermark to the rendered set makes them consistent by construction,
	// independent of read interleaving.
	snapshotMarkers.maxMemoryId = snapshotMemories.reduce(
		(max, m) => (m.id > max ? m.id : max),
		0,
	);
	// Over-budget tightening loop (matches OpenCode materializeM0): if the
	// rendered m[0] exceeds the history budget, escalate the decay pressure and
	// re-render up to 3x so tight budgets demote more aggressively. Without this,
	// Pi would select different (looser) tiers than OpenCode under budget pressure.
	let decayPressureMultiplier = 1;
	let m0 = renderM0Pi(
		state,
		db,
		docs.renderedBlock,
		decayPressureMultiplier,
		snapshotMemories,
	);
	const historyBudget =
		state.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS;
	let attempts = 0;
	while (
		historyBudget > 0 &&
		historySliceTokensPi(m0) > historyBudget * 1.05 &&
		attempts < 3
	) {
		decayPressureMultiplier *= 1.15;
		m0 = renderM0Pi(
			state,
			db,
			docs.renderedBlock,
			decayPressureMultiplier,
			snapshotMemories,
		);
		attempts += 1;
	}
	const m0Bytes = Buffer.from(m0, "utf8");

	// Phase 2 + 3 (locked): re-read markers under BEGIN IMMEDIATE; if anything
	// changed since Phase 1, the rendered bytes are stale — roll back and let the
	// caller retry. Otherwise persist the cache atomically. Rendering stays
	// outside the lock so the write-locked critical section is tiny.
	db.exec("BEGIN IMMEDIATE");
	try {
		const current = readCurrentMarkers(db, state, docs.canonicalHash);
		// maxMemoryId deliberately EXCLUDED (parity with OpenCode materializeM0):
		// additive memory writes don't bump projectMemoryEpoch and must NOT bust
		// m[0] — they surface in m[1] via the persisted maxMemoryId watermark. A
		// new memory between Phase 1 and persist doesn't invalidate the rendered
		// m[0]. Non-additive mutations bump projectMemoryEpoch and ARE caught here.
		const stale =
			current.projectMemoryEpoch !== snapshotMarkers.projectMemoryEpoch ||
			current.projectUserProfileVersion !==
				snapshotMarkers.projectUserProfileVersion ||
			current.maxCompartmentSeq !== snapshotMarkers.maxCompartmentSeq ||
			current.maxMutationId !== snapshotMarkers.maxMutationId ||
			current.projectDocsHash !== snapshotMarkers.projectDocsHash ||
			// Inert today (both harnesses pin sessionFactsVersion to 0 — facts are
			// retired in v2), but kept for structural parity with OpenCode
			// materializeM0 so the two stale checks can't silently drift if either
			// harness ever revives the field.
			current.sessionFactsVersion !== snapshotMarkers.sessionFactsVersion ||
			current.upgradeState !== snapshotMarkers.upgradeState;
		if (stale) {
			db.exec("ROLLBACK");
			throw new PiMaterializeContentionError("snapshot changed before persist");
		}
		// Refresh materializedAt to NOW, right before persist (parity with
		// OpenCode materializeM0 inject-compartments.ts:1072). readCurrentMarkers
		// set it at Phase-1 read time, but rendering happens OUTSIDE the lock and
		// can be slow; m[1] freezes the memory-expiry cutoff at this timestamp, so
		// persisting the pre-render time could render an expiry-boundary memory
		// differently than OpenCode. This is a cache-bust (materialize) pass, so a
		// fresh timestamp is correct; defer passes replay the persisted value.
		snapshotMarkers.materializedAt = Date.now();
		persistCachedM0(db, state.sessionId, {
			m0Bytes,
			projectMemoryEpoch: snapshotMarkers.projectMemoryEpoch,
			projectUserProfileVersion: snapshotMarkers.projectUserProfileVersion,
			maxCompartmentSeq: snapshotMarkers.maxCompartmentSeq,
			maxMemoryId: snapshotMarkers.maxMemoryId,
			maxMutationId: snapshotMarkers.maxMutationId,
			projectDocsHash: snapshotMarkers.projectDocsHash,
			materializedAt: snapshotMarkers.materializedAt,
			sessionFactsVersion: snapshotMarkers.sessionFactsVersion,
			upgradeState: snapshotMarkers.upgradeState,
		});

		// Persist the rendered-memory identity in the SAME transaction as the m[0]
		// snapshot (parity with OpenCode materializeM0). `memory_block_ids` /
		// `memory_block_count` are otherwise written only by the dead legacy v1
		// path, so they'd stay frozen at the last legacy value — wrong sidebar
		// "Injected" count AND a stale ctx_search hide-already-visible filter after
		// any memory change (e.g. migration delete+reinserts with new ids).
		// Compute the SAME budget-trimmed set renderM0Pi actually rendered.
		const renderedMemories =
			snapshotMemories.length > 0
				? trimMemoriesToBudgetV2(
						state.sessionId,
						snapshotMemories,
						state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS,
					).renderOrder
				: snapshotMemories;
		const renderedMemoryIds = renderedMemories.map((m) => m.id);
		db.prepare(
			"UPDATE session_meta SET memory_block_count = ?, memory_block_ids = ? WHERE session_id = ?",
		).run(
			renderedMemoryIds.length,
			JSON.stringify(renderedMemoryIds),
			state.sessionId,
		);

		db.exec("COMMIT");
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// already rolled back
		}
		throw error;
	}
	return { m0, snapshotMarkers };
}

/** Retry materializeM0Pi on contention (parity with OpenCode materializeWithRetry). */
export function materializeM0PiWithRetry(
	state: PiM0M1State,
	db: ContextDatabase,
	maxRetries = 3,
): { m0: string; snapshotMarkers: PiM0SnapshotMarkers } {
	let lastError: PiMaterializeContentionError | null = null;
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			return materializeM0Pi(state, db);
		} catch (error) {
			if (!(error instanceof PiMaterializeContentionError)) throw error;
			lastError = error;
		}
	}
	throw (
		lastError ??
		new PiMaterializeContentionError("materialization contention exhausted")
	);
}

export function renderM1Pi(
	state: PiM0M1State,
	db: ContextDatabase,
	markers: PiM0SnapshotMarkers,
): string {
	const sections: string[] = [];
	if (state.keyFilesEnabled) {
		// Guard key-files render (parity with OpenCode renderM1): a corrupted
		// key-files index or filesystem error must degrade gracefully, not abort
		// the entire m[1] render and drop all volatile-delta content.
		try {
			const keyFiles = buildKeyFilesBlock(db, state.projectDirectory, {
				enabled: true,
				tokenBudget: state.keyFilesTokenBudget ?? 10_000,
			});
			if (keyFiles) sections.push(keyFiles);
		} catch (error) {
			logSession(state.sessionId, "key-files render for m[1] failed:", error);
		}
	}

	const newCompartments = getCompartments(db, state.sessionId).filter(
		(compartment) => compartment.sequence > markers.maxCompartmentSeq,
	);
	if (newCompartments.length > 0) {
		// New compartments are newest deltas → always render at P1 (full fidelity).
		const body = newCompartments
			.map((compartment) => renderCompartmentAtTier(compartment, 1))
			.join("\n\n");
		sections.push(`<new-compartments>\n${body}\n</new-compartments>`);
	}

	const newMemories = getMemoriesByProject(
		db,
		state.projectIdentity,
		["active", "permanent"],
		// Freeze expiry to the m[0] materialization timestamp (parity with
		// OpenCode readNewMemoriesForM1): defer passes replay the same markers, so
		// a memory crossing expires_at between passes can't silently shift m[1].
		markers.materializedAt,
	).filter((memory) => memory.id > markers.maxMemoryId);
	if (newMemories.length > 0) {
		// Trim to 25% of the memory budget and V2-render with the "new-memories"
		// wrapper — same helper, shape, AND budget cap OpenCode's renderM1 uses.
		// Without the cap, m[1] grows unbounded as memories accumulate between
		// m[0] materializations (m[1] is the volatile delta; it must stay small).
		const memoryBudget =
			state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS;
		const trimmedNewMemories = trimMemoriesToBudgetV2(
			state.sessionId,
			newMemories,
			Math.max(1, Math.floor(memoryBudget * 0.25)),
		).renderOrder;
		sections.push(renderMemoryBlockV2(trimmedNewMemories, "new-memories"));
	}

	// new-user-profile delta: when the global user-profile version advanced since
	// this m[0] baseline was materialized, surface the current profile under a
	// <new-user-profile> wrapper so freshly promoted user memories reach the agent
	// in m[1] before the next m[0] materialization folds them into the baseline.
	// Trimmed to 25% of the user-profile budget (matches OpenCode renderM1).
	const currentUserProfileVersion =
		getProjectState(db, GLOBAL_USER_PROFILE_PROJECT_PATH)
			?.projectUserProfileVersion ?? 0;
	if (currentUserProfileVersion !== markers.projectUserProfileVersion) {
		const profileBudget =
			state.userProfileBudgetTokens ?? DEFAULT_USER_PROFILE_BUDGET_TOKENS;
		const trimmedProfile = trimUserMemoriesToBudget(
			getActiveUserMemories(db),
			Math.max(1, Math.floor(profileBudget * 0.25)),
		);
		const profileBlock = renderUserProfileBlock(
			db,
			"new-user-profile",
			trimmedProfile,
		);
		if (profileBlock) sections.push(profileBlock);
	}

	if (sections.length === 0) return PI_M1_PLACEHOLDER;
	// Join with "\n" (single newline) to match OpenCode renderM1 exactly — the
	// m[1] delta bytes must be identical across harnesses.
	return `<session-history-since>\n${sections.join("\n")}\n</session-history-since>`;
}

function findCompartmentBoundaryForSnapshot(
	db: ContextDatabase,
	sessionId: string,
	markers: PiM0SnapshotMarkers,
): string | null {
	const compartments = getCompartments(db, sessionId).filter(
		(compartment) => compartment.sequence <= markers.maxCompartmentSeq,
	);
	const last = compartments.at(-1);
	return last?.endMessageId && last.endMessageId.length > 0
		? last.endMessageId
		: null;
}

function prependM0M1Messages(
	piMessages: PiAgentMessage[],
	m0: string,
	m1: string,
): void {
	const firstTimestamp = piMessages[0]?.timestamp;
	const baseTimestamp =
		typeof firstTimestamp === "number" ? firstTimestamp : Date.now();
	piMessages.unshift(
		{
			role: "user",
			content: [{ type: "text", text: m0 }],
			timestamp: baseTimestamp - 2,
		},
		{
			role: "user",
			content: [{ type: "text", text: m1 }],
			timestamp: baseTimestamp - 1,
		},
	);
}

export function injectM0M1Pi(
	state: PiM0M1State,
	db: ContextDatabase,
	piMessages: PiAgentMessage[],
	entryIds?: readonly (string | undefined)[],
): PiM0M1InjectionResult {
	let decision = mustMaterializePi(state, db);
	let m0: string;
	let markers: PiM0SnapshotMarkers | null;
	let materialized = false;
	let contentionExhausted = false;
	if (decision.value) {
		// On contention exhaustion, reuse the cached m[0] rather than throwing
		// (matches OpenCode injectM0M1). A sibling process mutated state mid-
		// materialization; serving the slightly-stale cached baseline this pass
		// is correct and the next pass retries — dropping injection entirely
		// would lose the whole history block.
		try {
			const result = materializeM0PiWithRetry(state, db);
			m0 = result.m0;
			markers = result.snapshotMarkers;
			materialized = true;
		} catch (error) {
			if (!(error instanceof PiMaterializeContentionError)) throw error;
			const meta = getOrCreateSessionMeta(db, state.sessionId);
			const cached = decodeCachedM0(meta.cachedM0Bytes);
			const cachedMarkers = getCachedMarkers(db, state);
			if (cached && cachedMarkers) {
				// Prefer reusing the cached baseline (matches OpenCode): a sibling
				// process mutated state mid-materialization; serving the slightly
				// stale cached m[0] this pass is correct and the next pass retries.
				contentionExhausted = true;
				m0 = cached;
				markers = cachedMarkers;
				logSession(
					state.sessionId,
					"pi m[0] materialization contention exhausted; reusing cached m[0]",
				);
			} else {
				// No cached baseline to fall back to — this happens when the cache
				// was deliberately cleared THIS pass (cache-bust) and then hit
				// contention. Dropping injection would lose the entire history
				// block, so render a fresh (non-persisted) m[0] as a last resort.
				// It is not cached because we couldn't win the materialize lock;
				// the next pass re-materializes and persists.
				const docs = readProjectDocsCanonical(state.projectDirectory);
				markers = readCurrentMarkers(db, state, docs.canonicalHash);
				// CACHE STABILITY (parity with OpenCode renderFreshM0NonPersisted):
				// materializedAt feeds the m[1] expiry cutoff (renderM1Pi). It must
				// be stable across consecutive fallback passes — live Date.now()
				// (from readCurrentMarkers) would shift m[1] bytes when a memory's
				// expires_at is straddled by two defer passes. Freeze to the last
				// persisted materialization; if none exists, use 0 (stable: renders
				// all memories with no expiry filtering, deterministic across passes).
				{
					const meta2 = getOrCreateSessionMeta(db, state.sessionId);
					markers.materializedAt = meta2.cachedM0MaterializedAt ?? 0;
				}
				// Apply the over-budget tightening loop (parity with
				// materializeM0Pi) so the fallback m[0] respects the budget the
				// same way the persisted path does.
				{
					const historyBudget =
						state.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS;
					// Freeze the memory snapshot ONCE for all fallback render
					// attempts (parity with materializeM0Pi): a single read passed
					// into every renderM0Pi call keeps the m[0] baseline byte-stable
					// WITHIN a pass. Also pass the frozen materializedAt cutoff (set
					// just above) so the expiry filter is identical ACROSS consecutive
					// fallback defer passes too — without it, a live Date.now() default
					// would drop a memory crossing expires_at between two passes and
					// shift the m[0] baseline bytes (parity with OpenCode
					// renderFreshM0NonPersisted's frozen-cutoff baseline read).
					const fallbackMemories = getMemoriesByProject(
						db,
						state.projectIdentity,
						["active", "permanent"],
						markers.materializedAt,
					);
					let dpm = 1;
					m0 = renderM0Pi(state, db, docs.renderedBlock, dpm, fallbackMemories);
					let attempts = 0;
					while (
						historyBudget > 0 &&
						historySliceTokensPi(m0) > historyBudget * 1.05 &&
						attempts < 3
					) {
						dpm *= 1.15;
						m0 = renderM0Pi(
							state,
							db,
							docs.renderedBlock,
							dpm,
							fallbackMemories,
						);
						attempts += 1;
					}
				}
				contentionExhausted = true;
				logSession(
					state.sessionId,
					"pi m[0] materialization contention exhausted with no cached fallback; rendered fresh non-persisted m[0]",
				);
			}
		}
	} else {
		const meta = getOrCreateSessionMeta(db, state.sessionId);
		m0 = decodeCachedM0(meta.cachedM0Bytes) ?? "";
		markers = getCachedMarkers(db, state);
		if (!m0 || !markers) {
			decision = { value: true, reason: "cache_invalid" };
			const result = materializeM0PiWithRetry(state, db);
			m0 = result.m0;
			markers = result.snapshotMarkers;
			materialized = true;
		}
	}

	let m1 = renderM1Pi(state, db, markers);
	// Forced +15% drift refold — skip when contention exhausted (we're already
	// reusing a cached m[0]; refolding would just hit the same contention).
	if (
		!materialized &&
		!contentionExhausted &&
		m0.length > 0 &&
		// Only refold on GENUINE accumulated delta — never when m[1] is just the
		// empty placeholder (otherwise a tiny baseline refolds every defer pass,
		// breaking byte-identical-defer cache stability). Matches OpenCode.
		m1 !== PI_M1_PLACEHOLDER &&
		m1.length > m0.length * 0.15
	) {
		decision = { value: true, reason: "drift" };
		try {
			const result = materializeM0PiWithRetry(state, db);
			m0 = result.m0;
			markers = result.snapshotMarkers;
			m1 = renderM1Pi(state, db, markers);
			materialized = true;
		} catch (error) {
			if (!(error instanceof PiMaterializeContentionError)) throw error;
			// Keep the un-refolded m[0]/m[1]; next pass retries the fold.
		}
	}

	const boundaryId = findCompartmentBoundaryForSnapshot(
		db,
		state.sessionId,
		markers,
	);
	const skippedVisibleMessages = boundaryId
		? trimPiMessagesToBoundary(piMessages, entryIds, boundaryId)
		: 0;
	prependM0M1Messages(piMessages, m0, m1);
	logSession(
		state.sessionId,
		`injected m[0]/m[1] into Pi messages (${m0.length} + ${m1.length} bytes, materialized=${materialized}${decision.reason ? ` reason=${decision.reason}` : ""})`,
	);
	return {
		injected: true,
		compartmentCount: getCompartments(db, state.sessionId).length,
		factCount: 0, // v2: facts retired as a render source (facts = promoted memories)
		memoryCount: getMemoriesByProject(db, state.projectIdentity, [
			"active",
			"permanent",
		]).length,
		skippedVisibleMessages,
		m0Materialized: materialized,
		m0Reason: decision.reason,
		m0Bytes: m0.length,
		m1Bytes: m1.length,
	};
}

export function clearM0M1PiCache(
	db: ContextDatabase,
	sessionId: string,
	reason: string,
): void {
	clearCachedM0(db, sessionId);
	logSession(sessionId, `cleared cached m[0] (${reason})`);
}

export interface PiInjectionResult {
	injected: boolean;
	compartmentCount: number;
	factCount: number;
	memoryCount: number;
	skippedVisibleMessages: number;
}

/**
 * Prepare and write the `<session-history>` block into a Pi message
 * array. Owns the full inject lifecycle: builds the projection, calls
 * the shared prepareCompartmentInjection, applies the boundary trim
 * back to Pi messages, and writes the rendered block into the first
 * user message.
 *
 * Caller MUST manage `isCacheBusting` via the shared
 * `historyRefreshSessions` signal — same contract as OpenCode. On defer
 * passes (`isCacheBusting=false`) the shared injection cache replays
 * the previous result so provider prompt cache stays stable.
 */
export function injectSessionHistoryIntoPi(
	db: ContextDatabase,
	sessionId: string,
	piMessages: PiAgentMessage[],
	isCacheBusting: boolean,
	projectPath: string | undefined,
	injectionBudgetTokens: number | undefined,
	temporalAwareness: boolean | undefined,
	entryIds?: readonly (string | undefined)[],
): PiInjectionResult {
	// Project Pi messages into a MessageLike[] so the shared trimmer can
	// find the cutoff by synthesized id. Mutations to the projection are
	// intentionally discarded — we re-do the trim against piMessages
	// using the boundary id the shared call returns.
	const projection = buildMessageLikeProjection(piMessages, entryIds);
	const beforeProjectionLen = projection.length;
	const prepared: PreparedCompartmentInjection | null =
		prepareCompartmentInjection(
			db,
			sessionId,
			projection,
			isCacheBusting,
			projectPath,
			injectionBudgetTokens,
			temporalAwareness,
		);

	if (!prepared) {
		return {
			injected: false,
			compartmentCount: 0,
			factCount: 0,
			memoryCount: 0,
			skippedVisibleMessages: 0,
		};
	}

	// Apply the same boundary trim the shared call performed on the
	// projection, but back to the real Pi message array. The projection
	// already reflects the trim (its length shrank); we use the cached
	// boundary id to do the equivalent trim on Pi.
	//
	// `compartmentEndMessageId` is nullable: a non-null non-empty value
	// means "trim Pi messages to this boundary"; null/empty means "no
	// trim" (either fresh session with no compartments yet, or the
	// degraded-cache path where the boundary message is missing from
	// the visible array).
	const boundaryId = prepared.compartmentEndMessageId;
	const skippedVisible =
		boundaryId != null && boundaryId.length > 0
			? trimPiMessagesToBoundary(piMessages, entryIds, boundaryId)
			: prepared.skippedVisibleMessages;

	// Render: write the prepared block into Pi message[0]'s first text
	// content. `prepared.block` is the inner XML; the wrapper tags are
	// added here so the format matches OpenCode exactly.
	const historyBlock = `<session-history>\n${prepared.block}\n</session-history>`;
	const wrote = injectHistoryBlockIntoFirstUserMessage(
		piMessages,
		historyBlock,
	);

	if (wrote) {
		const memoryLabel =
			prepared.memoryCount > 0 ? ` + ${prepared.memoryCount} memories` : "";
		if (prepared.compartmentCount > 0) {
			logSession(
				sessionId,
				`injected ${prepared.compartmentCount} compartments + ${prepared.factCount} facts${memoryLabel} into message[0] (skipped ${skippedVisible}/${beforeProjectionLen} visible messages)`,
			);
		} else {
			logSession(
				sessionId,
				`injected ${prepared.factCount} facts${memoryLabel} into message[0] (no compartments yet)`,
			);
		}
	}

	return {
		injected: wrote,
		compartmentCount: prepared.compartmentCount,
		factCount: prepared.factCount,
		memoryCount: prepared.memoryCount,
		skippedVisibleMessages: skippedVisible,
	};
}
