import type { Finding } from "../review";
import { tag } from "./helpers";
import type { RuleContext } from "./context";

// Large binary, native, and oversized-artifact rules: package contents that
// execute or ship outside JavaScript policy checks and resist manual audit.
export function binaryFindings(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];

  for (const file of ctx.files) {
    const changed = ctx.diffByPath.get(file.path)?.status;

    if (file.flags.includes("binary") && file.size > 1024 * 1024) {
      findings.push(
        tag("fileLargeBinary", {
          severity: changed === "added" ? "high" : "info",
          file: file.path,
          evidence: `${file.size} byte binary`,
          reason: "large binary should be reviewed manually",
        }),
      );
    }
    if (/\.(node|dll|so|dylib|exe|wasm)$/i.test(file.path)) {
      findings.push(
        tag("fileNativeArtifact", {
          severity: "high",
          file: file.path,
          evidence: "native, wasm, or executable artifact",
          reason:
            "native binaries are hard to audit and can execute outside JavaScript policy checks",
        }),
      );
    }
  }

  for (const entry of ctx.diff) {
    if (entry.status === "added" && entry.stagedSize && entry.stagedSize > 2 * 1024 * 1024) {
      findings.push(
        tag("diffLargeNewFile", {
          severity: "medium",
          file: entry.path,
          evidence: `${entry.stagedSize} byte new file`,
          reason: "large new package artifact should be reviewed",
        }),
      );
    }
  }

  return findings;
}
