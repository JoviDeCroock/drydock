import type { Finding, PackageJsonDiff } from "../review";
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
    if (!entry.staged) continue;
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
    if (entry.status === "added" && entry.section !== "optionalDependencies") {
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
    if (entry.status === "modified") {
      const previousMajor = specFloorMajor(entry.previous);
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
            evidence: `${entry.key}: ${entry.previous} -> ${entry.staged}`,
            reason:
              "the dependency spec now resolves to a different major version than the previously reviewed release pinned, so consumers pull code outside the range the prior version was reviewed against; review the dependency's own release diff",
          }),
        );
      }
    }
  }
  return findings;
}

function unusualDependencySpecKind(spec: string): string | null {
  const normalized = spec.trim().toLowerCase();
  if (/^(?:github|gitlab|bitbucket):/.test(normalized)) return "git-hosted";
  if (/^(?:git\+ssh|git\+https|git\+http|git|ssh):/.test(normalized)) return "git";
  if (/^https?:/.test(normalized))
    return normalized.endsWith(".tgz") ? "remote tarball" : "remote URL";
  if (normalized.startsWith("file:")) return "local file";
  if (normalized.startsWith("npm:")) return "npm alias";
  return null;
}

// The major version of the lowest release a plain registry semver spec can
// resolve to: `^1.2.3`, `~1.2`, `>=1.0.0 <2`, `1.x`, and `v1` all floor at
// major 1. Returns undefined for specs with no leading version anchor
// (dist-tags like `latest`, wildcard `*`, bare `>` ranges, `||` unions that
// start unanchored) so ambiguous ranges never produce a false major-bump.
function specFloorMajor(spec: string | undefined): number | undefined {
  if (!spec) return undefined;
  const match = spec.trim().match(/^(?:[~^=]|>=)?\s*v?(\d+)(?:$|[.\s-])/);
  if (!match) return undefined;
  return Number.parseInt(match[1], 10);
}
