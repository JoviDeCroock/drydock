import type { ComponentChildren } from "preact";
import { cn } from "./cn";
import { SectionLabel } from "./Typography";

export type CardPadding = "default" | "compact" | "comfortable" | "tight" | "roomy" | "none";

// A card that reacts to hover is a link or button target. `accent` is the
// affordance for a card the reader is meant to open; `strong` is the quieter
// one for a card that only needs to look reachable.
export type CardHover = "accent" | "strong";

const cardPaddingClass: Record<CardPadding, string> = {
  default: "p-6",
  compact: "p-5",
  comfortable: "p-5 md:p-6",
  tight: "p-4",
  roomy: "p-6 md:p-8",
  none: "",
};

const cardHoverClass: Record<CardHover, { self: string; within: string }> = {
  accent: { self: "hover:border-accent", within: "group-hover:border-accent" },
  strong: { self: "hover:border-border-strong", within: "group-hover:border-border-strong" },
};

function bodyLayoutClass(inset: "all" | "belowHeader", gap: "default" | "compact" | "none") {
  const insetClass = inset === "belowHeader" ? "px-5 pb-5" : "p-5";
  const gapClass = gap === "none" ? "" : gap === "compact" ? "gap-4" : "gap-5";
  return cn(insetClass, "flex flex-col", gapClass);
}

export function Card({
  class: className,
  children,
  as: As = "section",
  padding = "default",
  emphasis = "default",
  hover,
  hoverWithin = false,
}: {
  class?: string;
  children: ComponentChildren;
  as?: "section" | "article" | "div" | "aside";
  padding?: CardPadding;
  // `strong` picks the heavier border for a card that has to stand out from
  // the cards beside it.
  emphasis?: "default" | "strong";
  hover?: CardHover;
  // The hover is driven by an ancestor marked `group` — the card is part of a
  // larger link target rather than being the target itself.
  hoverWithin?: boolean;
}) {
  return (
    <As
      class={cn(
        "bg-surface border rounded-lg",
        emphasis === "strong" ? "border-border-strong" : "border-border",
        cardPaddingClass[padding],
        hover &&
          cn(
            cardHoverClass[hover][hoverWithin ? "within" : "self"],
            "transition-colors duration-150",
          ),
        className,
      )}
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
  return <div class={cn(bodyLayoutClass(inset, gap), className)}>{children}</div>;
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
  return (
    <form class={cn(bodyLayoutClass(inset, gap), className)} onSubmit={onSubmit}>
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
      <SectionLabel as="h3" class="flex-1">
        {title}
      </SectionLabel>
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
        <summary class="list-none cursor-pointer px-5 py-4 transition-colors hover:bg-surface-2">
          <SectionLabel
            as="h2"
            aside={aside ? <span class="flex items-center gap-2">{aside}</span> : undefined}
          >
            <span
              aria-hidden
              class="text-ink-subtle text-[10px] inline-block transition-transform duration-150 ease-out group-open:rotate-90"
            >
              ▸
            </span>
            <span>{title}</span>
          </SectionLabel>
        </summary>
        {/* The section-label's trailing rule is the header divider; a border-t
            here would stack a second hairline right below it (double border). */}
        <div>{children}</div>
      </details>
    </Card>
  );
}
