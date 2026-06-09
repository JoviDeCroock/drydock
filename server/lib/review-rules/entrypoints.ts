import type { Finding, PackageJsonDiff } from "../review";
import { firstJsonPropertyLine, tag } from "./helpers";

// Entrypoint-surface rules derived from the package.json diff. The high-signal
// case is a newly added `bin` command: npm symlinks every bin entry into the
// consumer's node_modules/.bin, so a release that adds one puts a new command on
// the install path even when no install script or code pattern fires. Plain
// `main`/`exports` retargets are intentionally not flagged here: they change on
// almost every build (e.g. `index.js` -> `dist/index.js`) and would be noise.
export function entrypointDiffFindings(
  packageJsonDiff: PackageJsonDiff,
  stagedPackageJsonText?: string | null,
): Finding[] {
  const findings: Finding[] = [];
  for (const entry of packageJsonDiff.bin) {
    if (entry.status !== "added") continue;
    findings.push(
      tag("diffBinAdded", {
        severity: "medium",
        file: "package.json",
        line: firstJsonPropertyLine(stagedPackageJsonText, "bin", entry.staged),
        evidence: `bin ${entry.key}: ${entry.staged}`,
        reason:
          "npm links package bin entries into the consumer's node_modules/.bin, so a newly published executable puts a new command on the install path and should be reviewed before approving the release",
      }),
    );
  }
  return findings;
}
