import { useComputed, type ReadonlySignal } from "@preact/signals";
import type { DiffEntry } from "../../../server/lib/review";
import { findDiffEntry, findingsForPath } from "./diff-entries";
import type { FindingWithDiffStatus, ReviewFinding } from "./types";

/**
 * The entry and findings for the path open in the workbench, shared by every
 * review surface that owns its selection in a component (the public report's
 * model derives the same pair with `findDiffEntry`/`findingsForPath`).
 */
export function useSelectedDiffFile(
  entries: ReadonlySignal<DiffEntry[]>,
  selectedPath: ReadonlySignal<string | null>,
  findings: ReadonlySignal<FindingWithDiffStatus[]>,
): { entry: ReadonlySignal<DiffEntry | null>; findings: ReadonlySignal<ReviewFinding[]> } {
  const entry = useComputed(() => findDiffEntry(entries.value, selectedPath.value));
  const selectedFindings = useComputed(() => findingsForPath(findings.value, selectedPath.value));
  return { entry, findings: selectedFindings };
}
