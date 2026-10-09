import { RELEASE_PROCESS_FINDING_FILE } from "../../../server/lib/release-fingerprint";
import type { FindingWithDiffStatus } from "./types";

/**
 * Whether the diff pins a finding to a changed line, where its annotation
 * already states it. Assistant findings, release-process signals, whole-file
 * signals (a binary has no line), and files the comparison does not contain
 * have no line to sit on, so they are not pinned.
 */
function isPinnedInDiff(
  { releaseDelta, finding }: FindingWithDiffStatus,
  diffPaths: ReadonlySet<string>,
): boolean {
  return (
    releaseDelta &&
    finding.source !== "ai" &&
    finding.file !== RELEASE_PROCESS_FINDING_FILE &&
    finding.line != null &&
    diffPaths.has(finding.file)
  );
}

/**
 * The risk index for a page whose review notes already list every release
 * finding: only what the diff cannot pin, so a pinned finding is not stated a
 * third time as a card. A page without review notes (the public report, /diff)
 * keeps the full index.
 */
export function unpinnedFindings(
  findings: FindingWithDiffStatus[],
  diffPaths: ReadonlySet<string>,
): FindingWithDiffStatus[] {
  return findings.filter((item) => !isPinnedInDiff(item, diffPaths));
}
