/**
 * A titled, copyable, optionally foldable code block.
 *
 * Shared because two surfaces show the same bytes: the docs page's workflow
 * examples and the gate-setup wizard's generated publish workflow. When it
 * lived in the docs page directory the wizard hand-rolled a plainer copy, so
 * the product rendered its own generated YAML worse than the documentation
 * did.
 *
 * The block's text stays real selectable text — copying a workflow by hand
 * means dragging across a scrolling `<pre>`, which is where readers give up.
 */
import { useEffect, useMemo } from "preact/hooks";
import { CopyButton } from "./CopyButton";
import { cn } from "./cn";
import { ensureHighlighter, highlighterReady, type TokenLine, tokenizeLines } from "./highlight";
import { codeFold } from "./code-fold";

export function CodeBlock({
  name,
  title,
  lang,
  copyLabel,
  defaultOpen = false,
  children,
}: {
  name?: string;
  title?: string;
  lang?: string;
  copyLabel?: string;
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

  /* One toolbar for an inline block and for the summary of a foldable one:
     the file name or example title on the left, the copy affordance on the
     right. The block's own text stays selectable — copying a workflow file by
     hand means dragging across a scrolling <pre>, which is where docs readers
     give up. */
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
        <CopyButton text={children} label={copyLabel} />
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
