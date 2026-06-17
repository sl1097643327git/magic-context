import { createMemo, For, Show } from "solid-js";
import { formatDateTime } from "../../lib/api";
import { ctxBarGeom, formatTokensShort, severityColorClass } from "../../lib/cache-format";
import type { DbCacheEvent } from "../../lib/types";

/**
 * The per-step cache timeline. Each bar's HEIGHT scales to the model's context
 * window (prompt / context_limit) — so the chart reads as the window filling up
 * and dropping at execute passes. The inner segment is the cached (cheap)
 * portion, colored by the step's severity. A left-side axis shows the scale,
 * and steps where Magic Context reclaimed context get a full-height marker line
 * whose tooltip explains why (from the plugin logs).
 *
 * Shared by the global Cache Diagnostics page and the per-session viewer; the
 * caller owns scroll-to-list behavior via onBarClick.
 */
export default function CacheTimeline(props: {
  events: DbCacheEvent[];
  selectedStepId: string | null;
  onBarClick: (event: DbCacheEvent) => void;
}) {
  // Axis scale. If every visible bar shares one context limit, label the axis in
  // absolute tokens (0 → limit). With mixed limits (global view spanning models)
  // bars are each normalized to their own window, so label as % of window.
  const axis = createMemo(() => {
    const limits = new Set<number>();
    for (const e of props.events) {
      if (e.context_limit > 0) limits.add(e.context_limit);
    }
    if (limits.size === 1) {
      const limit = [...limits][0];
      return {
        uniform: true,
        top: formatTokensShort(limit),
        mid: formatTokensShort(limit / 2),
      };
    }
    return { uniform: false, top: "100%", mid: "50%" };
  });

  return (
    <div class="ctx-chart">
      <div
        class="ctx-axis"
        title={
          axis().uniform
            ? "Bar height = prompt / context window"
            : "Bar height = % of each session's context window"
        }
      >
        <span>{axis().top}</span>
        <span>{axis().mid}</span>
        <span>0</span>
      </div>
      <div class="ctx-bars-wrap">
        {/* faint gridlines at 25/50/75% to read the scale against */}
        <div class="ctx-gridline" style={{ bottom: "25%" }} />
        <div class="ctx-gridline" style={{ bottom: "50%" }} />
        <div class="ctx-gridline" style={{ bottom: "75%" }} />
        <div class="ctx-bars">
          <For each={props.events}>
            {(event) => {
              const g = ctxBarGeom(event);
              const isUnknown = event.severity === "unknown";
              const outerClass = isUnknown
                ? "unknown"
                : event.severity === "full_bust"
                  ? "full_bust"
                  : "";
              const pctOfWindow = g.limit > 0 ? (g.prompt / g.limit) * 100 : 0;
              const cachedOfPrompt = g.prompt > 0 ? (event.cache_read / g.prompt) * 100 : 0;
              const cachedLine = isUnknown
                ? "Cache: not reported by provider"
                : `Cached: ${event.cache_read.toLocaleString()} (${cachedOfPrompt.toFixed(0)}% of prompt)`;
              const dropLine = event.is_drop
                ? `\n⬇ MC reclaimed context${event.cause ? ` — ${event.cause}` : ""}`
                : "";
              const isSelected = () => props.selectedStepId === event.message_id;
              const barProps = {
                role: "button" as const,
                tabindex: 0,
                onClick: () => props.onBarClick(event),
                onKeyDown: (e: KeyboardEvent) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    props.onBarClick(event);
                  }
                },
              };
              const title = `${formatDateTime(event.timestamp)}\n${event.severity.toUpperCase()}${g.overflow ? " · OVERFLOW" : ""}\nPrompt: ${g.prompt.toLocaleString()} / ${g.limit.toLocaleString()} (${pctOfWindow.toFixed(1)}% of window)\n${cachedLine}\nUncached: ${(event.input_tokens + event.cache_write).toLocaleString()}${dropLine}\n(click → jump to step in list)`;
              return (
                <div class="ctx-bar-slot">
                  <Show when={event.is_drop}>
                    <div
                      class="ctx-drop-line"
                      title={`⬇ Magic Context reclaimed context here${event.cause ? `\nCause: ${event.cause}` : "\n(cause not found in logs)"}`}
                    />
                  </Show>
                  <div
                    {...barProps}
                    class={`ctx-bar ${outerClass} ${g.overflow ? "overflow" : ""} ${isSelected() ? "selected" : ""}`}
                    style={{ height: `${g.outerPct}%` }}
                    title={title}
                  >
                    <Show when={!isUnknown && g.innerPct > 0}>
                      <div
                        class={`ctx-bar-cached ${severityColorClass(event.severity)}`}
                        style={{ height: `${g.innerPct}%` }}
                      />
                    </Show>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}
