/**
 * Deterministic findings rendered inside the diff.
 *
 * Findings pinned to a staged line render as annotation rows directly under
 * that line; findings whose line is missing from a truncated sample fall back
 * to a banner above the diff, so a clipped sample can never hide a signal.
 */
import { Badge, severityTone } from "./Badge";
import {
  annotationLabel,
  severityGroup,
  type DiffFinding,
  type SeverityGroup,
} from "./diff-annotations";
import { Muted } from "./Typography";
import { cn } from "./cn";

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
export function AnnotationRows({
  findings,
  colSpan,
  scrollTarget = false,
}: {
  findings: DiffFinding[];
  colSpan: number;
  scrollTarget?: boolean;
}) {
  return (
    <>
      {findings.map((finding) => (
        <tr key={finding.id} data-diff-scroll-target={scrollTarget ? "true" : undefined}>
          <td colSpan={colSpan} class="p-0">
            <FindingAnnotationBody finding={finding} />
          </td>
        </tr>
      ))}
    </>
  );
}

// Findings that can't be pinned (no line, or a line past a truncated sample),
// shown between the header strip and the scroll region so they're never hidden.
export function AnnotationBanner({ findings }: { findings: DiffFinding[] }) {
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
export function DiffMessage({ children, findings }: { children: string; findings: DiffFinding[] }) {
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
