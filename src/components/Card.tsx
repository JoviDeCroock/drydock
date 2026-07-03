import type { ComponentChildren } from "preact";
import { cn } from "./cn";
import { SectionLabel } from "./Typography";

export type CardPadding = "default" | "compact" | "none";

const cardPaddingClass: Record<CardPadding, string> = {
  default: "p-6",
  compact: "p-5",
  none: "",
};

export function Card({
  class: className,
  children,
  as: As = "section",
  padding = "default",
}: {
  class?: string;
  children: ComponentChildren;
  as?: "section" | "article" | "div" | "aside";
  padding?: CardPadding;
}) {
  return (
    <As
      class={cn("bg-surface border border-border rounded-lg", cardPaddingClass[padding], className)}
    >
      {children}
    </As>
  );
}

export function SettingsCard({
  class: className,
  children,
  as,
}: {
  class?: string;
  children: ComponentChildren;
  as?: "section" | "article" | "div" | "aside";
}) {
  return (
    <Card as={as} padding="compact" class={className}>
      {children}
    </Card>
  );
}

export function SettingsCardBody({
  class: className,
  children,
  inset = "all",
  gap = "default",
}: {
  class?: string;
  children: ComponentChildren;
  inset?: "all" | "belowHeader";
  gap?: "default" | "compact" | "none";
}) {
  const insetClass = inset === "belowHeader" ? "px-5 pb-5" : "p-5";
  const gapClass = gap === "none" ? "" : gap === "compact" ? "gap-4" : "gap-5";
  return <div class={cn(insetClass, "flex flex-col", gapClass, className)}>{children}</div>;
}

export function SettingsCardForm({
  class: className,
  children,
  onSubmit,
  inset = "belowHeader",
  gap = "compact",
}: {
  class?: string;
  children: ComponentChildren;
  onSubmit?: (event: Event) => void;
  inset?: "all" | "belowHeader";
  gap?: "default" | "compact" | "none";
}) {
  const insetClass = inset === "belowHeader" ? "px-5 pb-5" : "p-5";
  const gapClass = gap === "none" ? "" : gap === "compact" ? "gap-4" : "gap-5";
  return (
    <form class={cn(insetClass, "flex flex-col", gapClass, className)} onSubmit={onSubmit}>
      {children}
    </form>
  );
}

export function SettingsCardHeader({
  title,
  aside,
  class: className,
}: {
  title: ComponentChildren;
  aside?: ComponentChildren;
  class?: string;
}) {
  return (
    <div class={cn("px-5 py-4 flex items-center justify-between gap-3", className)}>
      <SectionLabel class="flex-1">{title}</SectionLabel>
      {aside ? <div class="shrink-0 flex items-center gap-2">{aside}</div> : null}
    </div>
  );
}

export function SettingsCardListItem({
  class: className,
  children,
}: {
  class?: string;
  children: ComponentChildren;
}) {
  return (
    <li
      class={cn(
        "border-b border-border last:border-b-0 px-5 py-4 flex flex-wrap items-center justify-between gap-3",
        className,
      )}
    >
      {children}
    </li>
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
    <Card as="section" padding="none" class={cn("overflow-hidden", className)}>
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
        {/* The section-label's trailing rule is the header divider; a border-t
            here would stack a second hairline right below it (double border). */}
        <div>{children}</div>
      </details>
    </Card>
  );
}
