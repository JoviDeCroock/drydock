import type { ComponentChildren } from "preact";
import { Badge, severityTone, statusTone } from "./Badge";
import { cn } from "./cn";

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
          {onSelect ? (
            <button
              type="button"
              onClick={onSelect}
              title={`Open ${file} in the diff`}
              class="font-mono text-[13px] text-ink-muted hover:text-accent truncate text-left [direction:rtl] bg-transparent border-0 p-0 m-0 cursor-pointer transition-colors duration-150 ease-out"
            >
              <bdi>{file}</bdi>
            </button>
          ) : (
            <code
              class="text-[13px] text-ink-muted truncate text-left [direction:rtl]"
              title={file}
            >
              <bdi>{file}</bdi>
            </code>
          )}
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

export function FindingRow({ label, value }: { label: string; value: ComponentChildren }) {
  return (
    <div class="grid grid-cols-[108px_minmax(0,1fr)] gap-2.5 items-baseline">
      <span class="text-ink-subtle font-mono text-[11px] uppercase tracking-[0.1em]">{label}</span>
      <span class="min-w-0">{value}</span>
    </div>
  );
}
