import type { ComponentChildren } from "preact";
import { Badge, severityTone, statusTone } from "./Badge";
import { cn } from "./cn";

export function FileRef({
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
          <Badge tone={severityTone(severity)} dot>
            {severity}
          </Badge>
          <FileRef file={file} onSelect={onSelect} />
          {diffStatus ? (
            <Badge tone={statusTone(diffStatus)} class="flex-shrink-0">
              {diffLabel ?? diffStatus}
            </Badge>
          ) : null}
        </div>
        {line || ruleId ? (
          <div class="flex items-center gap-2 min-w-0 font-mono text-[11px] text-ink-subtle">
            {line ? <span class="flex-shrink-0">L{line}</span> : null}
            {line && ruleId ? (
              <span class="flex-shrink-0" aria-hidden>
                ·
              </span>
            ) : null}
            {ruleId ? (
              <span class="truncate uppercase tracking-[0.05em]" title={`Rule ${ruleId}`}>
                {ruleId}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div class="text-[13px] leading-[1.55] flex flex-col gap-1.5">{children}</div>
    </li>
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
          <Badge tone={severityTone(severity)} dot>
            {severity}
          </Badge>
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
              <span class="flex-shrink-0 font-mono text-[11px] text-ink-subtle">L{entry.line}</span>
            ) : null}
            {entry.diffStatus ? (
              <Badge tone={statusTone(entry.diffStatus)} class="flex-shrink-0">
                {entry.diffLabel ?? entry.diffStatus}
              </Badge>
            ) : null}
          </li>
        ))}
      </ul>
    </li>
  );
}

export function FindingRow({ label, value }: { label: string; value: ComponentChildren }) {
  return (
    <div class="grid grid-cols-[108px_minmax(0,1fr)] gap-2.5 items-baseline">
      <span class="text-ink-subtle font-mono text-[11px] uppercase tracking-[0.1em]">{label}</span>
      <span class="min-w-0">{value}</span>
    </div>
  );
}
