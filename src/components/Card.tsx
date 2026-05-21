import type { ComponentChildren } from "preact";
import { cn } from "./cn";

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
    <As class={cn("bg-surface border border-border rounded-lg p-6", className)}>
      {children}
    </As>
  );
}

export function SummaryCard({
  label,
  children,
  tone,
  class: className,
}: {
  label: string;
  children: ComponentChildren;
  tone?: "default" | "danger";
  class?: string;
}) {
  return (
    <div
      class={cn(
        "bg-surface border border-border rounded-md px-3.5 py-3 flex flex-col gap-1.5",
        className,
      )}
    >
      <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">{label}</span>
      <span
        class={cn(
          "font-mono text-[15px] font-medium leading-tight break-all",
          tone === "danger" ? "text-danger" : "text-ink",
        )}
      >
        {children}
      </span>
    </div>
  );
}
