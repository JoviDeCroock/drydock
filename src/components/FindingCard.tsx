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
  children,
  class: className,
}: {
  severity: string;
  file: string;
  line?: number | null;
  diffStatus?: string | null;
  diffLabel?: string | null;
  ruleId?: string | null;
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
      <div class="flex items-center gap-2.5 min-w-0">
        <Badge tone={severityTone(severity)} dot>
          {severity}
        </Badge>
        <code class="text-[13px] text-ink-muted truncate">{file}</code>
        {line ? (
          <code class="text-[11px] text-ink-subtle font-mono flex-shrink-0">L{line}</code>
        ) : null}
        {diffStatus ? (
          <Badge tone={statusTone(diffStatus)} class="flex-shrink-0">
            {diffLabel ?? diffStatus}
          </Badge>
        ) : null}
        {ruleId ? (
          <code
            class="ml-auto text-[11px] text-ink-subtle font-mono uppercase tracking-[0.05em] flex-shrink-0"
            title={`Rule ${ruleId}`}
          >
            {ruleId}
          </code>
        ) : null}
      </div>
      <div class="text-[13px] leading-[1.55] flex flex-col gap-1.5">{children}</div>
    </li>
  );
}

export function FindingRow({ label, value }: { label: string; value: ComponentChildren }) {
  return (
    <div class="grid grid-cols-[88px_minmax(0,1fr)] gap-2.5 items-baseline">
      <span class="text-ink-subtle font-mono text-[10px] uppercase tracking-[0.1em]">{label}</span>
      <span class="min-w-0">{value}</span>
    </div>
  );
}
