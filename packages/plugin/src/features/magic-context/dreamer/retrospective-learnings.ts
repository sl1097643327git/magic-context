import type { Database } from "../../../shared/sqlite";
import { computeNormalizedHash } from "../memory/normalize-hash";
import { getMemoryByHash, insertMemory } from "../memory/storage-memory";
import type { MemoryCategory } from "../memory/types";
import { insertUserMemoryCandidates } from "../user-memory/storage-user-memory";

/**
 * A durable learning must not preserve session-local anger/friction language
 * verbatim ("distill, don't transcribe"). This catches the strongest correction
 * phrases + repeated no/wrong/again/stop runs + punctuation bursts.
 */
const FRUSTRATION_MARKER_REGEX =
    /\b(?:not what i asked|i already (?:said|told you|explained)|you (?:ignored|missed)|that'?s wrong|this is wrong|stop (?:doing|claiming|using)|(?:no|wrong|again|stop)(?:\W+\b(?:no|wrong|again|stop)\b)+)\b|[!?]{3,}/i;

export type RetrospectiveLearningRoute = "memory" | "observation";

export interface ParsedRetrospectiveLearning {
    route: RetrospectiveLearningRoute;
    content: string;
    category?: MemoryCategory;
}

export interface RetrospectiveApplyResult {
    memoryWritten: number;
    observationsInserted: number;
    observationsDropped: number;
    rejected: Array<{ content: string; reason: string }>;
}

const LEARNINGS_BLOCK_REGEX = /<learnings\b[^>]*>(.*?)<\/learnings>/is;
const LEARNING_REGEX = /<learning\b([^>]*)>(.*?)<\/learning>/gis;
const ATTR_REGEX = /([a-zA-Z_:-]+)\s*=\s*"([^"]*)"/g;
const VALID_MEMORY_CATEGORIES = new Set<MemoryCategory>([
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
]);
const RAW_QUOTE_REGEX = /["“”][^"“”]{4,}["“”]|'[^']{4,}'/;
const DATE_REGEX =
    /\b(?:20\d{2}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}\/\d{1,2}\/20\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+20\d{2})\b/i;

export function parseRetrospectiveLearnings(text: string): ParsedRetrospectiveLearning[] {
    const block = text.match(LEARNINGS_BLOCK_REGEX)?.[1];
    if (!block) return [];

    const learnings: ParsedRetrospectiveLearning[] = [];
    for (const match of block.matchAll(LEARNING_REGEX)) {
        const attrs = parseAttributes(match[1] ?? "");
        const route = attrs.route;
        if (route !== "memory" && route !== "observation") continue;
        const content = unescapeXml((match[2] ?? "").trim())
            .replace(/\s+/g, " ")
            .trim();
        if (!content) continue;

        if (route === "memory") {
            const category = attrs.category;
            if (!VALID_MEMORY_CATEGORIES.has(category as MemoryCategory)) continue;
            learnings.push({ route, category: category as MemoryCategory, content });
        } else {
            learnings.push({ route, content });
        }
    }
    return learnings;
}

// A learning that shares a long verbatim run of words with a source user message
// is a transcription, not a distillation — reject it. (Privacy: the durable
// memory must be the third-person LESSON, never the user's own words.)
export const MAX_SOURCE_WORD_RUN = 7;
export const MAX_SOURCE_WORD_RUN_RATIO = 0.5;
// Bound the DP inputs. `longestCommonWordRun` is O(n*m); a learning is short by
// nature, and we only need the FIRST window of a long source to detect a run, so
// cap both sides. (A learning > this many words is itself suspicious; we compare
// against the source's leading window — a transcription echoes a contiguous run,
// which a leading window still catches for the common case.)
export const MAX_OVERLAP_LEARNING_WORDS = 200;
export const MAX_OVERLAP_SOURCE_WORDS = 400;

function toWords(text: string, cap: number): string[] {
    const words = text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((word) => word.length > 0);
    return words.length > cap ? words.slice(0, cap) : words;
}

/** Longest run of CONSECUTIVE shared words between two word sequences. */
function longestCommonWordRun(a: string[], b: string[]): number {
    if (a.length === 0 || b.length === 0) return 0;
    let best = 0;
    let prev = new Array<number>(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
        const curr = new Array<number>(b.length + 1).fill(0);
        for (let j = 1; j <= b.length; j++) {
            if (a[i - 1] === b[j - 1]) {
                curr[j] = prev[j - 1] + 1;
                if (curr[j] > best) best = curr[j];
            }
        }
        prev = curr;
    }
    return best;
}

/**
 * True when `content` reads as a near-transcription of any source user line:
 * it shares a long contiguous word run (absolute threshold, or a large fraction
 * of the learning's own length). This is the structural enforcement of "distill,
 * don't transcribe" — the regexes catch quotes/dates/anger, this catches a
 * lightly-reworded user sentence that would otherwise pass.
 */
export function hasHighSourceOverlap(content: string, sourceUserTexts: string[]): boolean {
    const learningWords = toWords(content, MAX_OVERLAP_LEARNING_WORDS);
    if (learningWords.length === 0) return false;
    const runCap = Math.min(
        MAX_SOURCE_WORD_RUN,
        Math.max(3, Math.ceil(learningWords.length * MAX_SOURCE_WORD_RUN_RATIO)),
    );
    for (const source of sourceUserTexts) {
        const run = longestCommonWordRun(learningWords, toWords(source, MAX_OVERLAP_SOURCE_WORDS));
        if (run >= runCap) return true;
    }
    return false;
}

export function validateRetrospectiveLearningText(
    content: string,
    sourceUserTexts: readonly string[] = [],
): string | null {
    if (RAW_QUOTE_REGEX.test(content)) return "raw_quote";
    if (DATE_REGEX.test(content)) return "date";
    if (FRUSTRATION_MARKER_REGEX.test(content)) return "frustration_marker";
    if (hasHighSourceOverlap(content, [...sourceUserTexts])) return "source_overlap";
    return null;
}

export function applyRetrospectiveLearnings(args: {
    db: Database;
    projectIdentity: string;
    sourceSessionId: string;
    learnings: ParsedRetrospectiveLearning[];
    userMemoryCollectionEnabled: boolean;
    /** The raw source user lines, for the near-transcription reject check. */
    sourceUserTexts?: readonly string[];
}): RetrospectiveApplyResult {
    const result: RetrospectiveApplyResult = {
        memoryWritten: 0,
        observationsInserted: 0,
        observationsDropped: 0,
        rejected: [],
    };
    const observations: Array<{ content: string; sessionId: string }> = [];
    const sourceUserTexts = args.sourceUserTexts ?? [];
    // Idempotence: dedupe identical-content learnings within this batch, and
    // skip a memory that already exists (the model can re-emit a learning across
    // runs). A duplicate is a no-op, never a fatal UNIQUE throw that would abort
    // the whole apply and retry the same window.
    const seenContent = new Set<string>();

    for (const learning of args.learnings) {
        const dedupeKey = `${learning.route}:${learning.category ?? ""}:${learning.content}`;
        if (seenContent.has(dedupeKey)) continue;
        seenContent.add(dedupeKey);

        const rejectReason = validateRetrospectiveLearningText(learning.content, sourceUserTexts);
        if (rejectReason) {
            result.rejected.push({ content: learning.content, reason: rejectReason });
            continue;
        }

        if (learning.route === "memory") {
            if (!learning.category) continue;
            // Skip an already-stored identical memory rather than throwing on the
            // UNIQUE(project_path, category, normalized_hash) constraint.
            const existing = getMemoryByHash(
                args.db,
                args.projectIdentity,
                learning.category,
                computeNormalizedHash(learning.content),
            );
            if (existing) continue;
            insertMemory(args.db, {
                projectPath: args.projectIdentity,
                category: learning.category,
                content: learning.content,
                sourceSessionId: args.sourceSessionId,
                sourceType: "dreamer",
                metadataJson: JSON.stringify({ source: "retrospective" }),
            });
            result.memoryWritten += 1;
            continue;
        }

        if (args.userMemoryCollectionEnabled) {
            observations.push({ content: learning.content, sessionId: args.sourceSessionId });
        } else {
            result.observationsDropped += 1;
        }
    }

    if (observations.length > 0) {
        insertUserMemoryCandidates(args.db, observations);
        result.observationsInserted = observations.length;
    }

    return result;
}

function parseAttributes(raw: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const match of raw.matchAll(ATTR_REGEX)) {
        attrs[match[1]] = unescapeXml(match[2] ?? "");
    }
    return attrs;
}

function unescapeXml(value: string): string {
    return value
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}
