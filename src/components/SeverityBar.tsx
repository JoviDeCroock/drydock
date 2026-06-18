import { cn } from "./cn";

export type SeverityKey = "critical" | "high" | "medium" | "low" | "info" | "ok";

export type SeverityCounts = Partial<Record<SeverityKey, number>>;

interface Segment {
  key: SeverityKey;
  count: number;
  x: number;
  width: number;
  className: string;
  swatchClass: string;
  label: string;
}

const ORDER: SeverityKey[] = ["critical", "high", "medium", "low", "info", "ok"];

const segmentClass: Record<SeverityKey, string> = {
  critical: "text-danger",
  high: "text-danger opacity-[0.78]",
  medium: "text-warn",
  low: "text-info",
  info: "text-info opacity-50",
  ok: "text-ok",
};

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
          <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
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
      className: segmentClass[key],
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
        <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
          {label}
        </span>
        <span class="font-mono text-[11px] text-ink-subtle">{total} total</span>
      </div>
      <svg
        class="h-2 w-full rounded overflow-hidden bg-surface-2 block"
        viewBox="0 0 100 4"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${total} findings: ${segments.map((s) => `${s.count} ${s.label}`).join(", ")}`}
      >
        {segments.map((segment) => (
          <rect
            key={segment.key}
            x={segment.x}
            y="0"
            width={segment.width}
            height="4"
            class={cn("severity-bar-segment", segment.className)}
            aria-hidden
          />
        ))}
      </svg>
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
