import type { ComponentChildren } from "preact";
import { cn } from "./cn";

export function Eyebrow({
  children,
  tone = "subtle",
  class: className,
}: {
  children: ComponentChildren;
  tone?: "subtle" | "accent";
  class?: string;
}) {
  return (
    <p
      class={cn(
        "font-mono text-[11px] uppercase tracking-[0.1em] m-0",
        tone === "accent" ? "text-accent" : "text-ink-subtle",
        className,
      )}
    >
      {children}
    </p>
  );
}

export function SectionLabel({
  children,
  class: className,
}: {
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <p
      class={cn(
        "font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle m-0 flex items-center gap-3",
        "after:content-[''] after:flex-1 after:h-px after:bg-border",
        className,
      )}
    >
      {children}
    </p>
  );
}

export function MonoLine({
  children,
  class: className,
}: {
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <p class={cn("font-mono text-xs text-ink-muted m-0", className)}>{children}</p>
  );
}

export function Muted({
  children,
  class: className,
  as: As = "p",
}: {
  children: ComponentChildren;
  class?: string;
  as?: "p" | "span" | "div";
}) {
  return <As class={cn("text-ink-muted", className)}>{children}</As>;
}
