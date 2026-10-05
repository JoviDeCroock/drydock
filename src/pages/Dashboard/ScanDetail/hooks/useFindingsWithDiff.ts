import { useComputed, type ReadonlySignal } from "@preact/signals";
import type { DiffEntry, FileRecord } from "../../../../../server/lib/review";
import type { PersistedScanDetail, ScanCompareResponse } from "../../../../models/scan";
import { annotatePersistedFindings } from "../diff-helpers";
import type { FindingWithDiffStatus } from "../../../../features/review/types";

// Annotates persisted findings with their diff status against the active
// comparison, preferring persisted annotations on the default comparison.
export function useFindingsWithDiff(
  detail: ReadonlySignal<PersistedScanDetail | null>,
  compare: ReadonlySignal<ScanCompareResponse | null>,
  stagedFiles: ReadonlySignal<FileRecord[]>,
  diffEntries: ReadonlySignal<DiffEntry[]>,
  isDefault: ReadonlySignal<boolean>,
): ReadonlySignal<FindingWithDiffStatus[]> {
  return useComputed(() =>
    annotatePersistedFindings(
      detail.value?.findings ?? [],
      diffEntries.value,
      isDefault.value,
      compare.value?.files ?? [],
      stagedFiles.value,
      isDefault.value ? undefined : compare.value?.findingAnnotations,
    ),
  );
}
