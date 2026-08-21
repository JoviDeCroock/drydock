/**
 * The overview rail beside a scrolling diff.
 *
 * A minimap of where the changes and findings sit in the whole file, plus a
 * thumb tracking the viewport. Driven off the scroll-state signal so dragging
 * through a long diff never rerenders the diff table itself.
 */
import { useComputed, type Signal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { type DiffOverviewMarker } from "./diff-overview";
import { type DiffScrollState } from "./diff-scroll";
import { cn } from "./cn";

export function DiffOverview({
  markers,
  scrollState,
}: {
  markers: DiffOverviewMarker[];
  scrollState: Signal<DiffScrollState | null>;
}) {
  // A pane short enough to show everything has nothing to navigate to, and the
  // rail next to it reads as decoration rather than signal. Gated through Show
  // so scroll frames flip one boundary instead of rerendering every marker.
  const overflowing = useComputed(() => {
    const state = scrollState.value;
    return state !== null && state.content > state.viewport + 1;
  });
  if (!markers.length) return null;
  return (
    <Show when={overflowing}>
      {() => (
        <div
          aria-hidden="true"
          class="pointer-events-none absolute right-1 top-2 bottom-2 w-[6px] rounded-full border border-border bg-surface/80 shadow-sm"
        >
          {markers.map((marker) => (
            <span
              key={marker.key}
              class={cn(
                "absolute left-[-1px] right-[-1px] rounded-full",
                markerClass(marker),
                marker.kind === "finding" ? "z-10 ring-1 ring-surface" : "opacity-75",
              )}
              style={{
                top: `${marker.topPercent}%`,
                height: `${marker.heightPercent}%`,
              }}
            />
          ))}
          <DiffOverviewThumb scrollState={scrollState} />
        </div>
      )}
    </Show>
  );
}

// The viewport's position over the strip, in the same neutral ink used for
// structure (never a severity hue — color = signal). Reads the scroll signal
// in its own component so scrolling rerenders only this span, never the diff
// table.
function DiffOverviewThumb({ scrollState }: { scrollState: Signal<DiffScrollState | null> }) {
  const state = scrollState.value;
  if (!state || state.content <= state.viewport) return null;
  return (
    <span
      class="absolute left-[-1px] right-[-1px] z-20 rounded-full bg-ink/15"
      style={{
        top: `${(state.top / state.content) * 100}%`,
        height: `${(state.viewport / state.content) * 100}%`,
      }}
    />
  );
}

function markerClass(marker: DiffOverviewMarker): string {
  if (marker.tone === "added" || marker.tone === "ok") return "bg-ok";
  if (marker.tone === "removed" || marker.tone === "danger") return "bg-danger";
  if (marker.tone === "warn") return "bg-warn";
  return "bg-info";
}

// Severity-tinted fills and left bars for a pinned finding. The fill uses the
// soft severity token at reduced opacity so it reads as a callout over the
// green/red row backgrounds; the bar uses the saturated token (shapes, per
// docs/design.md "color = signal"). Both are static class strings so Tailwind keeps
