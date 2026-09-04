import { formatDateTime } from "../../../lib/format";
import { SectionLabel } from "../../../components/Typography";
import type { PersistedScanDetail } from "../../../models/scan";
import { buildReleaseTimeline, formatDelta } from "./release-timeline";
import type { PersistedSummary } from "./types";

/**
 * Dated pipeline events for this review, oldest first, with the gap to the
 * previous row so the latency between staging, review, npm's own validation,
 * and the decision is visible at a glance. Renders nothing when no event has
 * a timestamp.
 */
export function ReleaseTimeline({
  scan,
  summary,
}: {
  scan: PersistedScanDetail["scan"];
  summary: PersistedSummary;
}) {
  const events = buildReleaseTimeline(scan, summary);
  if (!events.length) return null;
  return (
    <section class="flex flex-col gap-3">
      <SectionLabel as="h2" aside={`${events.length} events`}>
        Release timeline
      </SectionLabel>
      <ol class="m-0 list-none p-0 border-l border-border ml-1 pl-4 flex flex-col divide-y divide-border">
        {events.map((event, index) => {
          const previous = index > 0 ? events[index - 1] : null;
          return (
            <li
              key={event.key}
              class="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 py-2"
            >
              <div class="flex flex-col gap-0.5 min-w-0">
                <span class="text-[13px] text-ink">
                  {event.label}
                  {event.detail ? <span class="text-ink-muted"> — {event.detail}</span> : null}
                </span>
                <span class="font-mono text-[11px] text-ink-subtle">
                  {formatDateTime(event.at)}
                </span>
              </div>
              <span class="font-mono text-[11px] text-ink-subtle tabular-nums">
                {previous ? formatDelta(event.at - previous.at) : "start"}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
