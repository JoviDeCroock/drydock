import { compilePackageFilesAllowlist } from "../package-files";
import type { FileRecord, Finding } from "../types";
import { containsSecretLikeText, firstSecretLine, safeJson, tag, testScope } from "./helpers";
import { changedPrefix, isUnreachableTestFile, type RuleContext } from "./context";
import { isDocumentationPath, isPythonMetadataPath, isTypeDeclarationPath } from "./file-types";
import { normalizeReachabilityPath } from "./reachability";

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

  const allowlist = compilePackageFilesAllowlist(
    ctx.packageJson,
    ctx.packageJsonFile?.textSample ? safeJson(ctx.packageJsonFile.textSample) : null,
  );
  const outsideAllowlist = allowlist
    ? ctx.files.filter(
        (file) =>
          ctx.diffByPath.get(file.path)?.status !== "removed" && allowlist.isOutside(file.path),
      )
    : [];
  const loadableDocumentation = documentationNamedByCode(
    ctx,
    outsideAllowlist.filter((file) => isDocumentationPath(file.path)),
  );
  const outsidePaths = new Set(outsideAllowlist.map((file) => file.path));

  for (const file of ctx.files) {
    const sample = file.textSample || "";
    const prefix = changedPrefix(ctx, file.path);
    const changed = ctx.diffByPath.get(file.path)?.status;
    // Python packaging metadata embeds the README long-description, so it gets
    // the same high-confidence-only treatment as documentation.
    const secretOptions = {
      highConfidenceOnly:
        isDocumentationPath(file.path) ||
        (ctx.codePatternSet === "python" && isPythonMetadataPath(file.path)),
    };
    // Type declarations keep a diffable sample but are excluded from content
    // scanning (perf/memory); the cheap path-based checks below still apply.
    const scanContent = !isTypeDeclarationPath(file.path);

    const secretContent = scanContent && containsSecretLikeText(sample, secretOptions);
    if (secretContent || /\.npmrc|\.env|id_rsa|id_ed25519/i.test(file.path)) {
      // A credential-shaped name with no recognized secret in it (`test.env`
      // fixtures, an `.npmrc` that interpolates `${NPM_TOKEN}`) is one step
      // below a file whose content matches: the name alone is weaker evidence.
      // Test-suite fixture material (self-signed certs under tests/certs/,
      // dummy tokens in test cases) is demoted one step like the code.*
      // capability rules, never dropped: a shipped private key is still worth
      // surfacing, but it is not the leak signal a package-code secret is.
      // Only longstanding (unchanged-from-baseline) material demotes — a
      // secret newly entering a test tree is a fresh leak or fresh payload
      // staging and keeps full severity until a baseline knows about it.
      findings.push(
        testScope(
          isUnreachableTestFile(ctx, file.path) && changed === "unchanged",
          false,
          tag("fileSecretContent", {
            severity: secretContent
              ? changed === "added"
                ? "critical"
                : "high"
              : changed === "added"
                ? "high"
                : "medium",
            file: file.path,
            line: firstSecretLine(sample, secretOptions),
            evidence: secretContent
              ? `${prefix}secret-looking file or content`
              : `${prefix}credential-named file without recognized secret content`,
            reason: "published artifacts should not include credentials or private material",
          }),
        ),
      );
    }
    if (outsidePaths.has(file.path)) {
      // Documentation is excluded from content scanning and only runs if
      // something loads it, so an unreferenced README-style file is a packaging
      // quirk to disclose, not a hidden payload. Anything code could load keeps
      // the full severity, including a doc that code names or reaches.
      const inertDocumentation =
        isDocumentationPath(file.path) && !loadableDocumentation.has(file.path);
      findings.push(
        tag("fileOutsideFilesList", {
          severity: inertDocumentation ? "low" : changed === "added" ? "high" : "medium",
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

// Documentation files outside the allowlist that something could load as code:
// reachable from an entrypoint or lifecycle hook through static imports, or
// whose basename appears anywhere in shipped code, or whose extension is a path
// token of a load call (`require(dir + '.md')`), as the capability scan reads
// data files. A load path assembled at runtime from pieces is not followed, the
// same limit the reachability walk has everywhere.
const LOAD_CALL_ARGUMENTS =
  /\b(?:require|import|fork|Worker|spawn(?:Sync)?|execFile(?:Sync)?|exec(?:Sync)?)\s*\(([^\n;]{0,300})/g;
const LOAD_CALL_PATH_TOKEN = /[^\s'"`\\/()+,;${}[\]]+/g;

function documentationNamedByCode(ctx: RuleContext, docs: FileRecord[]): Set<string> {
  const loadable = new Set<string>();
  if (!docs.length) return loadable;
  const pending = new Map<string, { basename: string; extension: string }>();
  for (const doc of docs) {
    if (ctx.consumerReachable.has(normalizeReachabilityPath(doc.path))) {
      loadable.add(doc.path);
      continue;
    }
    const basename = (doc.path.split("/").at(-1) ?? "").toLowerCase();
    const dot = basename.lastIndexOf(".");
    pending.set(doc.path, { basename, extension: dot > 0 ? basename.slice(dot) : "" });
  }
  for (const file of ctx.files) {
    if (!pending.size) break;
    if (!file.textSample || isDocumentationPath(file.path)) continue;
    const text = file.textSample.toLowerCase();
    LOAD_CALL_ARGUMENTS.lastIndex = 0;
    const loadTokens = new Set(
      [...file.textSample.matchAll(LOAD_CALL_ARGUMENTS)].flatMap((match) =>
        (match[1].match(LOAD_CALL_PATH_TOKEN) ?? []).map((token) => token.toLowerCase()),
      ),
    );
    for (const [path, { basename, extension }] of pending) {
      if (text.includes(basename) || (extension && loadTokens.has(extension))) {
        loadable.add(path);
        pending.delete(path);
      }
    }
  }
  return loadable;
}
