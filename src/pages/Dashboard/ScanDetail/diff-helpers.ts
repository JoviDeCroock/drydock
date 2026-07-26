import {
  annotateFindingsWithDiffStatus as annotateReviewFindingsWithDiffStatus,
  normalizeFindingDiffStatus,
  type DiffEntry,
  type FileRecord,
  type FindingDiffAnnotation,
} from "../../../../server/lib/review";
import type { FindingWithDiffStatus } from "../../../features/review/types";
import type { PersistedScanDetail } from "../../../models/scan";
import type { PersistedFinding } from "./types";

// Scan-workbench-specific diff helpers. The pieces the anonymous /diff surface
// also needs (finding counts, entry filtering, the shared finding shape) live in
// `src/features/review/`; what stays here is tied to the persisted scan model.

export type DiffWorkbenchState =
  | { kind: "empty"; message: string }
  | { kind: "processing"; title: string; detail: string }
  | { kind: "diff" };

export function hasNoLoadableBodyFlags(flags: readonly unknown[]): boolean {
  return flags.includes("binary") || flags.includes("content-skipped");
}

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
  stagedHasNoLoadableBody: boolean;
  hasPreviousMeta: boolean;
  hasPreviousContent: boolean;
  previousHasNoLoadableBody: boolean;
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
      detail: "fetching the previous version in the sandbox",
    };
  }

  // Comparison resolved; the previous file body is still loading.
  if (
    needsPrevious &&
    input.hasPreviousMeta &&
    !input.previousHasNoLoadableBody &&
    !input.hasPreviousContent
  ) {
    return {
      kind: "processing",
      title: "Loading file diff",
      detail: "fetching file contents",
    };
  }

  if (
    needsStaged &&
    input.hasStagedMeta &&
    !input.stagedHasNoLoadableBody &&
    !input.hasStagedContent
  ) {
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
