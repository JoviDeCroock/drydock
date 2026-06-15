import {
  annotateFindingsWithDiffStatus as annotateReviewFindingsWithDiffStatus,
  normalizeFindingDiffStatus,
  type DiffEntry,
  type FileRecord,
  type FindingDiffAnnotation,
} from "../../../../server/lib/review";
import { maxSeverity } from "../../../components/diff-annotations";
import type { PersistedScanDetail } from "../../../models/scan";
import type { FindingWithDiffStatus, PersistedFinding } from "./types";

export interface FindingCount {
  count: number;
  maxSeverity: string;
}

// Per-file finding counts (with the highest severity for tone), keyed by the
// finding's file path. FileTree bubbles these up to parent folders. Feeds the
// tree-count surface from the same finding set as the inline diff annotations
// and the risk-signals index, so all three stay in sync.
export function findingCountsByPath(findings: FindingWithDiffStatus[]): Map<string, FindingCount> {
  const counts = new Map<string, FindingCount>();
  for (const { finding } of findings) {
    const existing = counts.get(finding.file);
    if (existing) {
      existing.count += 1;
      existing.maxSeverity =
        maxSeverity(existing.maxSeverity, finding.severity) ?? existing.maxSeverity;
    } else {
      counts.set(finding.file, { count: 1, maxSeverity: finding.severity });
    }
  }
  return counts;
}

const DIFF_STATUS_RANK: Record<DiffEntry["status"], number> = {
  added: 0,
  modified: 1,
  removed: 2,
  unchanged: 3,
};

export type DiffWorkbenchState =
  | { kind: "empty"; message: string }
  | { kind: "processing"; title: string; detail: string }
  | { kind: "diff" };

// Decides what the diff panel should show for the selected file. Extracted so
// the loading/empty/diff guards are testable: the previous version is fetched
// through the sandbox after the file tree already renders, and during that
// window we must show an explicit processing state instead of letting DiffView
// render a one-sided (all added/removed) view of a file that is actually
// modified.
export function selectDiffWorkbenchState(input: {
  hasEntry: boolean;
  entryStatus: DiffEntry["status"] | null;
  hasStagedMeta: boolean;
  hasStagedContent: boolean;
  stagedIsBinary: boolean;
  hasPreviousMeta: boolean;
  hasPreviousContent: boolean;
  previousIsBinary: boolean;
  compareReady: boolean;
  compareLoading: boolean;
}): DiffWorkbenchState {
  if (!input.hasEntry) {
    return { kind: "empty", message: "Select a file from the tree to diff." };
  }

  const needsPrevious = input.entryStatus !== "added";
  const needsStaged = input.entryStatus !== "removed";

  // Previous version still being fetched via the sandbox. Keyed off
  // compareLoading too (not just compareReady) so a stale cache entry from a
  // prior version can't flash a wrong diff while the new fetch is in flight.
  if (
    needsPrevious &&
    input.entryStatus !== "unchanged" &&
    (input.compareLoading || !input.compareReady)
  ) {
    return {
      kind: "processing",
      title: "Loading comparison",
      detail: "fetching previous version via sandbox · this can take a minute",
    };
  }

  // Comparison resolved; the previous file body is still loading.
  if (
    needsPrevious &&
    input.hasPreviousMeta &&
    !input.previousIsBinary &&
    !input.hasPreviousContent
  ) {
    return {
      kind: "processing",
      title: "Loading file diff",
      detail: "fetching file contents",
    };
  }

  if (needsStaged && input.hasStagedMeta && !input.stagedIsBinary && !input.hasStagedContent) {
    return {
      kind: "processing",
      title: "Loading file diff",
      detail: "fetching file contents",
    };
  }

  if (!input.hasStagedMeta && !input.hasPreviousContent && !input.hasPreviousMeta) {
    return { kind: "empty", message: "No file content available." };
  }

  return { kind: "diff" };
}

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
