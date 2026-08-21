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
        "font-mono text-[12px] uppercase tracking-[0.1em] m-0",
        tone === "accent" ? "text-accent" : "text-ink-subtle",
        className,
      )}
    >
      {children}
    </p>
  );
}

// Section labels name both top-level sections and nested subsections, so every
// caller chooses its semantic level explicitly. Preflight keeps headings at
// inherited size/weight, so the visual treatment is unchanged. `aside` puts
// trailing metadata (e.g. a count) after the rule, which otherwise is drawn by
// the ::after pseudo.
export function SectionLabel({
  children,
  aside,
  as: As,
  class: className,
}: {
  children: ComponentChildren;
  aside?: ComponentChildren;
  as: "h2" | "h3" | "p";
  class?: string;
}) {
  return (
    <As
      class={cn(
        "font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle m-0 flex items-center gap-3",
        !aside && "after:content-[''] after:flex-1 after:h-px after:bg-border",
        className,
      )}
    >
      {children}
      {aside ? (
        <>
          <span aria-hidden class="flex-1 h-px bg-border" />
          <span>{aside}</span>
        </>
      ) : null}
    </As>
  );
}

// The system's bare 11px mono label (field labels, column headers, metadata
// captions). Use this instead of copy-pasting the class string — page-local
// copies have already drifted on tracking.
export function MonoLabel({
  children,
  as: As = "span",
  class: className,
}: {
  children: ComponentChildren;
  as?: "span" | "p" | "div" | "dt";
  class?: string;
}) {
  return (
    <As
      class={cn("font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle m-0", className)}
    >
      {children}
    </As>
  );
}

export function MonoDetail({
  parts,
  class: className,
}: {
  parts: Array<ComponentChildren>;
  class?: string;
}) {
  const filtered = parts.filter(
    (part) => part !== null && part !== undefined && part !== false && part !== "",
  );
  return (
    <p
      class={cn(
        "font-mono text-[11px] text-ink-subtle m-0 flex flex-wrap items-center gap-x-2 gap-y-1",
        className,
      )}
    >
      {filtered.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <span aria-hidden class="text-ink-subtle">
              ·
            </span>
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
  const sizeClass = size === "inline" ? "text-[12px] font-mono" : "text-[14px]";
  return (
    <p class={cn("text-ink-muted m-0 leading-[1.55]", sizeClass, className)} aria-live="polite">
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
  return <p class={cn("text-ink-muted m-0 text-[13px] leading-[1.55]", className)}>{children}</p>;
}

/**
 * A paragraph of body copy on a content page (docs, privacy). The max-width is
 * a measure limit, not a layout constraint — long-form prose gets unreadable
 * past roughly 80 characters.
 */
export function Prose({ children }: { children: ComponentChildren }) {
  return <p class="m-0 max-w-[680px] text-[14px] text-ink-muted leading-[1.65]">{children}</p>;
}

/**
 * A code span inside prose — a command, a file name, a field. The tinted
 * background is what separates it from surrounding text at 12px; block-level
 * code belongs in the docs page's CodeBlock instead.
 */
export function InlineCode({ children }: { children: ComponentChildren }) {
  return (
    <code class="font-mono text-[12px] text-ink bg-surface-2 px-1 py-0.5 rounded">{children}</code>
  );
}
