import type { Finding, PackageJsonDiff } from "../review";
import { firstJsonPropertyLine, tag } from "./helpers";

// Dependency-change rules derived from the package.json diff: newly added
// optional dependencies and specs that resolve code outside normal semver
// ranges. Composed by ecosystem adapters rather than the file-scanning pass, so
// these are exposed through the index as `packageJsonDiffFindings`.
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
    if (!kind) continue;
    findings.push(
      tag("dependencyUnusualSpec", {
        severity: "high",
        file: "package.json",
        line: firstJsonPropertyLine(stagedPackageJsonText, entry.key, entry.staged),
        evidence: `${entry.key}: ${entry.staged}`,
        reason: `${kind} dependency specs resolve code outside normal npm semver ranges and can introduce unreviewed install-time behavior`,
      }),
    );
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
