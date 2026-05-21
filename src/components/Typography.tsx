import type { ComponentChildren } from "preact";
import { Fragment } from "preact";
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

export function MonoDetail({
  parts,
  class: className,
}: {
  parts: Array<ComponentChildren>;
  class?: string;
}) {
  const filtered = parts.filter((part) => part !== null && part !== undefined && part !== false && part !== "");
  return (
    <p class={cn("font-mono text-[11px] text-ink-subtle m-0 flex flex-wrap items-center gap-x-2 gap-y-1", className)}>
      {filtered.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <span aria-hidden class="text-ink-subtle">·</span>
          ) : null}
          <span>{part}</span>
        </Fragment>
      ))}
    </p>
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

export function LoadingLine({
  children,
  size = "full",
  class: className,
}: {
  children: ComponentChildren;
  size?: "inline" | "full";
  class?: string;
}) {
  const sizeClass =
    size === "inline"
      ? "text-[12px] font-mono"
      : "text-[14px]";
  return (
    <p
      class={cn("text-ink-muted m-0 leading-[1.55]", sizeClass, className)}
      aria-live="polite"
    >
      {children}
      <span class="ml-0.5 motion-safe:animate-pulse">…</span>
    </p>
  );
}

export function EmptyLine({
  children,
  class: className,
}: {
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <p class={cn("text-ink-muted m-0 text-[13px] leading-[1.55]", className)}>
      {children}
    </p>
  );
}
