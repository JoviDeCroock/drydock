import type { ComponentChildren } from "preact";
import { cn } from "./cn";

type Severity = "critical" | "high" | "medium" | "low" | "info" | "ok";
type Status = "added" | "removed" | "modified" | "unchanged" | "mixed";
export type BadgeTone = Severity | Status | "neutral";

const toneStyles: Record<BadgeTone, string> = {
  critical: "bg-danger-soft text-danger-text",
  high: "bg-danger-soft text-danger-text",
  medium: "bg-warn-soft text-warn-text",
  low: "bg-info-soft text-info-text",
  info: "bg-info-soft text-info-text",
  ok: "bg-ok-soft text-ok-text",
  added: "bg-ok-soft text-ok-text",
  removed: "bg-danger-soft text-danger-text",
  modified: "bg-warn-soft text-warn-text",
  mixed: "bg-accent-soft text-accent",
  unchanged: "bg-surface-2 text-ink-muted",
  neutral: "bg-surface-2 text-ink-muted",
};

export function Badge({
  tone = "neutral",
  dot = false,
  class: className,
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  class?: string;
  children: ComponentChildren;
}) {
  return (
    <span
      class={cn(
        "inline-flex items-center gap-1 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] px-1.5 py-0.5 rounded-[3px]",
        toneStyles[tone],
        className,
      )}
    >
      {dot ? <span class="w-1.5 h-1.5 rounded-full bg-current" aria-hidden /> : null}
      {children}
    </span>
  );
}

export function severityTone(sev: string): BadgeTone {
  switch (sev) {
    case "critical":
    case "high":
    case "medium":
    case "low":
    case "info":
    case "ok":
      return sev as Severity;
    default:
      return "neutral";
  }
}

export function statusTone(status: string): BadgeTone {
  switch (status) {
    case "added":
    case "removed":
    case "modified":
    case "unchanged":
    case "mixed":
      return status as Status;
    default:
      return "neutral";
  }
}
