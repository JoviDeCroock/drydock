import { sortFindingsBySeverity } from "../../lib/findings";

/**
 * The changed file carrying the most severe finding, or null when no changed
 * file has one. Review surfaces open the workbench here first: the diff is the
 * headline and findings ride the hunk that triggered them, so landing on the
 * first changed file (usually a README) made the reader hunt for the change
 * the verdict is about. Each surface keeps its own fallback for a release with
 * no finding on a changed file.
 */
export function findingFirstPath(
  entries: ReadonlyArray<{ path: string; status: string }>,
  findings: ReadonlyArray<{ file?: string | null; severity?: string }>,
): string | null {
  const changed = new Set(
    entries.filter((entry) => entry.status !== "unchanged").map((entry) => entry.path),
  );
  const onChangedFile = findings.filter((finding) => finding.file && changed.has(finding.file));
  return sortFindingsBySeverity([...onChangedFile])[0]?.file ?? null;
}
