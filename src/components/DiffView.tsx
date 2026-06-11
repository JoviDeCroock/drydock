import { diffLines } from "diff";
import { Fragment } from "preact";
import { useMemo } from "preact/hooks";
import { Badge, severityTone, statusTone } from "./Badge";
import {
  annotationLabel,
  partitionFindingsByLine,
  severityGroup,
  type DiffFinding,
  type SeverityGroup,
} from "./diff-annotations";
import {
  ensureHighlighter,
  highlighterReady,
  langForPath,
  tokenizeLines,
  type TokenLine,
} from "./highlight";
import { Muted } from "./Typography";
import { cn } from "./cn";

export type { DiffFinding } from "./diff-annotations";

// A scan comment pinned to a staged (after-side) line, already resolved to
// display strings by the caller so DiffView stays decoupled from member data.
export interface DiffComment {
  id: string;
  line?: number | null;
  authorLabel: string;
  timeLabel: string;
  segments: Array<{ type: "text"; text: string } | { type: "mention"; label: string }>;
}

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
  // Deterministic findings for this file, pinned to the staged line they
  // reference. Findings without a matching line surface in a banner above the
  // diff so a truncated sample can't hide a signal.
  findings?: DiffFinding[];
  // Team comments anchored to staged lines of this file, pinned the same way.
  comments?: DiffComment[];
  // When provided, every staged line gets a hover "+" affordance that starts
  // a comment on that line.
  onLineComment?: (line: number) => void;
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

export function DiffView({
  path,
  status,
  before,
  after,
  beforeLabel,
  afterLabel,
  findings = [],
  comments = [],
  onLineComment,
}: DiffViewProps) {
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
        findings={findings}
        comments={comments}
        onLineComment={onLineComment}
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
  findings,
  comments,
  onLineComment,
}: {
  path: string;
  status: string;
  beforeSample: string;
  afterSample: string;
  binary: boolean;
  beforeLabel: string;
  afterLabel: string;
  findings: DiffFinding[];
  comments: DiffComment[];
  onLineComment?: (line: number) => void;
}) {
  const lang = langForPath(path);
  if (lang && !binary) ensureHighlighter();
  const beforeTokens = useLineTokens(beforeSample, lang);
  const afterTokens = useLineTokens(afterSample, lang);

  if (binary) {
    return <DiffMessage findings={findings}>Binary file — no text diff available.</DiffMessage>;
  }

  if (status === "added") {
    if (!afterSample) {
      return <DiffMessage findings={findings}>No preview stored for this added file.</DiffMessage>;
    }
    return (
      <SingleSidedView
        label={afterLabel}
        tone="added"
        text={afterSample}
        tokens={afterTokens}
        findings={findings}
        comments={comments}
        onLineComment={onLineComment}
      />
    );
  }
  if (status === "removed") {
    if (!beforeSample) {
      return (
        <DiffMessage findings={findings}>No preview stored for this removed file.</DiffMessage>
      );
    }
    return (
      <SingleSidedView
        label={beforeLabel}
        tone="removed"
        text={beforeSample}
        tokens={beforeTokens}
        findings={findings}
        comments={comments}
      />
    );
  }
  if (status === "unchanged") {
    if (!afterSample && !beforeSample) {
      return <DiffMessage findings={findings}>No preview stored for this file.</DiffMessage>;
    }
    return (
      <SingleSidedView
        label={afterLabel || beforeLabel}
        tone="unchanged"
        text={afterSample || beforeSample}
        tokens={afterSample ? afterTokens : beforeTokens}
        findings={findings}
        comments={comments}
        onLineComment={afterSample ? onLineComment : undefined}
      />
    );
  }
  if (!beforeSample && !afterSample) {
    return <DiffMessage findings={findings}>No text samples available to diff.</DiffMessage>;
  }
  if (!beforeSample) {
    return (
      <SingleSidedView
        label={afterLabel}
        tone="added"
        text={afterSample}
        tokens={afterTokens}
        findings={findings}
        comments={comments}
        onLineComment={onLineComment}
      />
    );
  }
  if (!afterSample) {
    return (
      <SingleSidedView
        label={beforeLabel}
        tone="removed"
        text={beforeSample}
        tokens={beforeTokens}
        findings={findings}
        comments={comments}
      />
    );
  }

  const rows = buildRows(beforeSample, afterSample, beforeTokens, afterTokens);
  const presentLines = new Set<number>();
  for (const row of rows) if (row.afterLine !== null) presentLines.add(row.afterLine);
  const { pinned, unpinned } = partitionFindingsByLine(findings, presentLines);
  const { pinned: pinnedComments, unpinned: unpinnedComments } = partitionFindingsByLine(
    comments,
    presentLines,
  );
  return (
    <div class="border border-border rounded-md overflow-hidden">
      <div class="bg-surface-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle flex justify-between">
        <span>{beforeLabel}</span>
        <span>{afterLabel}</span>
      </div>
      {unpinned.length ? <AnnotationBanner findings={unpinned} /> : null}
      {unpinnedComments.length ? <CommentBanner comments={unpinnedComments} /> : null}
      <div class="overflow-auto h-[560px]">
        <table class="w-full border-collapse font-mono text-[12px] leading-[1.55]">
          <tbody>
            {rows.map((row, index) => {
              const pins = row.afterLine !== null ? pinned.get(row.afterLine) : undefined;
              const commentPins =
                row.afterLine !== null ? pinnedComments.get(row.afterLine) : undefined;
              return (
                <Fragment key={index}>
                  <DiffRow row={row} onLineComment={onLineComment} />
                  {pins ? <AnnotationRows findings={pins} colSpan={4} /> : null}
                  {commentPins ? <CommentRows comments={commentPins} colSpan={4} /> : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DiffRow({ row, onLineComment }: { row: Row; onLineComment?: (line: number) => void }) {
  const bg = row.tone === "added" ? "bg-ok-soft" : row.tone === "removed" ? "bg-danger-soft" : "";
  const sign = row.tone === "added" ? "+" : row.tone === "removed" ? "-" : " ";
  const afterLine = row.afterLine;
  return (
    <tr class={cn(bg, "group")}>
      <td class="px-2 py-[2px] text-ink-subtle select-none w-[44px] text-right border-r border-border align-top">
        {row.beforeLine ?? ""}
      </td>
      <td class="px-2 py-[2px] text-ink-subtle select-none w-[44px] text-right border-r border-border align-top">
        {afterLine !== null && onLineComment ? (
          <LineCommentTrigger line={afterLine} onLineComment={onLineComment} />
        ) : (
          (afterLine ?? "")
        )}
      </td>
      <td class="px-2 py-[2px] select-none w-[20px] text-ink-subtle align-top">{sign}</td>
      <td class="px-2 py-[2px] whitespace-pre-wrap break-words align-top">
        <LineContent text={row.text} tokens={row.tokens} />
      </td>
    </tr>
  );
}

// The staged line number doubles as the "start a comment here" affordance: a
// text "+" replaces it on row hover (text glyphs only, per DESIGN.md).
function LineCommentTrigger({
  line,
  onLineComment,
}: {
  line: number;
  onLineComment: (line: number) => void;
}) {
  return (
    <button
      type="button"
      class="w-full text-right cursor-pointer text-ink-subtle hover:text-accent focus-visible:text-accent outline-none bg-transparent border-0 p-0 font-mono text-inherit"
      title={`Comment on line ${line}`}
      onClick={() => onLineComment(line)}
    >
      <span class="group-hover:hidden">{line}</span>
      <span class="hidden group-hover:inline">+</span>
    </button>
  );
}

function SingleSidedView({
  label,
  tone,
  text,
  tokens,
  findings,
  comments = [],
  onLineComment,
}: {
  label: string;
  tone: "added" | "removed" | "unchanged";
  text: string;
  tokens: TokenLine[] | null;
  findings: DiffFinding[];
  comments?: DiffComment[];
  onLineComment?: (line: number) => void;
}) {
  const headerBg =
    tone === "added" ? "bg-ok-soft" : tone === "removed" ? "bg-danger-soft" : "bg-surface-2";
  const rowBg = tone === "added" ? "bg-ok-soft" : tone === "removed" ? "bg-danger-soft" : "";
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const presentLines = new Set<number>(lines.map((_, index) => index + 1));
  const { pinned, unpinned } = partitionFindingsByLine(findings, presentLines);
  const { pinned: pinnedComments, unpinned: unpinnedComments } = partitionFindingsByLine(
    comments,
    presentLines,
  );
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
      {unpinned.length ? <AnnotationBanner findings={unpinned} /> : null}
      {unpinnedComments.length ? <CommentBanner comments={unpinnedComments} /> : null}
      <div class="overflow-auto h-[560px]">
        <table class="w-full border-collapse font-mono text-[12px] leading-[1.55]">
          <tbody>
            {lines.map((line, index) => {
              const pins = pinned.get(index + 1);
              const commentPins = pinnedComments.get(index + 1);
              return (
                <Fragment key={index}>
                  <tr class={cn(rowBg, "group")}>
                    <td class="px-2 py-[2px] text-ink-subtle select-none w-[44px] text-right border-r border-border align-top">
                      {onLineComment ? (
                        <LineCommentTrigger line={index + 1} onLineComment={onLineComment} />
                      ) : (
                        index + 1
                      )}
                    </td>
                    <td class="px-2 py-[2px] whitespace-pre-wrap break-words align-top">
                      <LineContent text={line} tokens={tokens?.[index] ?? null} />
                    </td>
                  </tr>
                  {pins ? <AnnotationRows findings={pins} colSpan={2} /> : null}
                  {commentPins ? <CommentRows comments={commentPins} colSpan={2} /> : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Severity-tinted fills and left bars for a pinned finding. The fill uses the
// soft severity token at reduced opacity so it reads as a callout over the
// green/red row backgrounds; the bar uses the saturated token (shapes, per
// DESIGN.md "color = signal"). Both are static class strings so Tailwind keeps
// them.
const ANNOTATION_FILL: Record<SeverityGroup, string> = {
  danger: "bg-danger-soft/60",
  warn: "bg-warn-soft/60",
  info: "bg-info-soft/60",
  ok: "bg-ok-soft/60",
};

const ANNOTATION_BAR: Record<SeverityGroup, string> = {
  danger: "border-danger",
  warn: "border-warn",
  info: "border-info",
  ok: "border-ok",
};

// The body of a pinned finding: severity Badge + mono `ruleId · line N` caption,
// the reason, and (when present) the triggering evidence in mono. Mirrors the
// landing page's review-preview annotation so what we advertise matches the app.
function FindingAnnotationBody({ finding }: { finding: DiffFinding }) {
  const group = severityGroup(finding.severity);
  const label = annotationLabel(finding);
  return (
    <div
      class={cn(
        // font-sans: the callout sits inside the mono diff table, but the reason
        // is body copy and must not inherit Geist Mono (label/evidence set their
        // own mono explicitly).
        "border-l-2 px-3 py-2.5 flex flex-col gap-1.5 font-sans",
        ANNOTATION_FILL[group],
        ANNOTATION_BAR[group],
      )}
    >
      <div class="flex flex-wrap items-center gap-2">
        <Badge tone={severityTone(finding.severity)}>{finding.severity}</Badge>
        {label ? (
          <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
            {label}
          </span>
        ) : null}
      </div>
      <p class="m-0 text-[13px] leading-[1.55] text-ink whitespace-normal">{finding.reason}</p>
      {finding.evidence ? (
        <code class="font-mono text-[11px] leading-[1.5] text-ink-muted break-words whitespace-pre-wrap">
          {finding.evidence}
        </code>
      ) : null}
    </div>
  );
}

// Findings pinned beneath their diff line, rendered as full-width table rows.
function AnnotationRows({ findings, colSpan }: { findings: DiffFinding[]; colSpan: number }) {
  return (
    <>
      {findings.map((finding) => (
        <tr key={finding.id}>
          <td colSpan={colSpan} class="p-0">
            <FindingAnnotationBody finding={finding} />
          </td>
        </tr>
      ))}
    </>
  );
}

// A team comment pinned beneath its staged line. Accent-neutral (no severity
// tint) so human discussion reads distinctly from machine findings.
function CommentAnnotationBody({ comment }: { comment: DiffComment }) {
  return (
    <div class="border-l-2 border-accent bg-surface-2 px-3 py-2.5 flex flex-col gap-1 font-sans">
      <div class="flex flex-wrap items-baseline gap-2">
        <span class="text-[12px] font-medium text-ink">{comment.authorLabel}</span>
        <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
          {comment.timeLabel}
        </span>
      </div>
      <p class="m-0 text-[13px] leading-[1.55] text-ink whitespace-pre-wrap break-words">
        {comment.segments.map((segment, index) =>
          segment.type === "mention" ? (
            <span key={index} class="text-accent font-medium">
              @{segment.label}
            </span>
          ) : (
            <Fragment key={index}>{segment.text}</Fragment>
          ),
        )}
      </p>
    </div>
  );
}

function CommentRows({ comments, colSpan }: { comments: DiffComment[]; colSpan: number }) {
  return (
    <>
      {comments.map((comment) => (
        <tr key={comment.id}>
          <td colSpan={colSpan} class="p-0">
            <CommentAnnotationBody comment={comment} />
          </td>
        </tr>
      ))}
    </>
  );
}

function CommentBanner({ comments }: { comments: DiffComment[] }) {
  return (
    <div class="flex flex-col divide-y divide-border border-b border-border">
      {comments.map((comment) => (
        <CommentAnnotationBody key={comment.id} comment={comment} />
      ))}
    </div>
  );
}

// Findings that can't be pinned (no line, or a line past a truncated sample),
// shown between the header strip and the scroll region so they're never hidden.
function AnnotationBanner({ findings }: { findings: DiffFinding[] }) {
  return (
    <div class="flex flex-col divide-y divide-border border-b border-border">
      {findings.map((finding) => (
        <FindingAnnotationBody key={finding.id} finding={finding} />
      ))}
    </div>
  );
}

// A non-table fallback (binary / no-sample) that still surfaces any findings as
// standalone callouts above the explanatory line, so a missing diff body never
// drops a deterministic signal.
function DiffMessage({ children, findings }: { children: string; findings: DiffFinding[] }) {
  if (!findings.length) return <Muted class="text-[13px]">{children}</Muted>;
  return (
    <div class="flex flex-col gap-3">
      <div class="border border-border rounded-md overflow-hidden flex flex-col divide-y divide-border">
        {findings.map((finding) => (
          <FindingAnnotationBody key={finding.id} finding={finding} />
        ))}
      </div>
      <Muted class="text-[13px]">{children}</Muted>
    </div>
  );
}

function formatSize(value: number | null): string {
  if (value === null || value === undefined) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
