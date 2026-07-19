import type { Finding, PackageJsonDiff } from "../review";
import { specFloorMajor, unusualDependencySpecKind } from "../dependency-specs";
import { firstJsonPropertyLine, tag } from "./helpers";

// Dependency-change rules derived from the package.json diff: newly added
// optional dependencies, specs that resolve code outside normal semver ranges,
// newly added runtime dependencies, and specs that cross a major version
// boundary. Composed by ecosystem adapters rather than the file-scanning pass,
// so these are exposed through the index as `packageJsonDiffFindings`.
export function dependencyDiffFindings(
  packageJsonDiff: PackageJsonDiff,
  stagedPackageJsonText?: string | null,
): Finding[] {
  const findings: Finding[] = [];
  // With no baseline manifest (a first-ever publish, or a baseline fetch that
  // degraded to null) every dependency diffs as "added"; that is not the
  // added-dependency vector, and flagging the whole list would floor every
  // first release at medium risk. The delta rules below stay silent without a
  // previous release to diff against; optional-added and unusual-spec still
  // fire because they describe the staged manifest itself, not the delta.
  const hasBaseline = packageJsonDiff.previousVersion !== null;
  // A key removed from one section and added to another is a section move,
  // not new third-party code — the dependency already shipped to consumers.
  // Track removed specs so moves are compared as modifications instead.
  const removedSpecs = new Map<string, string | undefined>();
  for (const entry of packageJsonDiff.dependencies) {
    if (entry.status === "removed") removedSpecs.set(entry.key, entry.previous);
  }
  for (const entry of packageJsonDiff.dependencies) {
    if (entry.status !== "added" && entry.status !== "modified") continue;
    if (entry.section === "optionalDependencies" && entry.status === "added") {
      findings.push(
        tag("dependencyOptionalAdded", {
          severity: "high",
          file: "package.json",
          line: firstJsonPropertyLine(stagedPackageJsonText, entry.key, entry.staged),
          evidence: `${entry.key}: ${entry.staged}`,
          reason:
            "optional dependencies can execute install lifecycle hooks while failing softly on unsupported platforms, so newly added optional dependencies require manual review",
        }),
      );
    }
    // undefined means the diff carries no staged spec at all; an empty string
    // is a real spec (npm treats "" like "*") and must keep flowing through
    // the delta rules below.
    if (entry.staged === undefined) continue;
    const kind = unusualDependencySpecKind(entry.staged);
    if (kind) {
      findings.push(
        tag("dependencyUnusualSpec", {
          severity: "high",
          file: "package.json",
          line: firstJsonPropertyLine(stagedPackageJsonText, entry.key, entry.staged),
          evidence: `${entry.key}: ${entry.staged}`,
          reason: `${kind} dependency specs resolve code outside normal npm semver ranges and can introduce unreviewed install-time behavior`,
        }),
      );
      // The unusual-spec finding already flags this exact entry at high; the
      // generic added/major-bump rules below would restate it at lower severity.
      continue;
    }
    const movedAcrossSections = entry.status === "added" && removedSpecs.has(entry.key);
    if (
      entry.status === "added" &&
      entry.section !== "optionalDependencies" &&
      hasBaseline &&
      !movedAcrossSections
    ) {
      findings.push(
        tag("dependencyAdded", {
          severity: "medium",
          file: "package.json",
          line: firstJsonPropertyLine(stagedPackageJsonText, entry.key, entry.staged),
          evidence: `${entry.key}: ${entry.staged}`,
          reason:
            "a newly added dependency ships third-party code this scan does not inspect into every consumer install — the event-stream/flatmap-stream and node-ipc/peacenotwar vector — so review the new dependency's own contents before approving",
        }),
      );
    }
    const previousSpec = entry.status === "modified" ? entry.previous : removedSpecs.get(entry.key);
    if (entry.status === "modified" || movedAcrossSections) {
      const previousMajor = specFloorMajor(previousSpec);
      const stagedMajor = specFloorMajor(entry.staged);
      if (
        previousMajor !== undefined &&
        stagedMajor !== undefined &&
        previousMajor !== stagedMajor
      ) {
        findings.push(
          tag("dependencyMajorBump", {
            severity: "low",
            file: "package.json",
            line: firstJsonPropertyLine(stagedPackageJsonText, entry.key, entry.staged),
            evidence: `${entry.key}: ${previousSpec} -> ${entry.staged}`,
            reason:
              "the dependency spec now resolves to a different major version than the previously reviewed release pinned, so consumers pull code outside the range the prior version was reviewed against; review the dependency's own release diff",
          }),
        );
      }
    }
  }
  return findings;
}
