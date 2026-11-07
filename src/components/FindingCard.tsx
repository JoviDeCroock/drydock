import { Fragment, type ComponentChildren } from "preact";
import { findingSentence } from "../lib/findings";
import { Badge, severityTone } from "./Badge";
import { cn } from "./cn";

function FileRef({
  file,
  onSelect,
  class: className,
}: {
  file: string;
  onSelect?: () => void;
  class?: string;
}) {
  return onSelect ? (
    <button
      type="button"
      onClick={onSelect}
      title={`Open ${file} in the diff`}
      class={cn(
        "font-mono text-[13px] text-ink-muted hover:text-accent truncate text-left [direction:rtl] bg-transparent border-0 p-0 m-0 cursor-pointer transition-colors duration-150 ease-out",
        className,
      )}
    >
      <bdi>{file}</bdi>
    </button>
  ) : (
    <code
      class={cn("text-[13px] text-ink-muted truncate text-left [direction:rtl]", className)}
      title={file}
    >
      <bdi>{file}</bdi>
    </code>
  );
}

export function FindingCard({
  severity,
  file,
  line,
  diffStatus,
  diffLabel,
  ruleId,
  source,
  onSelect,
  children,
  class: className,
}: {
  severity: string;
  file: string;
  line?: number | null;
  diffStatus?: string | null;
  diffLabel?: string | null;
  ruleId?: string | null;
  // Finding provenance ("rule" | "ai"). Assistant findings carry a badge so
  // advisory signals stay visually distinct from deterministic rules.
  source?: string | null;
  // When provided, the filename becomes a button that opens this file in the
  // diff workbench, turning the signal list into an index into the diff.
  onSelect?: () => void;
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <li
      class={cn(
        "bg-surface border border-border rounded-lg px-4 py-3 flex flex-col gap-2",
        className,
      )}
    >
      <div class="flex flex-col gap-1 min-w-0">
        <div class="flex items-center gap-2.5 min-w-0">
          <Badge tone={severityTone(severity)}>{severity}</Badge>
          {source === "ai" ? (
            <Badge tone="neutral" class="shrink-0">
              assistant
            </Badge>
          ) : null}
          <FileRef file={file} onSelect={onSelect} />
        </div>
        <FindingMeta
          parts={[
            line ? (
              <span key="line" class="shrink-0">
                L{line}
              </span>
            ) : null,
            ruleId ? (
              <span
                key="rule"
                class="truncate uppercase tracking-[0.05em]"
                title={`Rule ${ruleId}`}
              >
                {ruleId}
              </span>
            ) : null,
            diffStatus ? (
              <span key="status" class="shrink-0">
                {diffLabel ?? diffStatus}
              </span>
            ) : null,
          ]}
        />
      </div>
      <div class="text-[13px] leading-[1.55] flex flex-col gap-1.5">{children}</div>
    </li>
  );
}

// The mono caption under the file: line, rule, and — only when the caller
// passes one — the file's diff status as plain text. The status used to be a
// colored chip, which painted a finding's own file green ("added") and repeated
// what the risk-signals section split already says.
function FindingMeta({ parts }: { parts: ComponentChildren[] }) {
  const present = parts.filter(Boolean);
  if (!present.length) return null;
  return (
    <div class="flex items-center gap-2 min-w-0 font-mono text-[11px] text-ink-subtle">
      {present.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <span class="shrink-0" aria-hidden>
              ·
            </span>
          ) : null}
          {part}
        </Fragment>
      ))}
    </div>
  );
}

export interface GroupedFindingFile {
  file: string;
  line?: number | null;
  diffStatus?: string | null;
  diffLabel?: string | null;
  onSelect?: () => void;
}

// One card for a rule that fired with identical evidence across several files
// (e.g. every file in a shipped test suite spawning processes). The signal
// reads once; the affected files collapse into a single mono list instead of
// repeating a full card per file.
export function GroupedFindingCard({
  severity,
  ruleId,
  files,
  children,
  class: className,
}: {
  severity: string;
  ruleId?: string | null;
  files: GroupedFindingFile[];
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <li
      class={cn(
        "bg-surface border border-border rounded-lg px-4 py-3 flex flex-col gap-2",
        className,
      )}
    >
      <div class="flex flex-col gap-1 min-w-0">
        <div class="flex items-center gap-2.5 min-w-0">
          <Badge tone={severityTone(severity)}>{severity}</Badge>
          <span class="font-mono text-[13px] text-ink-muted truncate">{files.length} files</span>
        </div>
        {ruleId ? (
          <div class="flex items-center gap-2 min-w-0 font-mono text-[11px] text-ink-subtle">
            <span class="truncate uppercase tracking-[0.05em]" title={`Rule ${ruleId}`}>
              {ruleId}
            </span>
          </div>
        ) : null}
      </div>
      <div class="text-[13px] leading-[1.55] flex flex-col gap-1.5">{children}</div>
      <ul class="list-none p-0 m-0 flex flex-col gap-1">
        {files.map((entry) => (
          <li key={`${entry.file}:${entry.line ?? ""}`} class="flex items-center gap-2 min-w-0">
            <FileRef file={entry.file} onSelect={entry.onSelect} />
            {entry.line ? (
              <span class="shrink-0 font-mono text-[11px] text-ink-subtle">L{entry.line}</span>
            ) : null}
            {entry.diffStatus ? (
              <span class="shrink-0 font-mono text-[11px] text-ink-subtle">
                {entry.diffLabel ?? entry.diffStatus}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </li>
  );
}

/**
 * A finding's body: the reason as a sentence, then the evidence as the machine
 * value it is. Evidence is mono and may break anywhere, so a 64-character digest
 * wraps inside the card instead of setting its minimum width.
 */
export function FindingDetails({ reason, evidence }: { reason: string; evidence?: string | null }) {
  return (
    <>
      <p class="m-0 text-ink max-w-[760px]">{findingSentence(reason)}</p>
      {evidence ? (
        <code class="block font-mono text-[12px] leading-[1.5] text-ink-muted wrap-anywhere whitespace-pre-wrap max-w-[760px]">
          {evidence}
        </code>
      ) : null}
    </>
  );
}

export interface FindingIndexLocation {
  file: string;
  line?: number | null;
  note?: string | null;
  onSelect?: () => void;
}

/**
 * One entry for findings the diff already shows in full: severity, the rule,
 * and the locations it opens. A rule that fired with the same reason in
 * several files reads once, above one compact action per location.
 */
export function FindingIndexRow({
  severity,
  ruleId,
  note,
  reason,
  locations,
}: {
  severity: string;
  ruleId?: string | null;
  note?: string | null;
  /**
   * The diff shows one file at a time, so the row keeps the reason: without it,
   * findings on every other file would have no explanation on the page until
   * opened. Null only when another element on the page states it.
   */
  reason?: string | null;
  locations: FindingIndexLocation[];
}) {
  const [only] = locations;
  const grouped = locations.length > 1;
  return (
    <li class="flex items-start gap-2.5 min-w-0 py-2">
      <Badge tone={severityTone(severity)} class="shrink-0">
        {severity}
      </Badge>
      {/* Stacks on narrow screens so the path keeps its width. */}
      <div class="min-w-0 flex-1 flex flex-col gap-0.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2.5">
        {grouped ? (
          <span class="font-mono text-[13px] text-ink-muted shrink-0">
            {locations.length} locations
          </span>
        ) : (
          <FileRef
            file={only.file}
            onSelect={only.onSelect}
            class="min-w-0 max-w-full sm:max-w-[60%]"
          />
        )}
        <FindingMeta
          parts={[
            !grouped && only.line ? (
              <span key="line" class="shrink-0">
                L{only.line}
              </span>
            ) : null,
            ruleId ? (
              <span
                key="rule"
                class="truncate uppercase tracking-[0.05em]"
                title={`Rule ${ruleId}`}
              >
                {ruleId}
              </span>
            ) : null,
            (note ?? (!grouped ? only.note : null)) ? (
              <span key="note" class="shrink-0">
                {note ?? only.note}
              </span>
            ) : null,
          ]}
        />
        {reason ? (
          <p class="m-0 text-[13px] leading-[1.5] text-ink-muted sm:basis-full">
            {findingSentence(reason)}
          </p>
        ) : null}
        {grouped ? (
          <ul class="list-none p-0 m-0 mt-0.5 flex flex-wrap gap-x-4 gap-y-1 min-w-0 sm:basis-full">
            {locations.map((location) => (
              <li
                key={`${location.file}:${location.line ?? ""}`}
                class="flex items-center gap-1.5 min-w-0 max-w-full"
              >
                <FileRef file={location.file} onSelect={location.onSelect} class="min-w-0" />
                <FindingMeta
                  parts={[
                    location.line ? (
                      <span key="line" class="shrink-0">
                        L{location.line}
                      </span>
                    ) : null,
                    location.note ? (
                      <span key="note" class="shrink-0">
                        {location.note}
                      </span>
                    ) : null,
                  ]}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}
