import { cn } from "./cn";

export type SeverityKey = "critical" | "high" | "medium" | "low" | "info" | "ok";

export type SeverityCounts = Partial<Record<SeverityKey, number>>;

interface Segment {
  key: SeverityKey;
  count: number;
  x: number;
  width: number;
  swatchClass: string;
  label: string;
}

const ORDER: SeverityKey[] = ["critical", "high", "medium", "low", "info", "ok"];

const swatchClass: Record<SeverityKey, string> = {
  critical: "bg-danger",
  high: "bg-danger opacity-[0.78]",
  medium: "bg-warn",
  low: "bg-info",
  info: "bg-info opacity-50",
  ok: "bg-ok",
};

export function SeverityBar({
  counts,
  label = "findings by severity",
  emptyLabel = "no findings",
  class: className,
}: {
  counts: SeverityCounts;
  label?: string;
  emptyLabel?: string;
  class?: string;
}) {
  const total = ORDER.reduce((sum, key) => sum + (counts[key] ?? 0), 0);

  if (total === 0) {
    return (
      <div class={cn("flex flex-col gap-3", className)}>
        <div class="flex flex-wrap items-center gap-3">
          {/* 11px: this names the chart the user reads — the 10px allowance
              covers only the legend below. */}
          <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
            {label}
          </span>
          <span class="font-mono text-[11px] text-ink-subtle">{emptyLabel}</span>
        </div>
        <div class="h-2 rounded bg-surface-2" aria-hidden />
      </div>
    );
  }

  let x = 0;
  const lastKey = segmentsLastKey(counts);
  const segments: Segment[] = ORDER.filter((key) => (counts[key] ?? 0) > 0).map((key) => {
    const count = counts[key] ?? 0;
    const width = (count / total) * 100;
    const segment = {
      key,
      count,
      x,
      width,
      swatchClass: swatchClass[key],
      label: key,
    };
    x += width;
    return {
      ...segment,
      width: key === lastKey ? 100 - segment.x : segment.width,
    };
  });

  return (
    <div class={cn("flex flex-col gap-3", className)}>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
          {label}
        </span>
        <span class="font-mono text-[11px] text-ink-subtle">{total} total</span>
      </div>
      {/* A plain flex stack, not an SVG — docs/design.md's chart spec is a single
          horizontal element with percentage-width segments, and SVG is
          reserved for nothing in this system. The last segment's width is
          pre-corrected against float drift so the widths sum to exactly 100. */}
      <div
        class="h-2 w-full rounded overflow-hidden bg-surface-2 flex"
        role="img"
        aria-label={`${total} findings: ${segments.map((s) => `${s.count} ${s.label}`).join(", ")}`}
      >
        {segments.map((segment) => (
          <span
            key={segment.key}
            style={{ width: `${segment.width}%` }}
            class={cn("h-full shrink-0", segment.swatchClass)}
            aria-hidden
          />
        ))}
      </div>
      <ul class="list-none p-0 m-0 flex flex-wrap gap-x-4 gap-y-1.5">
        {segments.map((segment) => (
          <li
            key={segment.key}
            class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle flex items-center gap-1.5"
          >
            <span class={cn("inline-block w-2 h-2 rounded-sm", segment.swatchClass)} aria-hidden />
            <span>
              {segment.label} · {segment.count}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function segmentsLastKey(counts: SeverityCounts): SeverityKey | null {
  for (let index = ORDER.length - 1; index >= 0; index -= 1) {
    const key = ORDER[index];
    if ((counts[key] ?? 0) > 0) return key;
  }
  return null;
}
