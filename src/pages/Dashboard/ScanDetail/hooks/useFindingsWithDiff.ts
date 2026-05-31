import { useComputed, type ReadonlySignal } from "@preact/signals";
import type { DiffEntry } from "../../../../../server/lib/review";
import type { PersistedScanDetail, ScanCompareResponse } from "../../../../models/scan";
import { annotatePersistedFindings, scanFilesToFileRecords } from "../diff-helpers";
import type { FindingWithDiffStatus } from "../types";

// Annotates persisted findings with their diff status against the active
// comparison, preferring persisted annotations on the default comparison.
export function useFindingsWithDiff(
  detail: ReadonlySignal<PersistedScanDetail | null>,
  compare: ReadonlySignal<ScanCompareResponse | null>,
  diffEntries: ReadonlySignal<DiffEntry[]>,
  isDefault: ReadonlySignal<boolean>,
): ReadonlySignal<FindingWithDiffStatus[]> {
  return useComputed(() =>
    annotatePersistedFindings(
      detail.value?.findings ?? [],
      diffEntries.value,
      isDefault.value,
      compare.value?.files ?? [],
      detail.value ? scanFilesToFileRecords(detail.value.files) : [],
      isDefault.value ? undefined : compare.value?.findingAnnotations,
    ),
  );
}
