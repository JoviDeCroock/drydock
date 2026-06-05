import { isOutsidePackageFilesAllowlist } from "../review-package-files";
import { scanContent, type Finding } from "../review";
import { containsSecretLikeText, firstSecretLine, tag } from "./helpers";
import { changedPrefix, type RuleContext } from "./context";
import { isDocumentationPath } from "./file-types";

// Manifest integrity and secret-exposure rules: parse failures, secret-looking
// files, files outside the declared allowlist, and credential files added to
// the release.
export function metadataFindings(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];

  if (ctx.packageJsonParseFailed) {
    findings.push(
      tag("packageJsonParseFailed", {
        severity: "medium",
        file: ctx.packageJsonFile?.path ?? "package.json",
        line: 1,
        evidence: ctx.packageJsonFile?.flags.includes("truncated")
          ? "package.json parse failed; captured sample was truncated"
          : "package.json parse failed",
        reason:
          "the package manifest could not be parsed, so lifecycle script and dependency review from the tarball manifest may be incomplete",
      }),
    );
  }

  for (const file of ctx.files) {
    const sample = scanContent(file);
    const prefix = changedPrefix(ctx, file.path);
    const changed = ctx.diffByPath.get(file.path)?.status;
    const secretOptions = { highConfidenceOnly: isDocumentationPath(file.path) };

    if (
      /\.npmrc|\.env|id_rsa|id_ed25519/i.test(file.path) ||
      containsSecretLikeText(sample, secretOptions)
    ) {
      findings.push(
        tag("fileSecretContent", {
          severity: changed === "added" ? "critical" : "high",
          file: file.path,
          line: firstSecretLine(sample, secretOptions),
          evidence: `${prefix}secret-looking file or content`,
          reason: "published artifacts should not include credentials or private material",
        }),
      );
    }
    if (isOutsidePackageFilesAllowlist(file.path, ctx.packageJson) && changed !== "removed") {
      findings.push(
        tag("fileOutsideFilesList", {
          severity: changed === "added" ? "high" : "medium",
          file: file.path,
          evidence: `${prefix}file is not matched by package.json files allowlist`,
          reason:
            "unexpected files outside the declared package files list can indicate tarball tampering or generated payloads that are not visible in the source/package manifest review",
        }),
      );
    }
  }

  for (const entry of ctx.diff) {
    if (entry.status === "added" && /(^|\/)(\.npmrc|\.env|id_rsa|id_ed25519)$/i.test(entry.path)) {
      findings.push(
        tag("diffCredentialFileAdded", {
          severity: "critical",
          file: entry.path,
          line: 1,
          evidence: "credential-looking file added",
          reason: "package artifact includes a file name commonly associated with secrets",
        }),
      );
    }
  }

  return findings;
}
