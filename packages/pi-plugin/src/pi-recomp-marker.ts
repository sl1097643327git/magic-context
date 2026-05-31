import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	type ContextDatabase,
	clearPendingPiCompactionMarkerStateIf,
	setPendingPiCompactionMarkerState,
} from "@magic-context/core/features/magic-context/storage";
import { applyDeferredPiCompactionMarker } from "./compaction-marker-manager-pi";
import { signalPiDeferredHistoryRefresh } from "./context-handler";
import {
	buildPiCompactionSummary,
	findFirstKeptEntryId,
} from "./pi-historian-runner";

/**
 * Advance the Pi native compaction marker to the latest compartment boundary
 * after a recomp/upgrade republish, so `getBranch()` returns only the kept tail
 * and the JSONL branch actually trims.
 *
 * Shared by `/ctx-recomp` AND `/ctx-session-upgrade`. The upgrade path is a full
 * recomp that rebuilds every compartment; without this call it republished
 * compartments but never moved the native marker, so the entire pre-upgrade
 * branch stayed visible and grew unbounded until a later incremental historian
 * pass happened to advance it. (The m[0]/m[1] materialization signals the
 * upgrade already fires drive the synthetic `<session-history>` render — NOT the
 * native marker that trims `getBranch()`; those are separate mechanisms.)
 *
 * No-ops safely when the Pi session manager exposes neither appendCompaction nor
 * getBranch, when there is no compartment yet, or when the boundary cannot be
 * resolved to a real replay-safe entry id (findFirstKeptEntryId defers on
 * folded-toolResult boundaries — returning null — so we never stage an
 * unmatchable synthetic marker).
 */
export function queueAndApplyPiRecompMarker(args: {
	db: ContextDatabase;
	sessionId: string;
	ctx: unknown;
}): void {
	const appendCompaction = resolvePiAppendCompaction(args.ctx);
	const readBranchEntries = resolvePiReadBranchEntries(args.ctx);
	if (!appendCompaction || !readBranchEntries) return;

	const compartments = getCompartments(args.db, args.sessionId);
	const last = compartments[compartments.length - 1];
	if (!last) return;

	let firstKeptEntryId: string | null = null;
	try {
		firstKeptEntryId = findFirstKeptEntryId(
			readBranchEntries(),
			last.endMessage,
		);
	} catch {
		firstKeptEntryId = null;
	}
	if (!firstKeptEntryId || last.endMessageId.length === 0) return;

	const pending = {
		firstKeptEntryId,
		endMessageId: last.endMessageId,
		ordinal: last.endMessage,
		tokensBefore: 0,
		summary: buildPiCompactionSummary(compartments),
		publishedAt: Date.now(),
	};

	setPendingPiCompactionMarkerState(args.db, args.sessionId, pending);
	const outcome = applyDeferredPiCompactionMarker(
		{ db: args.db, appendCompaction, readBranchEntries },
		args.sessionId,
		pending,
	);
	if (outcome.kind === "retryable-failure") {
		signalPiDeferredHistoryRefresh(args.sessionId);
		return;
	}
	if (
		!clearPendingPiCompactionMarkerStateIf(args.db, args.sessionId, pending)
	) {
		signalPiDeferredHistoryRefresh(args.sessionId);
	}
}

function resolvePiAppendCompaction(
	ctx: unknown,
):
	| ((
			summary: string,
			firstKeptEntryId: string,
			tokensBefore: number,
			details?: unknown,
			fromHook?: boolean,
	  ) => string | undefined)
	| undefined {
	const sm = (ctx as { sessionManager?: unknown })?.sessionManager as
		| {
				appendCompaction?: (
					summary: string,
					firstKeptEntryId: string,
					tokensBefore: number,
					details?: unknown,
					fromHook?: boolean,
				) => string | undefined;
		  }
		| undefined;
	if (typeof sm?.appendCompaction !== "function") return undefined;
	return sm.appendCompaction.bind(sm);
}

function resolvePiReadBranchEntries(
	ctx: unknown,
): (() => unknown[]) | undefined {
	const sm = (ctx as { sessionManager?: unknown })?.sessionManager as
		| { getBranch?: () => unknown[] }
		| undefined;
	if (typeof sm?.getBranch !== "function") return undefined;
	return () => {
		try {
			const entries = sm.getBranch?.call(sm);
			return Array.isArray(entries) ? entries : [];
		} catch {
			return [];
		}
	};
}
