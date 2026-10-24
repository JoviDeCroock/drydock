import { firstMatchingLine } from "../../platform/text-utils";
import { compilePackageFilesAllowlist } from "../package-files";
import type { FileRecord, Finding } from "../types";
import { containsSecretLikeText, firstSecretLine, safeJson, tag, testScope } from "./helpers";
import { changedPrefix, isUnreachableTestFile, type RuleContext } from "./context";
import { isDocumentationPath, isPythonMetadataPath, isTypeDeclarationPath } from "./file-types";
import { normalizeCodeForScanning } from "./normalize";
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

  const outsideAllowlist = filesOutsideAllowlist(ctx);
  const loadableDocumentation = documentationLoadableAsCode(
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
      // An unreferenced doc with no code capability in it is a packaging
      // quirk to disclose, not a hidden payload (see
      // `documentationLoadableAsCode`); everything else keeps full severity.
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

function filesOutsideAllowlist(ctx: RuleContext): FileRecord[] {
  const bundledManifests = new Map<string, string>();
  for (const file of ctx.files) {
    if (file.textSample && /^node_modules\/.*\/package\.json$/i.test(file.path)) {
      bundledManifests.set(file.path.toLowerCase(), file.textSample);
    }
  }
  const allowlist = compilePackageFilesAllowlist(
    ctx.packageJson,
    ctx.packageJsonFile?.textSample ? safeJson(ctx.packageJsonFile.textSample) : null,
    {
      packedManifest: (path) => {
        const text = bundledManifests.get(path);
        return text ? safeJson(text) : null;
      },
    },
  );
  const present = ctx.files.filter((file) => ctx.diffByPath.get(file.path)?.status !== "removed");
  const outside = allowlist?.outsidePaths(present.map((file) => file.path));
  return outside ? present.filter((file) => outside.has(file.path)) : [];
}

// Documentation files outside the allowlist that could run as code. Docs are
// excluded from the capability scan, so the demotion has to prove two things:
// nothing loads the file, and it would do nothing if something did.
//
// - Loaded: reachable from an entrypoint or lifecycle hook through static
//   imports; its basename named anywhere in shipped code, raw or after the
//   scanner's constant folding (`'guide.' + 'md'`, `['gui','de.md'].join('')`);
//   or its extension a path token of a load call (`require(dir + '.md')`).
//   Shipped code that installs a module loader (`require.extensions`,
//   `Module._extensions` / `_compile`, `module.register` / `registerHooks`)
//   can make any extension executable, so then no doc is presumed inert.
// - Would act: its own text matches the code capability rules (process,
//   network, credential, dynamic evaluation). A doc that only describes such
//   calls in an example keeps full severity too; that is the cost of not
//   trusting a hostile file's extension.
//
// A path assembled in a way the folding does not undo (a template literal, a
// computed index) is not followed, the same limit the reachability walk has
// everywhere; the content check is what still covers that case.
const LOAD_CALL_ARGUMENTS =
  /\b(?:require|import|fork|Worker|spawn(?:Sync)?|execFile(?:Sync)?|exec(?:Sync)?)\s*\(([^\n;]{0,300})/g;
const LOAD_CALL_PATH_TOKEN = /[^\s'"`\\/()+,;${}[\]]+/g;
const MODULE_LOADER_HOOK =
  /\brequire\s*(?:\.\s*|\[\s*['"`])extensions\b|\b_extensions\b|\b_compile\b|\bregisterHooks\s*\(|\bmodule\s*\.\s*register\s*\(/;

function documentationLoadableAsCode(ctx: RuleContext, docs: FileRecord[]): Set<string> {
  const loadable = new Set<string>();
  if (!docs.length) return loadable;
  const pending = new Set<string>();
  const byBasename = new Map<string, string[]>();
  const byExtension = new Map<string, string[]>();
  for (const doc of docs) {
    if (
      ctx.consumerReachable.has(normalizeReachabilityPath(doc.path)) ||
      documentationActsAsCode(ctx, doc.textSample)
    ) {
      loadable.add(doc.path);
      continue;
    }
    const basename = (doc.path.split("/").at(-1) ?? "").toLowerCase();
    const dot = basename.lastIndexOf(".");
    pending.add(doc.path);
    addTo(byBasename, basename, doc.path);
    if (dot > 0) addTo(byExtension, basename.slice(dot), doc.path);
  }
  const names = new BasenameSearch([...byBasename.keys()]);
  const markLoadable = (paths: string[] | undefined) => {
    for (const path of paths ?? []) {
      if (pending.delete(path)) loadable.add(path);
    }
  };
  for (const file of ctx.files) {
    if (!pending.size) break;
    if (!file.textSample || isDocumentationPath(file.path)) continue;
    const folded = normalizeCodeForScanning(file.textSample);
    const texts = folded === file.textSample ? [file.textSample] : [file.textSample, folded];
    if (texts.some((text) => MODULE_LOADER_HOOK.test(text))) {
      markLoadable([...pending]);
      break;
    }
    // Streamed, and only extensions a pending doc has are looked up: the text
    // is hostile and its distinct tokens are bounded only by the retained bytes.
    for (const text of texts) {
      for (const match of text.matchAll(LOAD_CALL_ARGUMENTS)) {
        for (const [token] of match[1].matchAll(LOAD_CALL_PATH_TOKEN)) {
          markLoadable(byExtension.get(token.toLowerCase()));
        }
      }
    }
    const found = names.findIn(texts.map((text) => text.toLowerCase()));
    if (!found) {
      markLoadable([...pending]);
      break;
    }
    for (const name of found) markLoadable(byBasename.get(name));
  }
  return loadable;
}

function addTo(index: Map<string, string[]>, key: string, path: string) {
  const paths = index.get(key);
  if (paths) paths.push(path);
  else index.set(key, [path]);
}

// Finds which basenames occur anywhere in a text, as `text.includes` would
// say. A name ends in its anchor (from its last `.`, or the whole name), so
// only the name lengths ending at each occurrence of an anchor are compared,
// and documentation names share a handful of anchors. Searching name by name
// cost docs x bytes; the characters compared are charged across every text
// instead, and null means the budget ran out, which the caller treats as every
// name being present. A name found once is not searched for again.
const MAX_DOC_NAME_CHARS = 20_000_000;

class BasenameSearch {
  private readonly byAnchor = new Map<
    string,
    { names: Set<string>; lengths: Set<number>; cost: number }
  >();
  private readonly empty: boolean;
  private remaining = MAX_DOC_NAME_CHARS;

  constructor(basenames: string[]) {
    // `includes("")` is always true.
    this.empty = basenames.includes("");
    for (const name of basenames) {
      if (!name) continue;
      const anchor = name.slice(Math.max(name.lastIndexOf("."), 0));
      const group = this.byAnchor.get(anchor) ?? { names: new Set(), lengths: new Set(), cost: 0 };
      group.names.add(name);
      if (!group.lengths.has(name.length)) group.cost += name.length;
      group.lengths.add(name.length);
      this.byAnchor.set(anchor, group);
    }
  }

  findIn(texts: string[]): string[] | null {
    const found: string[] = this.empty && texts.length ? [""] : [];
    for (const [anchor, { names, lengths, cost }] of this.byAnchor) {
      for (const text of texts) {
        for (
          let at = text.indexOf(anchor);
          at >= 0 && names.size;
          at = text.indexOf(anchor, at + 1)
        ) {
          this.remaining -= cost;
          if (this.remaining < 0) return null;
          const end = at + anchor.length;
          for (const length of lengths) {
            const candidate = length <= end ? text.slice(end - length, end) : "";
            if (names.delete(candidate)) found.push(candidate);
          }
        }
      }
      if (!names.size) this.byAnchor.delete(anchor);
    }
    return found;
  }
}

function documentationActsAsCode(ctx: RuleContext, sample: string | undefined): boolean {
  if (!sample) return false;
  const folded = ctx.codePatternSet === "python" ? sample : normalizeCodeForScanning(sample);
  const texts = folded === sample ? [sample] : [sample, folded];
  const patterns = [
    ...ctx.patterns.processExecution,
    ...ctx.patterns.networkAccess,
    ...ctx.patterns.credentialAccess,
    ...ctx.patterns.dynamicExecution,
    ...ctx.patterns.dynamicEvaluation,
  ];
  return texts.some(
    (text) =>
      firstMatchingLine(text, patterns) !== undefined ||
      patterns.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(text);
      }),
  );
}
