import { compareSeverity, groupFindingsByRule } from "../../lib/findings";
import { RELEASE_PROCESS_FINDING_FILE } from "../../../server/lib/release-fingerprint";
import { FindingCard, FindingRow, GroupedFindingCard } from "../../components/FindingCard";
import { EmptyLine, Muted, SectionLabel } from "../../components/Typography";
import type { FindingWithDiffStatus } from "./types";

const DEFAULT_DESCRIPTION =
  "Changed-file signals are pinned to their line in the diff above; the rest stay here as " +
  "package context.";
// Said only when an assistant finding is on the page: explaining a badge the
// reader cannot see is noise.
const ASSISTANT_NOTE =
  " Assistant-labeled signals are advisory additions from the AI reviewer and never replace " +
  "deterministic rules.";

export function RiskSignalsSection({
  findings,
  onSelect,
  description = DEFAULT_DESCRIPTION,
  id,
}: {
  id?: string;
  findings: FindingWithDiffStatus[];
  onSelect?: (file: string) => void;
  description?: string;
}) {
  const changedFindings = sortFindingItemsBySeverity(findings.filter((item) => item.releaseDelta));
  const contextualFindings = sortFindingItemsBySeverity(
    findings.filter((item) => !item.releaseDelta),
  );
  const counts = [
    changedFindings.length ? `${changedFindings.length} changed-file` : null,
    contextualFindings.length ? `${contextualFindings.length} package context` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const hasAssistantFindings = findings.some((item) => item.finding.source === "ai");

  return (
    <section id={id} tabIndex={id ? -1 : undefined} class="flex flex-col gap-3">
      <SectionLabel as="h2" aside={counts || undefined}>
        Risk signals
      </SectionLabel>
      <Muted class="m-0 text-[13px] leading-[1.55] max-w-[760px]">
        {description}
        {hasAssistantFindings ? ASSISTANT_NOTE : null}
      </Muted>

      {changedFindings.length ? (
        <FindingGrid findings={changedFindings} onSelect={onSelect} />
      ) : (
        <EmptyLine>No deterministic risk signals point at this release delta.</EmptyLine>
      )}

      {contextualFindings.length ? (
        <div>
          <SectionLabel as="h3">Package context</SectionLabel>
          <div class="pt-3">
            <FindingGrid findings={contextualFindings} onSelect={onSelect} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function FindingGrid({
  findings,
  onSelect,
}: {
  findings: FindingWithDiffStatus[];
  onSelect?: (file: string) => void;
}) {
  // The section split already says whether a signal is on a changed file or is
  // package context, so a card names its file's diff status only where that
  // split would mislead: a release-scoped signal whose file did not change, or
  // a changed signal that only grew a capability the file already had (release
  // risk scores it one step lower).
  const statusNote = (item: FindingWithDiffStatus) =>
    item.releaseDelta && item.diffStatus === "unchanged"
      ? "existing"
      : item.releaseDeltaKind === "expanded"
        ? "expanded"
        : null;
  // release.* findings carry the synthetic "<release-process>" label — there is
  // no such file in the artifact, so the label must not become an
  // open-in-the-diff button.
  const selectFile = (file: string) =>
    onSelect && file !== RELEASE_PROCESS_FINDING_FILE ? () => onSelect(file) : undefined;
  const groups = groupFindingsByRule(
    findings.map((item) => ({
      ruleId: item.finding.ruleId,
      severity: item.finding.severity,
      evidence: item.finding.evidence,
      reason: item.finding.reason,
      item,
    })),
  );
  return (
    <ul class="list-none p-0 m-0 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {groups.map(({ key, items }) => {
        if (items.length === 1) {
          const { finding } = items[0].item;
          // AI findings carry a model-authored file path that may not resolve to
          // a diff entry (prefixed, truncated, or hallucinated), so they are not
          // wired to open the diff workbench — clicking would dead-end on an
          // empty state. Deterministic findings always cite a canonical path.
          const canOpen = onSelect && finding.source !== "ai";
          return (
            <FindingCard
              key={finding.id}
              severity={finding.severity}
              file={finding.file}
              line={finding.line}
              diffStatus={statusNote(items[0].item)}
              ruleId={finding.ruleId}
              source={finding.source}
              onSelect={canOpen ? selectFile(finding.file) : undefined}
            >
              <FindingRow label="evidence" value={finding.evidence} />
              <FindingRow label="reason" value={finding.reason} />
            </FindingCard>
          );
        }
        const first = items[0].item.finding;
        return (
          <GroupedFindingCard
            key={key}
            severity={first.severity}
            ruleId={first.ruleId}
            files={items.map(({ item }) => ({
              file: item.finding.file,
              line: item.finding.line,
              diffStatus: statusNote(item),
              onSelect: selectFile(item.finding.file),
            }))}
          >
            <FindingRow label="evidence" value={first.evidence} />
            <FindingRow label="reason" value={first.reason} />
          </GroupedFindingCard>
        );
      })}
    </ul>
  );
}

function sortFindingItemsBySeverity(items: FindingWithDiffStatus[]): FindingWithDiffStatus[] {
  return items.slice().sort((a, b) => {
    const severity = compareSeverity(a.finding.severity, b.finding.severity);
    return severity || a.finding.file.localeCompare(b.finding.file);
  });
}
