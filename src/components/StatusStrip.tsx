import type { ComponentChildren } from "preact";
import { Badge, type BadgeTone } from "./Badge";
import { cn } from "./cn";

export function StatusStrip({
  children,
  class: className,
  cols = 3,
}: {
  children: ComponentChildren;
  class?: string;
  cols?: 2 | 3 | 4;
}) {
  const colsClass =
    cols === 2 ? "md:grid-cols-2" : cols === 4 ? "md:grid-cols-2 lg:grid-cols-4" : "md:grid-cols-3";
  // A plain div: an unnamed <section> is an anonymous landmark-ish region
  // (noise in AT outlines), and the strip often nests inside an already
  // labeled section on marketing pages.
  return <div class={cn("grid grid-cols-1 gap-3", colsClass, className)}>{children}</div>;
}

export function StatusStripItem({
  label,
  status,
  tone = "neutral",
  children,
  class: className,
}: {
  label: string;
  status: string;
  tone?: BadgeTone;
  children?: ComponentChildren;
  class?: string;
}) {
  return (
    // Not an <article>: these tiles are dashboard readouts, not standalone
    // syndicatable content.
    <div
      class={cn(
        "bg-surface border border-border rounded-lg p-4 flex flex-col gap-2 min-h-[118px]",
        className,
      )}
    >
      <div class="flex items-center justify-between gap-3">
        <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
          {label}
        </span>
        <Badge tone={tone}>{status}</Badge>
      </div>
      {children ? <p class="m-0 text-[13px] leading-[1.55] text-ink-muted">{children}</p> : null}
    </div>
  );
}
