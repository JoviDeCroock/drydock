import {
  annotateFindingsWithDiffStatus as annotateReviewFindingsWithDiffStatus,
  normalizeFindingDiffStatus,
  type DiffEntry,
  type FileRecord,
  type FindingDiffAnnotation,
} from "../../../../server/lib/review";
import type { PersistedScanDetail } from "../../../models/scan";
import type { FindingWithDiffStatus, PersistedFinding } from "./types";

const DIFF_STATUS_RANK: Record<DiffEntry["status"], number> = {
  added: 0,
  modified: 1,
  removed: 2,
  unchanged: 3,
};

export function filterDiffEntries(
  entries: DiffEntry[],
  rawFilter: string,
  changedOnly: boolean,
): DiffEntry[] {
  const filter = rawFilter.trim().toLowerCase();
  return entries
    .filter((entry) => {
      if (changedOnly && entry.status === "unchanged") return false;
      if (!filter) return true;
      return entry.path.toLowerCase().includes(filter);
    })
    .sort((a, b) => {
      const status = DIFF_STATUS_RANK[a.status] - DIFF_STATUS_RANK[b.status];
      return status || a.path.localeCompare(b.path);
    });
}

export function scanFilesToFileRecords(files: PersistedScanDetail["files"]): FileRecord[] {
  return files.map((file) => ({
    path: file.path,
    size: file.size ?? 0,
    sha256: file.sha256 ?? "",
    textSample: file.textSample ?? undefined,
    flags: Array.isArray(file.flagsJson) ? (file.flagsJson as string[]) : [],
  }));
}

export function annotatePersistedFindings(
  findings: PersistedFinding[],
  diff: DiffEntry[],
  preferPersistedStatus: boolean,
  previousFiles: FileRecord[],
  stagedFiles: FileRecord[],
  compareAnnotations?: Array<{ id: string } & FindingDiffAnnotation>,
): FindingWithDiffStatus[] {
  const persistedAnnotations = compareAnnotations
    ? new Map(
        compareAnnotations.map((annotation) => [
          annotation.id,
          {
            diffStatus: normalizeFindingDiffStatus(annotation.diffStatus),
            releaseDelta: Boolean(annotation.releaseDelta),
          },
        ]),
      )
    : preferPersistedStatus
      ? new Map(
          findings.flatMap((finding): Array<[string, FindingDiffAnnotation]> => {
            if (!finding.diffStatus) return [];
            return [
              [
                finding.id,
                {
                  diffStatus: normalizeFindingDiffStatus(finding.diffStatus),
                  releaseDelta: Boolean(finding.releaseDelta),
                },
              ],
            ];
          }),
        )
      : undefined;
  return annotateReviewFindingsWithDiffStatus(findings, diff, {
    persistedAnnotations,
    previousFiles,
    stagedFiles,
  }).map((finding) => {
    return {
      finding,
      diffStatus: finding.diffStatus,
      releaseDelta: finding.releaseDelta,
    };
  });
}
