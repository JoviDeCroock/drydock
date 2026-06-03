import type { ComponentChildren } from "preact";
import { cn } from "./cn";
import { SectionLabel } from "./Typography";

export function Card({
  class: className,
  children,
  as: As = "section",
}: {
  class?: string;
  children: ComponentChildren;
  as?: "section" | "article" | "div" | "aside";
}) {
  return (
    <As class={cn("bg-surface border border-border rounded-lg p-6", className)}>{children}</As>
  );
}

export function CollapsibleCard({
  title,
  aside,
  defaultOpen = false,
  class: className,
  children,
}: {
  title: ComponentChildren;
  aside?: ComponentChildren;
  defaultOpen?: boolean;
  class?: string;
  children: ComponentChildren;
}) {
  return (
    <Card as="section" class={cn("p-0 overflow-hidden", className)}>
      <details open={defaultOpen} class="group">
        <summary class="list-none cursor-pointer flex items-center gap-2.5 px-5 py-4 transition-colors hover:bg-surface-2">
          <span
            aria-hidden
            class="text-ink-subtle text-[10px] inline-block transition-transform duration-150 ease-out group-open:rotate-90"
          >
            ▸
          </span>
          <SectionLabel class="flex-1">{title}</SectionLabel>
          {aside ? <div class="flex items-center gap-2 shrink-0">{aside}</div> : null}
        </summary>
        <div class="border-t border-border">{children}</div>
      </details>
    </Card>
  );
}

export type SummaryCardTone = "default" | "danger" | "warn" | "ok" | "info";
export type SummaryCardValue = "identifier" | "sentence" | "metric";

const valueClass: Record<SummaryCardValue, string> = {
  identifier: "font-mono text-[13px] font-medium leading-tight break-all",
  sentence: "text-[14px] leading-tight",
  metric: "font-mono text-[18px] font-medium leading-tight tracking-[-0.01em]",
};

const toneClass: Record<SummaryCardTone, string> = {
  default: "text-ink",
  danger: "text-danger-text",
  warn: "text-warn-text",
  ok: "text-ok-text",
  info: "text-info-text",
};

export function SummaryCard({
  label,
  children,
  tone = "default",
  value = "identifier",
  class: className,
}: {
  label: string;
  children: ComponentChildren;
  tone?: SummaryCardTone;
  value?: SummaryCardValue;
  class?: string;
}) {
  return (
    <div
      class={cn(
        "bg-surface border border-border rounded-lg px-3.5 py-3 flex flex-col gap-1.5 min-w-0",
        className,
      )}
    >
      <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">{label}</span>
      <span class={cn(valueClass[value], toneClass[tone])}>{children}</span>
    </div>
  );
}
