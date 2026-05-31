#!/usr/bin/env bun
/**
 * analyze-cache-busts.ts — walk a session's anthropic-auth request dumps in
 * order and locate exactly WHERE the Anthropic prompt cache busts.
 *
 * The opencode-anthropic-auth plugin dumps every outbound request body to a
 * temp dir (`<tmpdir>/opencode-anthropic-auth-dumps/*.body.json`) alongside a
 * `.meta.json`. This tool reconstructs the wire-order segment list for each
 * request (system blocks, then every message), hashes each segment, and finds
 * the FIRST segment whose content changed vs the previous same-session request.
 * Anthropic serves a cache hit only up to the longest matching prefix that ends
 * at a `cache_control` breakpoint, so the first-diverging segment is the bust
 * origin and the last breakpoint at-or-before it is the effective cached prefix.
 *
 * Normalization (so we measure REAL content drift, not provider noise):
 *   - The `cch=<nonce>` in the `x-anthropic-billing-header` system block is a
 *     per-request nonce Anthropic ignores for cache-keying → normalized out.
 *   - `cache_control` markers move every turn (they sit on the last/second-last
 *     message) → stripped before hashing, since marker movement is not content.
 *   - `§N§` tag prefixes ARE on-wire content the model sees → kept (a changed
 *     tag number is a genuine bust we want to catch).
 *
 * Usage:
 *   bun scripts/analyze-cache-busts.ts <sessionIdPrefix> [options]
 * Options:
 *   --dir <path>     dump dir (default: <tmpdir>/opencode-anthropic-auth-dumps)
 *   --since <ISO>    only requests created at/after this time
 *   --until <ISO>    only requests created at/before this time
 *   --limit <N>      only the last N requests in range
 *   --show-diff      print before/after snippet of the first-diverging segment
 *   --all-busts      list every diverging segment, not just the first
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Json = Record<string, unknown>;

interface Segment {
    id: string;
    hash: string;
    bytes: number;
    breakpoint: boolean;
}

interface Snapshot {
    file: string;
    createdAt: string;
    session: string;
    messagesCount: number;
    segments: Segment[];
}

function sha(s: string): string {
    return createHash("sha256").update(s).digest("hex").slice(0, 10);
}

function parseArgs(argv: string[]): {
    sessionPrefix: string;
    dir: string;
    since?: string;
    until?: string;
    limit?: number;
    showDiff: boolean;
    allBusts: boolean;
} {
    const args = argv.slice(2);
    const sessionPrefix = args.find((a) => !a.startsWith("--")) ?? "";
    const getOpt = (name: string): string | undefined => {
        const i = args.indexOf(name);
        return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
    };
    const dir =
        getOpt("--dir") ?? join(tmpdir(), "opencode-anthropic-auth-dumps");
    const limitRaw = getOpt("--limit");
    return {
        sessionPrefix,
        dir,
        since: getOpt("--since"),
        until: getOpt("--until"),
        limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
        showDiff: args.includes("--show-diff"),
        allBusts: args.includes("--all-busts"),
    };
}

/** Recursively strip `cache_control` fields — marker movement is not content. */
function stripCacheControl(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripCacheControl);
    if (value && typeof value === "object") {
        const out: Json = {};
        for (const [k, v] of Object.entries(value as Json)) {
            if (k === "cache_control") continue;
            out[k] = stripCacheControl(v);
        }
        return out;
    }
    return value;
}

function hasCacheControl(block: unknown): boolean {
    return !!block && typeof block === "object" && "cache_control" in (block as Json);
}

function messageHasBreakpoint(msg: Json): boolean {
    const content = msg.content;
    if (Array.isArray(content)) {
        return content.some((p) => hasCacheControl(p));
    }
    return hasCacheControl(msg);
}

/** Normalize the per-request billing nonce so it isn't seen as a content change. */
function normalizeSystemText(text: string): string {
    return text.replace(/cch=[^;]*;/g, "cch=<NONCE>;");
}

function blockText(block: unknown): string {
    if (block && typeof block === "object" && typeof (block as Json).text === "string") {
        return (block as Json).text as string;
    }
    return JSON.stringify(stripCacheControl(block));
}

function buildSegments(body: Json): Segment[] {
    const segs: Segment[] = [];
    const system = body.system;
    const sysBlocks = Array.isArray(system) ? system : system != null ? [system] : [];
    sysBlocks.forEach((b, i) => {
        const raw = blockText(b);
        segs.push({
            id: `system[${i}]`,
            hash: sha(normalizeSystemText(raw)),
            bytes: Buffer.byteLength(raw),
            breakpoint: hasCacheControl(b),
        });
    });
    const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : [];
    messages.forEach((m, i) => {
        const norm = JSON.stringify({ role: m.role, content: stripCacheControl(m.content) });
        segs.push({
            id: `message[${i}](${String(m.role)})`,
            hash: sha(norm),
            bytes: Buffer.byteLength(JSON.stringify(m)),
            breakpoint: messageHasBreakpoint(m),
        });
    });
    return segs;
}

function loadSnapshots(opts: ReturnType<typeof parseArgs>): Snapshot[] {
    const metas = readdirSync(opts.dir).filter((f) => f.endsWith(".meta.json"));
    const snaps: Snapshot[] = [];
    for (const metaFile of metas) {
        let meta: Json;
        try {
            meta = JSON.parse(readFileSync(join(opts.dir, metaFile), "utf8")) as Json;
        } catch {
            continue;
        }
        const session = String(meta.session ?? "");
        // The dump truncates session ids with an ellipsis ("ses_31366057…"); match
        // on the visible head so a full id or a head fragment both work.
        const head = session.replace(/[….]+$/, "");
        if (!session.startsWith(opts.sessionPrefix) && !opts.sessionPrefix.startsWith(head)) {
            continue;
        }
        const createdAt = String(meta.createdAt ?? "");
        if (opts.since && createdAt < opts.since) continue;
        if (opts.until && createdAt > opts.until) continue;
        const files = meta.files as Json | undefined;
        const bodyPath = files && typeof files.body === "string" ? files.body : undefined;
        if (!bodyPath) continue;
        let body: Json;
        try {
            body = JSON.parse(readFileSync(bodyPath, "utf8")) as Json;
        } catch {
            continue;
        }
        const bodyMeta = meta.body as Json | undefined;
        snaps.push({
            file: metaFile,
            createdAt,
            session,
            messagesCount:
                typeof bodyMeta?.messagesCount === "number" ? bodyMeta.messagesCount : -1,
            segments: buildSegments(body),
        });
    }
    snaps.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (opts.limit && snaps.length > opts.limit) {
        return snaps.slice(snaps.length - opts.limit);
    }
    return snaps;
}

/** First wire-order segment index where prev/cur diverge (added/removed/changed). */
function firstDivergence(prev: Segment[], cur: Segment[]): number {
    const n = Math.min(prev.length, cur.length);
    for (let i = 0; i < n; i += 1) {
        if (prev[i].hash !== cur[i].hash || prev[i].id !== cur[i].id) return i;
    }
    return prev.length === cur.length ? -1 : n;
}

/** Effective cached prefix = bytes up to the last breakpoint strictly before divergence. */
function cachedPrefixBytes(segs: Segment[], divergeIdx: number): { bytes: number; at: string } {
    let bytes = 0;
    let lastBreakpointBytes = 0;
    let lastBreakpointId = "(none)";
    const limit = divergeIdx < 0 ? segs.length : divergeIdx;
    for (let i = 0; i < segs.length; i += 1) {
        if (i < limit && segs[i].breakpoint) {
            // breakpoint content is unchanged up to here
            lastBreakpointBytes = bytes + segs[i].bytes;
            lastBreakpointId = segs[i].id;
        }
        bytes += segs[i].bytes;
    }
    return { bytes: lastBreakpointBytes, at: lastBreakpointId };
}

function fmtTime(iso: string): string {
    // dumps are UTC; show HH:MM:SS UTC for direct correlation with meta.
    const m = iso.match(/T(\d{2}:\d{2}:\d{2})/);
    return m ? m[1] : iso;
}

function main(): void {
    const opts = parseArgs(process.argv);
    if (!opts.sessionPrefix) {
        console.error(
            "usage: bun scripts/analyze-cache-busts.ts <sessionIdPrefix> [--dir <path>] [--since ISO] [--until ISO] [--limit N] [--show-diff] [--all-busts]",
        );
        process.exit(1);
    }
    const snaps = loadSnapshots(opts);
    if (snaps.length === 0) {
        console.error(`No dumps found for session prefix "${opts.sessionPrefix}" in ${opts.dir}`);
        process.exit(1);
    }
    console.log(`Session: ${snaps[0].session}`);
    console.log(`Dumps:   ${snaps.length}  (dir: ${opts.dir})`);
    console.log("");
    console.log(
        "time(UTC) | segs | verdict | first-divergence        | cachedPrefix@breakpoint",
    );
    console.log(
        "----------|------|---------|-------------------------|------------------------",
    );

    for (let k = 0; k < snaps.length; k += 1) {
        const cur = snaps[k];
        if (k === 0) {
            console.log(
                `${fmtTime(cur.createdAt)} | ${String(cur.segments.length).padStart(4)} | BASE    | (first request)         |`,
            );
            continue;
        }
        const prev = snaps[k - 1];
        const idx = firstDivergence(prev.segments, cur.segments);
        if (idx === -1) {
            console.log(
                `${fmtTime(cur.createdAt)} | ${String(cur.segments.length).padStart(4)} | SAME    | (identical to prev)     |`,
            );
            continue;
        }
        const seg = cur.segments[idx] ?? prev.segments[idx];
        const lastBreakpointIdx = (() => {
            let last = -1;
            for (let i = 0; i < cur.segments.length; i += 1) if (cur.segments[i].breakpoint) last = i;
            return last;
        })();
        // STABLE: divergence is only in the growing tail at/after the final
        // breakpoint (expected — new turn appended). BUST: divergence lands
        // before the final breakpoint, invalidating cached prefix it should keep.
        const verdict = idx >= lastBreakpointIdx ? "STABLE" : "BUST";
        const cp = cachedPrefixBytes(cur.segments, idx);
        const segId = seg?.id ?? `seg[${idx}]`;
        console.log(
            `${fmtTime(cur.createdAt)} | ${String(cur.segments.length).padStart(4)} | ${verdict.padEnd(7)} | ${segId.padEnd(23)} | ${cp.at} (${cp.bytes.toLocaleString()}B)`,
        );

        if ((opts.showDiff || opts.allBusts) && verdict === "BUST") {
            const allDiffs: number[] = [];
            const n = Math.max(prev.segments.length, cur.segments.length);
            for (let i = idx; i < n; i += 1) {
                if (prev.segments[i]?.hash !== cur.segments[i]?.hash || prev.segments[i]?.id !== cur.segments[i]?.id) {
                    allDiffs.push(i);
                    if (!opts.allBusts && allDiffs.length >= 1) break;
                }
            }
            for (const di of allDiffs) {
                console.log(
                    `          └─ diverge @${di}: prev=${prev.segments[di]?.id ?? "—"}/${prev.segments[di]?.hash ?? "—"}  cur=${cur.segments[di]?.id ?? "—"}/${cur.segments[di]?.hash ?? "—"}`,
                );
            }
        }
    }
}

main();
