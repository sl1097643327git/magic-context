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

import {
	type ContextDatabase,
	GLOBAL_USER_PROFILE_PROJECT_PATH,
	buildCompartmentBlock,
	clearCachedM0,
	escapeXmlContent,
	getCompartments,
	getMaxM0MutationId,
	getOrCreateSessionMeta,
	getProjectState,
	getSessionFacts,
	persistCachedM0,
	readProjectDocsCanonical,
} from "@magic-context/core/features/magic-context/storage";
import { getMemoriesByProject } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { getActiveUserMemories } from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import { buildKeyFilesBlock } from "@magic-context/core/hooks/magic-context/key-files-block";
import {
	type PreparedCompartmentInjection,
	prepareCompartmentInjection,
	renderMemoryBlock,
	trimMemoriesToBudget,
} from "@magic-context/core/hooks/magic-context/inject-compartments";
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
const PI_M0_UPGRADE_STATE = "pi-m0m1-v2";

export interface PiM0M1State {
	sessionId: string;
	projectIdentity: string;
	projectDirectory: string;
	injectionBudgetTokens?: number;
	keyFilesEnabled?: boolean;
	keyFilesTokenBudget?: number;
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

function getSessionFactsVersion(db: ContextDatabase, sessionId: string): number {
	try {
		const row = db
			.prepare(
				"SELECT COALESCE(MAX(updated_at), 0) AS version FROM session_facts WHERE session_id = ?",
			)
			.get(sessionId) as { version?: number } | undefined;
		return typeof row?.version === "number" ? row.version : 0;
	} catch {
		return 0;
	}
}

function getCachedMarkers(db: ContextDatabase, state: PiM0M1State): PiM0SnapshotMarkers | null {
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
			memories.length > 0 ? Math.max(...memories.map((memory) => memory.id)) : 0,
		maxMutationId: getMaxM0MutationId(db, state.sessionId) ?? 0,
		projectMemoryEpoch: projectState?.projectMemoryEpoch ?? 0,
		projectUserProfileVersion: globalState?.projectUserProfileVersion ?? 0,
		projectDocsHash:
			projectDocsHash ?? readProjectDocsCanonical(state.projectDirectory).canonicalHash,
		sessionFactsVersion: getSessionFactsVersion(db, state.sessionId),
		materializedAt: Date.now(),
		upgradeState: PI_M0_UPGRADE_STATE,
	};
}

export function mustMaterializePi(
	state: PiM0M1State,
	db: ContextDatabase,
): PiMaterializeDecision {
	const meta = getOrCreateSessionMeta(db, state.sessionId);
	const current = readCurrentMarkers(db, state);
	if (!meta.cachedM0Bytes) return { value: true, reason: "first_render" };
	if (meta.cachedM0UpgradeState !== PI_M0_UPGRADE_STATE) {
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
	if (current.maxMutationId > (meta.cachedM0MaxMutationId ?? 0)) {
		return { value: true, reason: "pending_mutations" };
	}
	if (current.maxCompartmentSeq > (meta.cachedM0MaxCompartmentSeq ?? 0)) {
		return { value: true, reason: "new_compartment" };
	}
	if (current.maxMemoryId > (meta.cachedM0MaxMemoryId ?? 0)) {
		return { value: true, reason: "new_memory" };
	}
	if (current.sessionFactsVersion !== (meta.cachedM0SessionFactsVersion ?? 0)) {
		return { value: true, reason: "session_facts_change" };
	}
	return { value: false, reason: null };
}

function renderUserProfileBlock(db: ContextDatabase): string {
	const memories = getActiveUserMemories(db);
	if (memories.length === 0) return "";
	return `<user-profile>\n${memories
		.map((memory) => `- ${escapeXmlContent(memory.content)}`)
		.join("\n")}\n</user-profile>`;
}

export function renderM0Pi(
	state: PiM0M1State,
	db: ContextDatabase,
	projectDocs = readProjectDocsCanonical(state.projectDirectory).renderedBlock,
): string {
	let memories = getMemoriesByProject(db, state.projectIdentity, [
		"active",
		"permanent",
	]);
	if (state.injectionBudgetTokens && memories.length > 0) {
		memories = trimMemoriesToBudget(
			state.sessionId,
			memories,
			state.injectionBudgetTokens,
		);
	}
	const memoryBlock = renderMemoryBlock(memories) ?? undefined;
	const history = buildCompartmentBlock(
		getCompartments(db, state.sessionId),
		getSessionFacts(db, state.sessionId),
		memoryBlock,
	);
	const sections = [projectDocs, renderUserProfileBlock(db), history].filter(
		(section) => section.length > 0,
	);
	if (sections.length === 0) return "<session-history></session-history>";
	return `<session-history>\n${sections.join("\n\n")}\n</session-history>`;
}

export function materializeM0Pi(
	state: PiM0M1State,
	db: ContextDatabase,
): { m0: string; snapshotMarkers: PiM0SnapshotMarkers } {
	const docs = readProjectDocsCanonical(state.projectDirectory);
	const snapshotMarkers = readCurrentMarkers(db, state, docs.canonicalHash);
	const m0 = renderM0Pi(state, db, docs.renderedBlock);
	persistCachedM0(db, state.sessionId, {
		m0Bytes: Buffer.from(m0, "utf8"),
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
	return { m0, snapshotMarkers };
}

export function renderM1Pi(
	state: PiM0M1State,
	db: ContextDatabase,
	markers: PiM0SnapshotMarkers,
): string {
	const sections: string[] = [];
	if (state.keyFilesEnabled) {
		const keyFiles = buildKeyFilesBlock(db, state.projectDirectory, {
			enabled: true,
			tokenBudget: state.keyFilesTokenBudget ?? 10_000,
		});
		if (keyFiles) sections.push(keyFiles);
	}

	const newCompartments = getCompartments(db, state.sessionId).filter(
		(compartment) => compartment.sequence > markers.maxCompartmentSeq,
	);
	if (newCompartments.length > 0) {
		sections.push(
			`<new-compartments>\n${buildCompartmentBlock(newCompartments, [])}\n</new-compartments>`,
		);
	}

	const newMemories = getMemoriesByProject(db, state.projectIdentity, [
		"active",
		"permanent",
	]).filter((memory) => memory.id > markers.maxMemoryId);
	if (newMemories.length > 0) {
		sections.push(
			`<new-memories>\n${renderMemoryBlock(newMemories) ?? ""}\n</new-memories>`,
		);
	}

	if (sections.length === 0) return PI_M1_PLACEHOLDER;
	return `<session-history-since>\n${sections.join("\n\n")}\n</session-history-since>`;
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

function prependM0M1Messages(piMessages: PiAgentMessage[], m0: string, m1: string): void {
	const firstTimestamp = piMessages[0]?.timestamp;
	const baseTimestamp = typeof firstTimestamp === "number" ? firstTimestamp : Date.now();
	piMessages.unshift(
		{ role: "user", content: [{ type: "text", text: m0 }], timestamp: baseTimestamp - 2 },
		{ role: "user", content: [{ type: "text", text: m1 }], timestamp: baseTimestamp - 1 },
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
	if (decision.value) {
		const result = materializeM0Pi(state, db);
		m0 = result.m0;
		markers = result.snapshotMarkers;
		materialized = true;
	} else {
		const meta = getOrCreateSessionMeta(db, state.sessionId);
		m0 = decodeCachedM0(meta.cachedM0Bytes) ?? "";
		markers = getCachedMarkers(db, state);
		if (!m0 || !markers) {
			decision = { value: true, reason: "cache_invalid" };
			const result = materializeM0Pi(state, db);
			m0 = result.m0;
			markers = result.snapshotMarkers;
			materialized = true;
		}
	}

	let m1 = renderM1Pi(state, db, markers);
	if (!materialized && m0.length > 0 && m1.length > m0.length * 0.15) {
		decision = { value: true, reason: "drift" };
		const result = materializeM0Pi(state, db);
		m0 = result.m0;
		markers = result.snapshotMarkers;
		m1 = renderM1Pi(state, db, markers);
		materialized = true;
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
		factCount: getSessionFacts(db, state.sessionId).length,
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
