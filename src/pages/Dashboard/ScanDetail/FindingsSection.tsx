import { compareSeverity } from "../../../lib/findings";
import { pluralize } from "../../../lib/format";
import type { FindingDiffStatus } from "../../../../server/lib/review";
import {
  Badge,
  EmptyLine,
  FindingCard,
  FindingRow,
  Muted,
  SectionLabel,
} from "../../../components";
import type { FindingWithDiffStatus } from "./types";

export function RiskSignalsSection({ findings }: { findings: FindingWithDiffStatus[] }) {
  const changedFindings = sortFindingItemsBySeverity(findings.filter((item) => item.releaseDelta));
  const contextualFindings = sortFindingItemsBySeverity(
    findings.filter((item) => !item.releaseDelta),
  );
  const contextLabel = `${contextualFindings.length} context ${pluralize(
    "signal",
    contextualFindings.length,
  )}`;

  return (
    <section class="flex flex-col gap-3">
      <SectionLabel>Risk signals</SectionLabel>
      <div class="flex flex-wrap items-center gap-2">
        <Badge tone={changedFindings.length ? "medium" : "ok"}>
          {changedFindings.length
            ? `${changedFindings.length} changed-file ${pluralize(
                "signal",
                changedFindings.length,
              )}`
            : "no changed-file signals"}
        </Badge>
        {contextualFindings.length ? <Badge tone="neutral">{contextLabel}</Badge> : null}
      </div>
      <Muted class="m-0 text-[13px] leading-[1.55] max-w-[760px]">
        Deterministic rules scan the full staged artifact; unchanged signals are retained as package
        context and separated from this release's changed files.
      </Muted>

      {changedFindings.length ? (
        <FindingGrid findings={changedFindings} />
      ) : (
        <EmptyLine>No deterministic risk signals point at this release delta.</EmptyLine>
      )}

      {contextualFindings.length ? (
        <details class="group border-y border-border py-3">
          <summary class="cursor-pointer list-none flex flex-wrap items-center justify-between gap-3">
            <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
              Package context
            </span>
            <span class="font-mono text-[11px] text-ink-subtle">
              {contextualFindings.length} {pluralize("signal", contextualFindings.length)}
            </span>
          </summary>
          <div class="pt-3">
            <FindingGrid findings={contextualFindings} />
          </div>
        </details>
      ) : null}
    </section>
  );
}

function FindingGrid({ findings }: { findings: FindingWithDiffStatus[] }) {
  return (
    <ul class="list-none p-0 m-0 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {findings.map(({ finding, diffStatus }) => (
        <FindingCard
          key={finding.id}
          severity={finding.severity}
          file={finding.file}
          line={finding.line}
          diffStatus={diffStatus === "unknown" ? null : diffStatus}
          diffLabel={findingDiffStatusLabel(diffStatus)}
          ruleId={finding.ruleId}
        >
          <FindingRow label="evidence" value={finding.evidence} />
          <FindingRow label="reason" value={finding.reason} />
        </FindingCard>
      ))}
    </ul>
  );
}

function sortFindingItemsBySeverity(items: FindingWithDiffStatus[]): FindingWithDiffStatus[] {
  return items.slice().sort((a, b) => {
    const severity = compareSeverity(a.finding.severity, b.finding.severity);
    return severity || a.finding.file.localeCompare(b.finding.file);
  });
}

function findingDiffStatusLabel(status: FindingDiffStatus): string | null {
  if (status === "unknown") return null;
  if (status === "unchanged") return "existing";
  return status;
}
