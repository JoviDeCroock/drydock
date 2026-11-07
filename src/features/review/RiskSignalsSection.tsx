import { compareSeverity, groupFindingsByRule } from "../../lib/findings";
import { pluralize } from "../../lib/format";
import { RELEASE_PROCESS_FINDING_FILE } from "../../../server/lib/release-fingerprint";
import {
  FindingCard,
  FindingDetails,
  FindingIndexRow,
  GroupedFindingCard,
} from "../../components/FindingCard";
import { cn } from "../../components/cn";
import { Muted, SectionLabel } from "../../components/Typography";
import { groupIndexRows, isShownInDiff, riskSignalCounts } from "./risk-index";
import type { FindingWithDiffStatus } from "./types";

// Said only when no signal belongs to the release; a pre-existing signal the
// diff shows is counted as pre-existing, so the two never contradict.
const DEFAULT_CHANGED_EMPTY = "No deterministic risk signals point at this release delta.";
// Said only when an assistant finding is on the page: explaining a badge the
// reader cannot see is noise.
const ASSISTANT_NOTE =
  "Assistant-labeled signals are advisory additions from the AI reviewer and never replace " +
  "deterministic rules.";

const signals = (count: number, noun = "signal") => `${count} ${pluralize(noun, count)}`;

/**
 * Every finding, said once. A finding the diff shows in full (its line, or the
 * banner above a file with no line) gets a one-line pointer here instead of a
 * second copy of its reason; only what the diff cannot show gets a card.
 */
export function RiskSignalsSection({
  findings,
  onSelect,
  changedEmpty = DEFAULT_CHANGED_EMPTY,
  diffPaths,
  releaseListedElsewhere = false,
  id,
}: {
  id?: string;
  findings: FindingWithDiffStatus[];
  onSelect?: (file: string) => void;
  /** Said when no signal belongs to the release; null says nothing. */
  changedEmpty?: string | null;
  /** The comparison on screen, for a page whose baseline can change or is loading. */
  diffPaths?: ReadonlySet<string>;
  /**
   * The page's review notes already list release findings, so one the diff
   * shows is counted here rather than given a row.
   */
  releaseListedElsewhere?: boolean;
}) {
  const shown = (item: FindingWithDiffStatus) => isShownInDiff(item, diffPaths);
  const listedElsewhere = (item: FindingWithDiffStatus) =>
    releaseListedElsewhere && item.releaseDelta && shown(item);
  const rows = sortFindingItemsBySeverity(
    findings.filter((item) => shown(item) && !listedElsewhere(item)),
  );
  const elsewhereCount = findings.filter(listedElsewhere).length;
  const releaseCards = sortFindingItemsBySeverity(
    findings.filter((item) => item.releaseDelta && !shown(item)),
  );
  const contextCards = sortFindingItemsBySeverity(
    findings.filter((item) => !item.releaseDelta && !shown(item)),
  );
  const releaseTotal = findings.filter((item) => item.releaseDelta).length;
  const counts = riskSignalCounts(findings);

  const rowsPreExisting = rows.every((item) => !item.releaseDelta);
  const description = [
    !releaseTotal ? changedEmpty : null,
    elsewhereCount
      ? `${signals(elsewhereCount, "release signal")} ${elsewhereCount === 1 ? "is" : "are"} ` +
        "shown in the diff above and listed in the review notes."
      : null,
    rows.length
      ? `${signals(rows.length, rowsPreExisting ? "pre-existing signal" : "signal")} ` +
        `${rows.length === 1 ? "is" : "are"} shown in the diff above.`
      : null,
    releaseCards.length && (rows.length || elsewhereCount)
      ? `${signals(releaseCards.length)} from this release ${releaseCards.length === 1 ? "has" : "have"} ` +
        "no place in the diff."
      : null,
    findings.some((item) => item.finding.source === "ai") ? ASSISTANT_NOTE : null,
  ]
    .filter(Boolean)
    .join(" ");

  // release.* findings carry the synthetic "<release-process>" label — there is
  // no such file in the artifact, so the label must not become an
  // open-in-the-diff button.
  const selectFile = (file: string) =>
    onSelect && file !== RELEASE_PROCESS_FINDING_FILE ? () => onSelect(file) : undefined;

  return (
    <section id={id} tabIndex={id ? -1 : undefined} class="flex flex-col gap-3">
      <SectionLabel as="h2" aside={counts || undefined}>
        Risk signals
      </SectionLabel>
      {description ? (
        <Muted class="m-0 text-[13px] leading-[1.55] max-w-[760px]">{description}</Muted>
      ) : null}

      {rows.length ? (
        <ul class="list-none m-0 px-4 py-0.5 bg-surface border border-border rounded-lg flex flex-col divide-y divide-border">
          {groupIndexRows(rows, [...releaseCards, ...contextCards]).map((group) => (
            <FindingIndexRow
              key={group.key}
              severity={group.severity}
              ruleId={group.ruleId}
              note={group.note}
              reason={group.reason}
              locations={group.locations.map(({ item, note }) => ({
                file: item.finding.file,
                line: item.finding.line,
                note,
                onSelect: selectFile(item.finding.file),
              }))}
            />
          ))}
        </ul>
      ) : null}

      {releaseCards.length ? <FindingGrid findings={releaseCards} selectFile={selectFile} /> : null}

      {contextCards.length ? (
        <div>
          <SectionLabel as="h3">Package context</SectionLabel>
          <div class="pt-3">
            <FindingGrid findings={contextCards} selectFile={selectFile} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function FindingGrid({
  findings,
  selectFile,
}: {
  findings: FindingWithDiffStatus[];
  selectFile: (file: string) => (() => void) | undefined;
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
    // A lone card takes the column: a third of it squeezed a digest into five
    // wrapped lines.
    <ul
      class={cn("list-none p-0 m-0 grid grid-cols-1 gap-3", groups.length > 1 && "md:grid-cols-2")}
    >
      {groups.map(({ key, items }) => {
        if (items.length === 1) {
          const { finding } = items[0].item;
          // AI findings carry a model-authored file path that may not resolve to
          // a diff entry (prefixed, truncated, or hallucinated), so they are not
          // wired to open the diff workbench — clicking would dead-end on an
          // empty state. Deterministic findings always cite a canonical path.
          return (
            <FindingCard
              key={finding.id}
              severity={finding.severity}
              file={finding.file}
              line={finding.line}
              diffStatus={statusNote(items[0].item)}
              ruleId={finding.ruleId}
              source={finding.source}
              onSelect={finding.source !== "ai" ? selectFile(finding.file) : undefined}
            >
              <FindingDetails reason={finding.reason} evidence={finding.evidence} />
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
            <FindingDetails reason={first.reason} evidence={first.evidence} />
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
