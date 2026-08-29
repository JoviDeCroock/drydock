/**
 * Presentational primitives for the docs page.
 *
 * Small, content-shaped building blocks — callouts, step lists, definition
 * rows, code blocks — kept apart from the prose so the page itself reads as
 * documentation rather than as markup.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useMemo } from "preact/hooks";
import { type Signal, useComputed } from "@preact/signals";
import { Badge, type BadgeTone } from "../../components/Badge";
import { Card } from "../../components/Card";
import { CopyButton } from "../../components/CopyButton";
import { cn } from "../../components/cn";
import { MonoLabel } from "../../components/Typography";
import {
  ensureHighlighter,
  highlighterReady,
  type TokenLine,
  tokenizeLines,
} from "../../components/highlight";
import { codeFold } from "./code-fold";
import { TOC } from "./toc";

export function TocList({ activeId }: { activeId: Signal<string> }) {
  return (
    <ul class="m-0 flex list-none flex-col border-l border-border p-0">
      {TOC.map((section) => (
        <li key={section.id}>
          <TocLink id={section.id} activeId={activeId}>
            {section.label}
          </TocLink>
          <ul class="m-0 flex list-none flex-col p-0">
            {section.children.map((child) => (
              <li key={child.id}>
                <TocLink id={child.id} activeId={activeId} depth={1}>
                  {child.label}
                </TocLink>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function TocLink({
  id,
  activeId,
  depth = 0,
  children,
}: {
  id: string;
  activeId: Signal<string>;
  depth?: 0 | 1;
  children: ComponentChildren;
}) {
  const linkClass = useComputed(() =>
    cn(
      "-ml-px block border-l-2 py-1 text-[13px] leading-[1.5] no-underline transition-colors",
      depth === 1 ? "pl-6" : "pl-3.5 font-medium",
      activeId.value === id
        ? "border-accent text-accent"
        : "border-transparent text-ink-muted hover:text-ink",
    ),
  );
  const ariaCurrent = useComputed(() => (activeId.value === id ? "location" : undefined));
  return (
    <a
      href={`#${id}`}
      class={linkClass}
      aria-current={ariaCurrent}
      onClick={() => {
        activeId.value = id;
      }}
    >
      {children}
    </a>
  );
}

export function JourneyCard({
  number,
  href,
  title,
  children,
}: {
  number: string;
  href: string;
  title: string;
  children: ComponentChildren;
}) {
  return (
    <a href={href} class="no-underline group">
      <Card
        as="div"
        padding="none"
        class="p-4 h-full grid grid-cols-[2rem_minmax(0,1fr)] gap-2 transition-colors group-hover:border-border-strong"
      >
        <span class="font-mono text-[11px] font-medium text-accent pt-[3px]">{number}</span>
        <div class="flex flex-col gap-1.5">
          <h2 class="text-[14px] font-medium tracking-[-0.005em] m-0 text-ink">{title}</h2>
          <p class="m-0 text-[12px] text-ink-muted leading-[1.55]">{children}</p>
        </div>
      </Card>
    </a>
  );
}

export function Callout({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="border-l-2 border-accent bg-accent-soft px-4 py-3 flex flex-col gap-1.5 max-w-[680px]">
      <span class="font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-accent">
        {label}
      </span>
      <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">{children}</p>
    </div>
  );
}

export function ReviewStep({
  number,
  label,
  children,
}: {
  number: string;
  label: string;
  children: ComponentChildren;
}) {
  return (
    <li class="p-5 flex flex-col gap-2 min-w-0">
      <div class="flex items-baseline gap-2.5">
        <span class="font-mono text-[11px] text-accent">{number}</span>
        <span class="font-medium text-[15px] tracking-[-0.005em]">{label}</span>
      </div>
      <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">{children}</p>
    </li>
  );
}

export function ReviewAnswer({
  label,
  question,
  children,
}: {
  label: string;
  question: string;
  children: ComponentChildren;
}) {
  return (
    <div class="px-5 py-3.5 grid grid-cols-1 sm:grid-cols-[120px_180px_minmax(0,1fr)] gap-1.5 sm:gap-4 sm:items-baseline">
      <MonoLabel as="dt">{label}</MonoLabel>
      <dd class="m-0 text-[13px] font-medium text-ink">{question}</dd>
      <dd class="m-0 text-[13px] leading-[1.55] text-ink-muted">{children}</dd>
    </div>
  );
}

export function ReportRow({
  label,
  value,
  tone = "neutral",
  children,
}: {
  label: string;
  value: string;
  tone?: BadgeTone;
  children: ComponentChildren;
}) {
  return (
    <div class="grid grid-cols-1 sm:grid-cols-[140px_minmax(0,1fr)] gap-2 sm:gap-4 px-5 py-4">
      <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle pt-0.5">
        {label}
      </span>
      <div class="flex flex-col items-start gap-1.5">
        <Badge tone={tone}>{value}</Badge>
        <p class="m-0 text-[13px] text-ink-muted leading-[1.55]">{children}</p>
      </div>
    </div>
  );
}

export function SafetyItem({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <div class="border-t border-border pt-3 flex flex-col gap-1.5">
      <h4 class="m-0 text-[13px] font-medium tracking-[-0.005em]">{title}</h4>
      <p class="m-0 text-[12px] text-ink-muted leading-[1.6]">{children}</p>
    </div>
  );
}

export function PathCard({
  title,
  badge,
  href,
  command,
  bestFor,
  heldBy,
  decision,
}: {
  title: string;
  badge: string;
  href: string;
  command: string;
  bestFor: string;
  heldBy: string;
  decision: string;
}) {
  return (
    <Card as="article" padding="none" class="p-5 flex flex-col gap-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h4 class="m-0 text-base font-medium tracking-[-0.005em]">{title}</h4>
        <Badge tone={badge === "Preview" ? "info" : "neutral"}>{badge}</Badge>
      </div>
      <code class="font-mono text-[12px] text-ink bg-surface-2 border border-border rounded px-2.5 py-2 overflow-x-auto">
        {command}
      </code>
      <dl class="m-0 flex flex-col gap-3">
        <Definition label="Best for">{bestFor}</Definition>
        <Definition label="Held by">{heldBy}</Definition>
        <Definition label="Decision">{decision}</Definition>
      </dl>
      <a href={href} class="mt-auto text-[13px] font-medium no-underline">
        Follow this setup →
      </a>
    </Card>
  );
}

function Definition({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
      <MonoLabel as="dt">{label}</MonoLabel>
      <dd class="m-0 text-[12px] leading-[1.55] text-ink-muted">{children}</dd>
    </div>
  );
}

export function Requirement({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="border-t border-border pt-3 flex flex-col gap-1">
      <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">{label}</span>
      <span class="text-[13px] font-medium text-ink">{children}</span>
    </div>
  );
}

export function WorkflowExample({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: string;
}) {
  return (
    <CodeBlock title={title} lang="yaml" defaultOpen={defaultOpen}>
      {children}
    </CodeBlock>
  );
}

export function Subsection({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: ComponentChildren;
}) {
  return (
    <div id={id} class="flex flex-col gap-3.5 scroll-mt-6">
      <h3 class="text-base font-medium tracking-[-0.005em] text-ink m-0">{title}</h3>
      {children}
    </div>
  );
}

export function Steps({ items }: { items: ComponentChildren[] }) {
  return (
    <ol class="list-none p-0 m-0 flex flex-col">
      {items.map((item, index) => (
        <li key={index} class="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3">
          <div class="flex flex-col items-center">
            <span class="font-mono text-[11px] font-medium text-ink-subtle tabular-nums leading-none pt-px">
              {String(index + 1).padStart(2, "0")}
            </span>
            {index < items.length - 1 ? (
              <span class="w-px flex-1 bg-border mt-2" aria-hidden />
            ) : null}
          </div>
          <div
            class={`text-[13px] text-ink-muted leading-[1.6] min-w-0 ${
              index < items.length - 1 ? "pb-5" : ""
            }`}
          >
            {item}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function CodeBlock({
  name,
  title,
  lang,
  defaultOpen = false,
  children,
}: {
  name?: string;
  title?: string;
  lang?: string;
  defaultOpen?: boolean;
  children: string;
}) {
  useEffect(() => {
    if (lang) ensureHighlighter();
  }, [lang]);

  const ready = highlighterReady.value;
  const tokens = useMemo(() => {
    if (!lang || !ready) return null;
    return tokenizeLines(children, lang);
  }, [children, lang, ready]);
  const fold = useMemo(() => codeFold(children), [children]);

  const shellClass = "overflow-hidden rounded-md border border-border bg-surface-2";

  /* One toolbar for both shapes: the optional file name or example title on
     the left, the copy affordance on the right. The block's own text stays
     selectable — copying a workflow file by hand means dragging across a
     scrolling <pre>, which is where docs readers give up. */
  const toolbar = (
    <div class="px-4 py-2 border-b border-border flex items-center justify-between gap-3">
      <span class="flex min-w-0 items-center gap-2.5">
        {fold.foldable ? (
          <span aria-hidden class="text-[10px] text-ink-subtle group-hover:text-ink">
            <span class="inline group-open:hidden">▸</span>
            <span class="hidden group-open:inline">▾</span>
          </span>
        ) : null}
        {title ? (
          <span class="text-[13px] font-medium text-ink min-w-0 truncate">{title}</span>
        ) : (
          <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle min-w-0 truncate">
            {name}
          </span>
        )}
      </span>
      {/* The copy button lives inside the <summary> of a foldable block, where
          a bare click would toggle the disclosure instead of copying. */}
      <span
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <CopyButton text={children} />
      </span>
    </div>
  );

  const body = <CodePre tokens={tokens} text={children} />;

  if (!fold.foldable) {
    return (
      <div class={shellClass}>
        {toolbar}
        {body}
      </div>
    );
  }

  return (
    <details open={defaultOpen} class={cn(shellClass, "group")}>
      {/* The peek duplicates the first lines of the block below it, so it is
          decoration for assistive technology; naming the summary explicitly
          keeps the whole snippet out of the toggle's accessible name. */}
      <summary class="cursor-pointer list-none" aria-label={title ?? name}>
        {toolbar}
        <div aria-hidden class="group-open:hidden">
          <CodePre
            tokens={tokens ? tokens.slice(0, fold.peekLineCount) : null}
            text={fold.peekText}
            class="pb-2"
          />
          <span class="block border-t border-border bg-surface-2 px-3 py-1 font-mono text-[11px] text-ink-subtle transition-colors group-hover:bg-accent-soft group-hover:text-ink">
            ⋯ {fold.hiddenCount.toLocaleString()} more lines · show more
          </span>
        </div>
      </summary>
      {body}
    </details>
  );
}

function CodePre({
  tokens,
  text,
  class: className,
}: {
  tokens: TokenLine[] | null;
  text: string;
  class?: string;
}) {
  return (
    <pre
      class={cn("m-0 p-4 overflow-x-auto font-mono text-[12px] leading-[1.55] text-ink", className)}
    >
      <code>
        {tokens ? (
          tokens.map((line, lineIndex) => (
            <span key={lineIndex} class="block whitespace-pre">
              {line.map((token, tokenIndex) => (
                <span key={tokenIndex} class={token.className}>
                  {token.content}
                </span>
              ))}
            </span>
          ))
        ) : (
          <span class="whitespace-pre">{text}</span>
        )}
      </code>
    </pre>
  );
}
