import { cn } from "./cn";

export type SeverityKey = "critical" | "high" | "medium" | "low" | "info" | "ok";

export type SeverityCounts = Partial<Record<SeverityKey, number>>;

interface Segment {
  key: SeverityKey;
  count: number;
  width: string;
  className: string;
  swatchClass: string;
  label: string;
}

const ORDER: SeverityKey[] = ["critical", "high", "medium", "low", "info", "ok"];

const segmentClass: Record<SeverityKey, string> = {
  critical: "bg-danger",
  high: "bg-danger opacity-[0.78]",
  medium: "bg-warn",
  low: "bg-info",
  info: "bg-info opacity-50",
  ok: "bg-ok",
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

  const segments: Segment[] = ORDER.filter((key) => (counts[key] ?? 0) > 0).map((key) => {
    const count = counts[key] ?? 0;
    return {
      key,
      count,
      width: `${(count / total) * 100}%`,
      className: segmentClass[key],
      swatchClass: swatchClass[key],
      label: key,
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
      <div
        class="h-2 rounded overflow-hidden bg-surface-2 flex"
        role="img"
        aria-label={`${total} findings: ${segments.map((s) => `${s.count} ${s.label}`).join(", ")}`}
      >
        {segments.map((segment) => (
          <span
            key={segment.key}
            class={cn("h-full block", segment.className)}
            style={{ width: segment.width }}
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
