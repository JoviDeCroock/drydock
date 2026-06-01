import { diffLines } from "diff";
import { useMemo } from "preact/hooks";
import { Badge, statusTone } from "./Badge";
import {
  ensureHighlighter,
  highlighterReady,
  langForPath,
  tokenizeLines,
  type TokenLine,
} from "./highlight";
import { Muted } from "./Typography";
import { cn } from "./cn";

interface DiffSide {
  textSample?: string | null;
  size?: number | null;
  sha256?: string | null;
  flags?: string[];
}

export interface DiffViewProps {
  path: string;
  status: "added" | "removed" | "modified" | "unchanged" | string;
  before: DiffSide | null;
  after: DiffSide | null;
  beforeLabel: string;
  afterLabel: string;
}

interface Row {
  tone: "added" | "removed" | "unchanged";
  beforeLine: number | null;
  afterLine: number | null;
  text: string;
  tokens: TokenLine | null;
}

function buildRows(
  before: string,
  after: string,
  beforeTokens: TokenLine[] | null,
  afterTokens: TokenLine[] | null,
): Row[] {
  const parts = diffLines(before, after);
  const rows: Row[] = [];
  let beforeLine = 0;
  let afterLine = 0;
  for (const part of parts) {
    const lines = part.value.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      if (part.added) {
        afterLine += 1;
        rows.push({
          tone: "added",
          beforeLine: null,
          afterLine,
          text: line,
          tokens: afterTokens?.[afterLine - 1] ?? null,
        });
      } else if (part.removed) {
        beforeLine += 1;
        rows.push({
          tone: "removed",
          beforeLine,
          afterLine: null,
          text: line,
          tokens: beforeTokens?.[beforeLine - 1] ?? null,
        });
      } else {
        beforeLine += 1;
        afterLine += 1;
        rows.push({
          tone: "unchanged",
          beforeLine,
          afterLine,
          text: line,
          tokens: afterTokens?.[afterLine - 1] ?? beforeTokens?.[beforeLine - 1] ?? null,
        });
      }
    }
  }
  return rows;
}

// Tokenize an entire side once, memoized on the sample/language/ready signal.
function useLineTokens(text: string, lang: string | undefined): TokenLine[] | null {
  const ready = highlighterReady.value;
  return useMemo(
    () => (lang && ready && text ? tokenizeLines(text, lang) : null),
    [text, lang, ready],
  );
}

function LineContent({ text, tokens }: { text: string; tokens: TokenLine | null }) {
  if (!tokens || tokens.length === 0) return <>{text}</>;
  // Token content is rendered as escaped text children (never innerHTML) so
  // untrusted package bytes can't inject markup.
  return (
    <>
      {tokens.map((token, index) => (
        <span key={index} style={{ color: token.color }}>
          {token.content}
        </span>
      ))}
    </>
  );
}

function hasFlag(side: DiffSide | null, flag: string): boolean {
  return Boolean(side?.flags?.includes(flag));
}

export function DiffView({ path, status, before, after, beforeLabel, afterLabel }: DiffViewProps) {
  const beforeSample = before?.textSample ?? "";
  const afterSample = after?.textSample ?? "";

  const binary = hasFlag(before, "binary") || hasFlag(after, "binary");
  const truncated = hasFlag(before, "truncated") || hasFlag(after, "truncated");

  return (
    <div class="flex flex-col gap-3 min-h-0">
      <div class="flex flex-wrap items-center gap-2">
        <Badge tone={statusTone(status)}>{status}</Badge>
        <code class="font-mono text-xs text-ink-muted break-all">{path}</code>
        {truncated ? <Badge tone="neutral">truncated</Badge> : null}
        {binary ? <Badge tone="neutral">binary</Badge> : null}
      </div>
      <div class="font-mono text-[11px] text-ink-subtle flex flex-wrap gap-3">
        <span>
          {beforeLabel}: {formatSize(before?.size ?? null)}
        </span>
        <span>
          {afterLabel}: {formatSize(after?.size ?? null)}
        </span>
      </div>
      <DiffBody
        path={path}
        status={status}
        beforeSample={beforeSample}
        afterSample={afterSample}
        binary={binary}
        beforeLabel={beforeLabel}
        afterLabel={afterLabel}
      />
    </div>
  );
}

function DiffBody({
  path,
  status,
  beforeSample,
  afterSample,
  binary,
  beforeLabel,
  afterLabel,
}: {
  path: string;
  status: string;
  beforeSample: string;
  afterSample: string;
  binary: boolean;
  beforeLabel: string;
  afterLabel: string;
}) {
  const lang = langForPath(path);
  if (lang && !binary) ensureHighlighter();
  const beforeTokens = useLineTokens(beforeSample, lang);
  const afterTokens = useLineTokens(afterSample, lang);

  if (binary) {
    return <Muted class="text-[13px]">Binary file — no text diff available.</Muted>;
  }

  if (status === "added") {
    if (!afterSample) {
      return <Muted class="text-[13px]">No preview stored for this added file.</Muted>;
    }
    return (
      <SingleSidedView label={afterLabel} tone="added" text={afterSample} tokens={afterTokens} />
    );
  }
  if (status === "removed") {
    if (!beforeSample) {
      return <Muted class="text-[13px]">No preview stored for this removed file.</Muted>;
    }
    return (
      <SingleSidedView
        label={beforeLabel}
        tone="removed"
        text={beforeSample}
        tokens={beforeTokens}
      />
    );
  }
  if (status === "unchanged") {
    if (!afterSample && !beforeSample) {
      return <Muted class="text-[13px]">No preview stored for this file.</Muted>;
    }
    return (
      <SingleSidedView
        label={afterLabel || beforeLabel}
        tone="unchanged"
        text={afterSample || beforeSample}
        tokens={afterSample ? afterTokens : beforeTokens}
      />
    );
  }
  if (!beforeSample && !afterSample) {
    return <Muted class="text-[13px]">No text samples available to diff.</Muted>;
  }
  if (!beforeSample) {
    return (
      <SingleSidedView label={afterLabel} tone="added" text={afterSample} tokens={afterTokens} />
    );
  }
  if (!afterSample) {
    return (
      <SingleSidedView
        label={beforeLabel}
        tone="removed"
        text={beforeSample}
        tokens={beforeTokens}
      />
    );
  }

  const rows = buildRows(beforeSample, afterSample, beforeTokens, afterTokens);
  return (
    <div class="border border-border rounded-md overflow-hidden">
      <div class="bg-surface-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle flex justify-between">
        <span>{beforeLabel}</span>
        <span>{afterLabel}</span>
      </div>
      <div class="overflow-auto h-[560px]">
        <table class="w-full border-collapse font-mono text-[12px] leading-[1.55]">
          <tbody>
            {rows.map((row, index) => (
              <DiffRow key={index} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DiffRow({ row }: { row: Row }) {
  const bg = row.tone === "added" ? "bg-ok-soft" : row.tone === "removed" ? "bg-danger-soft" : "";
  const sign = row.tone === "added" ? "+" : row.tone === "removed" ? "-" : " ";
  return (
    <tr class={cn(bg)}>
      <td class="px-2 py-[2px] text-ink-subtle select-none w-[44px] text-right border-r border-border align-top">
        {row.beforeLine ?? ""}
      </td>
      <td class="px-2 py-[2px] text-ink-subtle select-none w-[44px] text-right border-r border-border align-top">
        {row.afterLine ?? ""}
      </td>
      <td class="px-2 py-[2px] select-none w-[20px] text-ink-subtle align-top">{sign}</td>
      <td class="px-2 py-[2px] whitespace-pre-wrap break-words align-top">
        <LineContent text={row.text} tokens={row.tokens} />
      </td>
    </tr>
  );
}

function SingleSidedView({
  label,
  tone,
  text,
  tokens,
}: {
  label: string;
  tone: "added" | "removed" | "unchanged";
  text: string;
  tokens: TokenLine[] | null;
}) {
  const headerBg =
    tone === "added" ? "bg-ok-soft" : tone === "removed" ? "bg-danger-soft" : "bg-surface-2";
  const rowBg = tone === "added" ? "bg-ok-soft" : tone === "removed" ? "bg-danger-soft" : "";
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return (
    <div class="border border-border rounded-md overflow-hidden">
      <div
        class={cn(
          "px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle",
          headerBg,
        )}
      >
        {label}
      </div>
      <div class="overflow-auto h-[560px]">
        <table class="w-full border-collapse font-mono text-[12px] leading-[1.55]">
          <tbody>
            {lines.map((line, index) => (
              <tr key={index} class={cn(rowBg)}>
                <td class="px-2 py-[2px] text-ink-subtle select-none w-[44px] text-right border-r border-border align-top">
                  {index + 1}
                </td>
                <td class="px-2 py-[2px] whitespace-pre-wrap break-words align-top">
                  <LineContent text={line} tokens={tokens?.[index] ?? null} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatSize(value: number | null): string {
  if (value === null || value === undefined) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
