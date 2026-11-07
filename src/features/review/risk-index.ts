import { RELEASE_PROCESS_FINDING_FILE } from "../../../server/lib/release-fingerprint";
import { pluralize } from "../../lib/format";
import type { FindingWithDiffStatus } from "./types";

/**
 * Whether the diff states this finding in full. The workbench annotates every
 * finding on the open file — on its line, or in the banner above the diff when
 * it has no line (a digest mismatch, a binary) — and the tree counts it, so a
 * finding on an added or modified file is already said there. Unchanged files
 * sit behind the changed-files filter, release-process signals cite no file,
 * and assistant findings name model-authored paths that may not resolve, so
 * none of those count. `diffPaths`, when given, also requires the file to be
 * in the comparison on screen (a page whose baseline can change or is still
 * loading).
 */
export function isShownInDiff(
  { diffStatus, finding }: FindingWithDiffStatus,
  diffPaths?: ReadonlySet<string>,
): boolean {
  return (
    (diffStatus === "added" || diffStatus === "modified") &&
    finding.source !== "ai" &&
    finding.file !== RELEASE_PROCESS_FINDING_FILE &&
    (!diffPaths || diffPaths.has(finding.file))
  );
}

/**
 * The risk index for a page whose review notes already list every release
 * finding: a release finding the diff shows is stated there and in the notes,
 * so the index leaves it out. Package context the diff shows stays, as a
 * one-line pointer (the notes do not list context).
 */
export function unpinnedFindings(
  findings: FindingWithDiffStatus[],
  diffPaths: ReadonlySet<string>,
): FindingWithDiffStatus[] {
  return findings.filter((item) => !(item.releaseDelta && isShownInDiff(item, diffPaths)));
}

/** The status a one-line index entry adds beyond the section split. */
function indexNote(item: FindingWithDiffStatus): string | null {
  if (!item.releaseDelta) return "pre-existing";
  return item.releaseDeltaKind === "expanded" ? "expanded" : null;
}

interface RiskIndexLocation {
  item: FindingWithDiffStatus;
  /** Null when every location in the group shares the group's note. */
  note: string | null;
}

export interface RiskIndexGroup {
  key: string;
  severity: string;
  ruleId: string | null;
  /** Null when a card in the same section already states this rule's reason. */
  reason: string | null;
  note: string | null;
  locations: RiskIndexLocation[];
}

/**
 * One index entry per rule, severity, and reason, so a rule that fired in four
 * files states its reason once above four location actions. The diff shows
 * one file at a time, so the reason stays in the index (the reachable copy for
 * every file not open) unless a card in the section already says it word for
 * word. Order follows the first location of each group.
 */
export function groupIndexRows(
  rows: FindingWithDiffStatus[],
  cards: FindingWithDiffStatus[] = [],
): RiskIndexGroup[] {
  const reasonKey = ({ finding }: FindingWithDiffStatus) =>
    `${finding.ruleId ?? ""}\u0000${finding.reason}`;
  const cardReasons = new Set(cards.map(reasonKey));
  const groups = new Map<string, FindingWithDiffStatus[]>();
  rows.forEach((item, index) => {
    const { finding } = item;
    const key = finding.ruleId
      ? ["rule", finding.ruleId, finding.severity, finding.reason].join("\u0000")
      : `ungrouped\u0000${index}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  });
  return [...groups].map(([key, items]) => {
    const { finding } = items[0];
    const notes = new Set(items.map(indexNote));
    const shared = notes.size === 1 ? indexNote(items[0]) : null;
    return {
      key,
      severity: finding.severity,
      ruleId: finding.ruleId ?? null,
      reason: cardReasons.has(reasonKey(items[0])) ? null : finding.reason,
      note: shared,
      locations: items.map((item) => ({ item, note: notes.size === 1 ? null : indexNote(item) })),
    };
  });
}

/**
 * The risk-signals header total. A release signal need not sit on a changed
 * file (a directory entry, the release process), so it names relevance, not
 * placement; the section description says where each one is shown.
 */
export function riskSignalCounts(findings: FindingWithDiffStatus[]): string {
  const release = findings.filter((item) => item.releaseDelta).length;
  const context = findings.length - release;
  return [
    release ? `${release} ${pluralize("release signal", release)}` : null,
    context ? `${context} package context` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
