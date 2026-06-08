import { isRecord } from "../../shared/record-type-guard";
import { stableStringify } from "../../shared/stable-json";
import { estimateTokens } from "./read-session-formatting";
import type { RawMessage } from "./read-session-raw";

export interface TrueRawTokenBreakdown {
    text: number;
    reasoning: number;
    toolInput: number;
    toolOutput: number;
    image: number;
    other: number;
    total: number;
}

export interface TrueRawEstimateOptions {
    providerShapeVersion: "opencode-v1" | "pi-folded-v1";
    imageTokenHeuristic?: (part: unknown) => number;
}

export interface TrueRawTokenIndex {
    readonly sessionId: string;
    readonly providerShapeVersion: string;
    readonly rawMessageCount: number;
    tokenForOrdinal(ordinal: number): number;
    messageIdAtOrdinal(ordinal: number): string | null;
    suffixTokensFromOrdinal(ordinal: number): number;
    rangeTokens(startInclusive: number, endExclusive: number): number;
    findSuffixStartForTokens(tokens: number): number;
    findHeadEndForCap(startInclusive: number, endExclusive: number, capTokens: number): number;
}

export interface ToolArc {
    callId: string;
    invOrdinal: number;
    resOrdinal: number | null;
}

export interface TrueRawTokenIndexBuildOptions extends TrueRawEstimateOptions {
    cacheNamespace: string;
}

interface CachedMessageEstimate {
    breakdown: TrueRawTokenBreakdown;
    keyEstimateBytes: number;
}

interface ToolSignal {
    callId: string;
    hasInput: boolean;
    hasOutput: boolean;
    inputText: string;
    outputText: string;
}

const MAX_MESSAGE_CACHE_ENTRIES = 100_000;
const MAX_MESSAGE_CACHE_KEY_BYTES = 64 * 1024 * 1024;
const messageEstimateCache = new Map<string, CachedMessageEstimate>();
let messageEstimateCacheBytes = 0;

const EMPTY_BREAKDOWN: TrueRawTokenBreakdown = {
    text: 0,
    reasoning: 0,
    toolInput: 0,
    toolOutput: 0,
    image: 0,
    other: 0,
    total: 0,
};

function addBreakdown(
    target: TrueRawTokenBreakdown,
    kind: keyof TrueRawTokenBreakdown,
    value: number,
): void {
    if (kind === "total") return;
    const safeValue = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
    target[kind] += safeValue;
    target.total += safeValue;
}

function estimateStructured(value: unknown): number {
    if (typeof value === "string") return estimateTokens(value);
    if (value === undefined || value === null) return 0;
    return estimateTokens(stableStringify(value));
}

function firstStringField(
    record: Record<string, unknown>,
    fields: readonly string[],
): string | null {
    for (const field of fields) {
        const value = record[field];
        if (typeof value === "string" && value.length > 0) return value;
    }
    return null;
}

function stringValue(value: unknown): string {
    if (typeof value === "string") return value;
    if (value === undefined || value === null) return "";
    return stableStringify(value);
}

function textFromToolResultContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        const pieces: string[] = [];
        for (const entry of content) {
            if (typeof entry === "string") {
                pieces.push(entry);
            } else if (isRecord(entry)) {
                const text = firstStringField(entry, ["text", "content", "value"]);
                pieces.push(text ?? stableStringify(entry));
            } else if (entry !== null && entry !== undefined) {
                pieces.push(String(entry));
            }
        }
        return pieces.join("\n");
    }
    return stringValue(content);
}

function looksImageLike(part: Record<string, unknown>): boolean {
    const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
    const mime = typeof part.mime === "string" ? part.mime.toLowerCase() : "";
    const mediaType = typeof part.mediaType === "string" ? part.mediaType.toLowerCase() : "";
    return (
        type.includes("image") ||
        mime.startsWith("image/") ||
        mediaType.startsWith("image/") ||
        part.image_url !== undefined ||
        part.imageUrl !== undefined ||
        part.image !== undefined
    );
}

function defaultImageTokenHeuristic(part: unknown): number {
    if (isRecord(part)) {
        const width = part.width;
        const height = part.height;
        if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
            return Math.max(256, Math.min(4096, Math.ceil((width * height) / 750)));
        }
    }
    return 1024;
}

function partType(part: Record<string, unknown>): string {
    return typeof part.type === "string" ? part.type : "";
}

function callIdFromPart(part: Record<string, unknown>): string {
    const direct = firstStringField(part, ["callID", "callId", "toolCallId", "tool_call_id", "id"]);
    if (direct) return direct;
    const state = isRecord(part.state) ? part.state : null;
    return state
        ? (firstStringField(state, ["callID", "callId", "toolCallId", "tool_call_id", "id"]) ?? "")
        : "";
}

function toolSignalFromPart(part: unknown): ToolSignal | null {
    if (!isRecord(part)) return null;
    const type = partType(part);
    const state = isRecord(part.state) ? part.state : null;
    const callId = callIdFromPart(part);
    if (!callId && type !== "tool") return null;

    if (type === "tool") {
        const hasInput = state !== null && state.input !== undefined;
        const outputValue =
            state?.output ??
            (state?.output === undefined ? (state?.error ?? state?.result) : undefined);
        const hasOutput = outputValue !== undefined;
        const providerExecuted = part.providerExecuted === true;
        const openInvocation = !providerExecuted && hasInput && !hasOutput;
        return {
            callId,
            hasInput: hasInput || openInvocation,
            hasOutput,
            inputText: hasInput ? stringValue(state?.input) : "",
            outputText: hasOutput ? stringValue(outputValue) : "",
        };
    }

    if (type === "tool-invocation") {
        const args = part.args ?? part.input;
        return {
            callId,
            hasInput: args !== undefined,
            hasOutput: false,
            inputText: args !== undefined ? stringValue(args) : "",
            outputText: "",
        };
    }

    if (type === "tool_use") {
        const input = part.input;
        return {
            callId,
            hasInput: input !== undefined,
            hasOutput: false,
            inputText: input !== undefined ? stringValue(input) : "",
            outputText: "",
        };
    }

    if (type === "tool_result") {
        const content = part.content ?? part.output ?? part.result;
        return {
            callId,
            hasInput: false,
            hasOutput: content !== undefined,
            inputText: "",
            outputText: content !== undefined ? textFromToolResultContent(content) : "",
        };
    }

    return null;
}

function partCheapFingerprint(part: unknown): string {
    if (!isRecord(part)) return `${typeof part}:${String(part).length}`;
    const version = part.updated_at ?? part.updatedAt ?? part.version ?? part.revision ?? "";
    const type = typeof part.type === "string" ? part.type : "";
    let byteLength = 0;
    for (const value of Object.values(part)) {
        if (typeof value === "string") byteLength += value.length;
        else if (Array.isArray(value)) byteLength += value.length;
        else if (isRecord(value)) byteLength += Object.keys(value).length;
    }
    return `${type}:${String(version)}:${byteLength}`;
}

function messageCacheKey(
    message: RawMessage,
    options: TrueRawTokenIndexBuildOptions | TrueRawEstimateOptions,
): string {
    const namespace = "cacheNamespace" in options ? options.cacheNamespace : "estimate";
    const cheapFingerprint = message.parts.map(partCheapFingerprint).join("|");
    return [
        namespace,
        options.providerShapeVersion,
        message.id || `ordinal:${message.ordinal}`,
        message.role,
        message.parts.length,
        cheapFingerprint,
    ].join("\0");
}

function setCachedEstimate(key: string, breakdown: TrueRawTokenBreakdown): void {
    const keyEstimateBytes = key.length * 2 + 64;
    const existing = messageEstimateCache.get(key);
    if (existing) messageEstimateCacheBytes -= existing.keyEstimateBytes;
    messageEstimateCache.set(key, { breakdown, keyEstimateBytes });
    messageEstimateCacheBytes += keyEstimateBytes;
    while (
        messageEstimateCache.size > MAX_MESSAGE_CACHE_ENTRIES ||
        messageEstimateCacheBytes > MAX_MESSAGE_CACHE_KEY_BYTES
    ) {
        const first = messageEstimateCache.keys().next().value;
        if (typeof first !== "string") break;
        const removed = messageEstimateCache.get(first);
        if (removed) messageEstimateCacheBytes -= removed.keyEstimateBytes;
        messageEstimateCache.delete(first);
    }
}

function cloneBreakdown(value: TrueRawTokenBreakdown): TrueRawTokenBreakdown {
    return { ...value };
}

function estimateNonToolPart(
    part: unknown,
    options: TrueRawEstimateOptions,
    breakdown: TrueRawTokenBreakdown,
): boolean {
    if (!isRecord(part)) {
        if (part !== null && part !== undefined)
            addBreakdown(breakdown, "other", estimateStructured(part));
        return true;
    }
    const type = partType(part);
    if (
        type === "step-start" ||
        type === "step-finish" ||
        (type === "meta" && Object.keys(part).length <= 1)
    ) {
        return true;
    }
    if (type === "text") {
        const text = firstStringField(part, ["text", "content"]);
        if (text) addBreakdown(breakdown, "text", estimateTokens(text));
        return true;
    }
    if (type === "reasoning" || type === "thinking" || type === "redacted_thinking") {
        const text = firstStringField(part, ["thinking", "text", "content", "reasoning"]);
        if (text) {
            addBreakdown(breakdown, "reasoning", estimateTokens(text));
        } else {
            addBreakdown(breakdown, "other", estimateStructured(part));
        }
        return true;
    }
    const reasoningText = firstStringField(part, ["thinking", "reasoning"]);
    if (reasoningText && type.length === 0) {
        addBreakdown(breakdown, "reasoning", estimateTokens(reasoningText));
        return true;
    }
    if (looksImageLike(part)) {
        addBreakdown(
            breakdown,
            "image",
            options.imageTokenHeuristic?.(part) ?? defaultImageTokenHeuristic(part),
        );
        const altText = firstStringField(part, ["alt", "text", "description"]);
        if (altText) addBreakdown(breakdown, "text", estimateTokens(altText));
        return true;
    }
    if (type.includes("file") || type === "source") {
        const content = firstStringField(part, ["content", "text", "source"]);
        if (content) addBreakdown(breakdown, "text", estimateTokens(content));
        else addBreakdown(breakdown, "other", estimateStructured(part));
        return true;
    }
    return false;
}

export function estimateTrueRawMessageTokens(
    message: RawMessage,
    options: TrueRawEstimateOptions,
): TrueRawTokenBreakdown {
    const breakdown = cloneBreakdown(EMPTY_BREAKDOWN);
    const countedInput = new Set<string>();
    const countedOutput = new Set<string>();
    let ordinalToolIndex = 0;

    for (const part of message.parts) {
        const signal = toolSignalFromPart(part);
        if (signal) {
            const localKey = `${signal.callId || "tool"}:${message.ordinal}:${ordinalToolIndex}`;
            ordinalToolIndex += 1;
            if (signal.hasInput) {
                const key = `${signal.callId}:input:${message.ordinal}`;
                if (!countedInput.has(key)) {
                    countedInput.add(key);
                    addBreakdown(breakdown, "toolInput", estimateTokens(signal.inputText));
                }
            }
            if (signal.hasOutput) {
                const key = `${signal.callId}:output:${message.ordinal}:${localKey}`;
                if (!countedOutput.has(key)) {
                    countedOutput.add(key);
                    addBreakdown(breakdown, "toolOutput", estimateTokens(signal.outputText));
                }
            }
            continue;
        }
        if (!estimateNonToolPart(part, options, breakdown)) {
            addBreakdown(breakdown, "other", estimateStructured(part));
        }
    }
    return breakdown;
}

export function buildToolArcs(messages: readonly RawMessage[]): ToolArc[] {
    const openQueues = new Map<string, number[]>();
    const arcs: ToolArc[] = [];
    for (const message of messages) {
        for (const part of message.parts) {
            const signal = toolSignalFromPart(part);
            if (!signal || signal.callId.length === 0) continue;
            if (signal.hasInput && signal.hasOutput) {
                arcs.push({
                    callId: signal.callId,
                    invOrdinal: message.ordinal,
                    resOrdinal: message.ordinal,
                });
                continue;
            }
            if (signal.hasInput) {
                const queue = openQueues.get(signal.callId) ?? [];
                queue.push(message.ordinal);
                openQueues.set(signal.callId, queue);
                continue;
            }
            if (signal.hasOutput) {
                const queue = openQueues.get(signal.callId) ?? [];
                const invOrdinal = queue.shift();
                if (queue.length === 0) openQueues.delete(signal.callId);
                else openQueues.set(signal.callId, queue);
                if (invOrdinal !== undefined) {
                    arcs.push({ callId: signal.callId, invOrdinal, resOrdinal: message.ordinal });
                }
            }
        }
    }
    for (const [callId, queue] of openQueues) {
        for (const invOrdinal of queue) {
            arcs.push({ callId, invOrdinal, resOrdinal: null });
        }
    }
    return arcs.sort(
        (a, b) =>
            a.invOrdinal - b.invOrdinal ||
            (a.resOrdinal ?? Number.MAX_SAFE_INTEGER) - (b.resOrdinal ?? Number.MAX_SAFE_INTEGER),
    );
}

export function fenceBoundaryForToolArcs(
    candidate: number,
    arcs: readonly ToolArc[],
    lastCompartmentEndOrdinal: number,
): number {
    let boundary = candidate;
    for (const arc of arcs) {
        if (arc.resOrdinal !== null) {
            if (arc.invOrdinal < boundary && boundary <= arc.resOrdinal) {
                boundary = arc.resOrdinal + 1;
            }
            continue;
        }
        if (arc.invOrdinal >= lastCompartmentEndOrdinal + 1 && arc.invOrdinal < boundary) {
            return arc.invOrdinal;
        }
        if (arc.invOrdinal >= boundary) {
            return Math.min(boundary, arc.invOrdinal);
        }
    }
    return boundary;
}

function tokenForMessage(
    message: RawMessage,
    options: TrueRawTokenIndexBuildOptions,
): TrueRawTokenBreakdown {
    const key = messageCacheKey(message, options);
    const cached = messageEstimateCache.get(key);
    if (cached) return cloneBreakdown(cached.breakdown);
    const breakdown = estimateTrueRawMessageTokens(message, options);
    setCachedEstimate(key, breakdown);
    return cloneBreakdown(breakdown);
}

export function buildTrueRawTokenIndex(
    sessionId: string,
    messages: readonly RawMessage[],
    options: TrueRawTokenIndexBuildOptions,
): TrueRawTokenIndex {
    const ordered = [...messages].sort((a, b) => a.ordinal - b.ordinal);
    const rawMessageCount = ordered.length;
    const tokensByOrdinal = new Map<number, number>();
    const idsByOrdinal = new Map<number, string>();
    const prefix = new Array<number>(rawMessageCount + 1).fill(0);
    for (let i = 0; i < rawMessageCount; i += 1) {
        const message = ordered[i];
        const total = tokenForMessage(message, options).total;
        tokensByOrdinal.set(message.ordinal, total);
        idsByOrdinal.set(message.ordinal, message.id);
        prefix[i + 1] = prefix[i] + total;
    }
    const ordinalToIndex = (ordinal: number): number =>
        Math.max(0, Math.min(rawMessageCount, ordinal - 1));
    return {
        sessionId,
        providerShapeVersion: options.providerShapeVersion,
        rawMessageCount,
        tokenForOrdinal(ordinal: number): number {
            return tokensByOrdinal.get(ordinal) ?? 0;
        },
        messageIdAtOrdinal(ordinal: number): string | null {
            return idsByOrdinal.get(ordinal) ?? null;
        },
        suffixTokensFromOrdinal(ordinal: number): number {
            if (ordinal <= 1) return prefix[rawMessageCount];
            if (ordinal > rawMessageCount) return 0;
            return prefix[rawMessageCount] - prefix[ordinalToIndex(ordinal)];
        },
        rangeTokens(startInclusive: number, endExclusive: number): number {
            const start = Math.max(1, startInclusive);
            const end = Math.max(start, Math.min(rawMessageCount + 1, endExclusive));
            return prefix[end - 1] - prefix[start - 1];
        },
        findSuffixStartForTokens(tokens: number): number {
            if (!Number.isFinite(tokens) || tokens <= 0) return rawMessageCount + 1;
            const target = Math.max(0, Math.floor(tokens));
            const total = prefix[rawMessageCount];
            if (total < target) return 1;
            const cut = total - target;
            let lo = 0;
            let hi = rawMessageCount;
            let best = 0;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (prefix[mid] <= cut) {
                    best = mid;
                    lo = mid + 1;
                } else {
                    hi = mid - 1;
                }
            }
            return best + 1;
        },
        findHeadEndForCap(startInclusive: number, endExclusive: number, capTokens: number): number {
            const start = Math.max(1, Math.min(rawMessageCount + 1, startInclusive));
            const end = Math.max(start, Math.min(rawMessageCount + 1, endExclusive));
            if (!Number.isFinite(capTokens) || capTokens <= 0) return start;
            const startPrefix = prefix[start - 1];
            const cut = startPrefix + Math.floor(capTokens);
            let lo = start;
            let hi = end - 1;
            let bestEnd = start;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (prefix[mid] <= cut) {
                    bestEnd = mid + 1;
                    lo = mid + 1;
                } else {
                    hi = mid - 1;
                }
            }
            if (bestEnd === start && start < end) return start + 1;
            return Math.min(bestEnd, end);
        },
    };
}

export function computeRawRangeFingerprint(
    messages: readonly RawMessage[],
    startInclusive: number,
    endExclusive: number,
): string {
    const pieces: string[] = [];
    for (const message of messages) {
        if (message.ordinal < startInclusive || message.ordinal >= endExclusive) continue;
        const root = isRecord(message) ? message : null;
        const version = root?.updated_at ?? root?.updatedAt ?? root?.version ?? "";
        pieces.push(`${message.ordinal}:${message.id}:${String(version)}:${message.parts.length}`);
    }
    return pieces.join("|");
}

export function invalidateTrueRawTokenCache(args: {
    sessionId?: string;
    messageId?: string;
    reason:
        | "message.updated"
        | "message.removed"
        | "session.compacted"
        | "session.deleted"
        | "pi.branch.changed"
        | "pi.stable-id-scheme.changed"
        | "provider.unregistered"
        | "schema.migration";
}): void {
    const sessionNeedle = args.sessionId ? `${args.sessionId}` : null;
    const messageNeedle = args.messageId ? `\0${args.messageId}\0` : null;
    for (const [key, value] of messageEstimateCache) {
        const sessionMatches = sessionNeedle === null || key.includes(sessionNeedle);
        const messageMatches = messageNeedle === null || key.includes(messageNeedle);
        if (sessionMatches && messageMatches) {
            messageEstimateCache.delete(key);
            messageEstimateCacheBytes -= value.keyEstimateBytes;
        }
    }
    void args.reason;
}

export function buildTrueRawTokenIndexFromTokenCountsForTest(
    sessionId: string,
    tokens: readonly number[],
): TrueRawTokenIndex {
    const rawMessageCount = tokens.length;
    const prefix = new Array<number>(rawMessageCount + 1).fill(0);
    for (let index = 0; index < rawMessageCount; index += 1) {
        prefix[index + 1] = prefix[index] + Math.max(0, Math.floor(tokens[index] ?? 0));
    }
    return {
        sessionId,
        providerShapeVersion: "test",
        rawMessageCount,
        tokenForOrdinal(ordinal: number): number {
            return tokens[ordinal - 1] ?? 0;
        },
        messageIdAtOrdinal(ordinal: number): string | null {
            return ordinal >= 1 && ordinal <= rawMessageCount ? `m-${ordinal}` : null;
        },
        suffixTokensFromOrdinal(ordinal: number): number {
            if (ordinal <= 1) return prefix[rawMessageCount];
            if (ordinal > rawMessageCount) return 0;
            return prefix[rawMessageCount] - prefix[ordinal - 1];
        },
        rangeTokens(startInclusive: number, endExclusive: number): number {
            const start = Math.max(1, startInclusive);
            const end = Math.max(start, Math.min(rawMessageCount + 1, endExclusive));
            return prefix[end - 1] - prefix[start - 1];
        },
        findSuffixStartForTokens(tokensNeeded: number): number {
            if (!Number.isFinite(tokensNeeded) || tokensNeeded <= 0) return rawMessageCount + 1;
            const target = Math.max(0, Math.floor(tokensNeeded));
            const total = prefix[rawMessageCount];
            if (total < target) return 1;
            const cut = total - target;
            let lo = 0;
            let hi = rawMessageCount;
            let best = 0;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (prefix[mid] <= cut) {
                    best = mid;
                    lo = mid + 1;
                } else {
                    hi = mid - 1;
                }
            }
            return best + 1;
        },
        findHeadEndForCap(startInclusive: number, endExclusive: number, capTokens: number): number {
            const start = Math.max(1, Math.min(rawMessageCount + 1, startInclusive));
            const end = Math.max(start, Math.min(rawMessageCount + 1, endExclusive));
            if (!Number.isFinite(capTokens) || capTokens <= 0) return start;
            const cut = prefix[start - 1] + Math.floor(capTokens);
            let result = start;
            for (let ordinal = start; ordinal < end; ordinal += 1) {
                if (prefix[ordinal] <= cut) result = ordinal + 1;
                else break;
            }
            return result === start && start < end ? start + 1 : result;
        },
    };
}
