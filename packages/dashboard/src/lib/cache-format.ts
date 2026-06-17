import type { DbCacheEvent } from "./types";

// Map a cache-event severity to a bar/pill color class. Severity is the source
// of truth (computed cross-step in the backend); colors follow it directly.
export function severityColorClass(severity: string): string {
  switch (severity) {
    case "stable":
      return "green";
    case "warning":
      return "amber";
    case "bust":
    case "full_bust":
      return "red";
    case "info":
      return "blue";
    default:
      return "gray"; // unknown / warming
  }
}

// Context-scaled timeline-bar geometry:
//   outer height = prompt / context_window  (how full the window is)
//   inner segment = cache_read / prompt       (the cached, cheap portion)
//   overflow      = prompt exceeded the window (pinned at 100%)
export function ctxBarGeom(event: DbCacheEvent) {
  const prompt = event.cache_read + event.cache_write + event.input_tokens;
  const limit = event.context_limit > 0 ? event.context_limit : prompt;
  const outer = limit > 0 ? prompt / limit : 0;
  const inner = prompt > 0 ? event.cache_read / prompt : 0;
  return {
    prompt,
    limit,
    overflow: limit > 0 && prompt > limit,
    outerPct: Math.min(100, Math.max(2, outer * 100)),
    innerPct: Math.min(100, Math.max(0, inner * 100)),
  };
}

// Compact token label for axis ticks: 1_000_000 → "1M", 272_000 → "272k".
export function formatTokensShort(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 || Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}
