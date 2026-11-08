import type { Finding } from "../types";
import { isInertAssetPath, isPackedArchivePath } from "../../tar-parser.js";
import {
  codeLoadedPaths,
  lifecycleScriptSeedPaths,
  normalizeReachabilityPath,
  runEntrypointPaths,
} from "./reachability";
import { tag, testScope } from "./helpers";
import { buildRuleContext, isUnreachableTestFile, type RuleContext } from "./context";
import { isLifecycleScriptFile, loadedAsCode, namedInLoadCall } from "./load-calls";
import { isJsonDataPath, isTypeDeclarationPath } from "./file-types";

const NATIVE_ARTIFACT_EXTENSION = /\.(node|dll|so|dylib|exe|wasm)$/i;

// Labels for the parser's magic-byte flags (sniffNativeArtifact in
// tar-parser.js). Extension matching alone skewed detection toward Windows:
// .exe/.dll always carry their extension, while the same package's Linux and
// macOS binaries conventionally ship extensionless.
const NATIVE_FLAG_FORMATS: Record<string, string> = {
  "native-elf": "ELF executable",
  "native-macho": "Mach-O executable",
  "native-pe": "Windows PE/DOS executable",
  "native-wasm": "WebAssembly module",
};

export function nativeFormatLabel(flags: readonly string[]): string | null {
  for (const flag of flags) {
    const label = NATIVE_FLAG_FORMATS[flag];
    if (label) return label;
  }
  return null;
}

// The hash is the only identity a reviewer can take to the registry artifact
// when the body is binary or was never retained, so it rides on every
// binary-shaped finding. Legacy artifacts persisted before skip-hashing have
// no hash — omit rather than print an empty field.
function withSha256(evidence: string, sha256: string | undefined): string {
  return sha256 ? `${evidence}; sha256 ${sha256}` : evidence;
}

// Evidence prefix for a finding on a file this release newly loads; release
// attribution reads it (see diff-annotation.ts), since the bytes may not change.
export const NEWLY_LOADED_EVIDENCE = "newly loaded: ";

// Large binary, native, and oversized-artifact rules: package contents that
// execute or ship outside JavaScript policy checks and resist manual audit.
export function binaryFindings(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];
  const grade = loadGrader(ctx);

  for (const file of ctx.files) {
    const changed = ctx.diffByPath.get(file.path)?.status;

    if (file.flags.includes("binary") && file.size > 1024 * 1024) {
      findings.push(
        tag("fileLargeBinary", {
          severity: changed === "added" ? "high" : "info",
          file: file.path,
          evidence: withSha256(`${file.size} byte binary`, file.sha256),
          reason: "large binary should be reviewed manually",
        }),
      );
    }
    const formatLabel = nativeFormatLabel(file.flags);
    const native = Boolean(formatLabel) || NATIVE_ARTIFACT_EXTENSION.test(file.path);
    if (file.flags.includes("control-bytes")) {
      // Script source keeps the `control-bytes` flag alone; any other body
      // the parser decoded is also `binary` and only matters where it is loaded.
      const script = !file.flags.includes("binary");
      const graded = grade(file.path, changed, script, isOpaqueFormatPath(file.path));
      if (graded) {
        findings.push(
          testScope(
            isUnreachableTestFile(ctx, file.path),
            false,
            tag("fileControlBytes", {
              severity: graded.severity,
              file: file.path,
              evidence: withSha256(
                `${graded.prefix}${script ? "source" : "loaded"} file contains raw NUL or control bytes`,
                file.sha256,
              ),
              reason:
                "raw control bytes make source read as binary to review tools while interpreters still run it; legitimate source writes them as escapes",
            }),
          ),
        );
      }
    }
    const unsampled = unsampledReason(file.path, file.flags);
    // The parser flags an empty body `binary` too; it hides nothing.
    // Node parses JSON and never runs a type declaration, whatever names them.
    const neverRun = isJsonDataPath(file.path) || isTypeDeclarationPath(file.path);
    const graded =
      unsampled &&
      !native &&
      !neverRun &&
      file.size > 0 &&
      !file.textSample &&
      ctx.codePatternSet !== "python"
        ? grade(file.path, changed, false, false, unsampled.scope)
        : null;
    if (unsampled && graded) {
      findings.push(
        tag("fileUnsampledEntrypoint", {
          severity: graded.severity,
          file: file.path,
          evidence: withSha256(
            `${graded.prefix}file the package loads has no text sample (${unsampled.reason})`,
            file.sha256,
          ),
          reason:
            "Node runs a file a manifest or require() names whatever its extension, so code in a file the review cannot read runs unreviewed",
        }),
      );
    }
    const encoding = pythonSourceEncoding(file);
    if (encoding) {
      const release = changed === "added" || changed === "modified";
      findings.push(
        testScope(
          isUnreachableTestFile(ctx, file.path),
          false,
          tag("filePythonSourceEncoding", {
            severity: encoding.asciiSafe ? "low" : release ? "high" : "medium",
            file: file.path,
            line: encoding.line,
            evidence: `declares source encoding ${encoding.name}`,
            reason: encoding.asciiSafe
              ? "CPython decodes the file with the declared codec; it keeps ASCII as ASCII, so the reviewed text matches the code"
              : "CPython decodes the file with the declared codec before running it, so the code that runs is not the text reviewers read",
          }),
        ),
      );
    }
    if (native) {
      findings.push(
        tag("fileNativeArtifact", {
          severity: "high",
          file: file.path,
          evidence: withSha256(
            formatLabel ? `${formatLabel} (magic bytes)` : "native, wasm, or executable artifact",
            file.sha256,
          ),
          reason:
            "native binaries are hard to audit and can execute outside JavaScript policy checks",
        }),
      );
    }
  }

  for (const entry of ctx.diff) {
    // A large bundle renamed from its predecessor (a new content hash) is not
    // a new artifact; its changes are judged against that predecessor.
    const isNew = ctx.diffByPath.get(entry.path)?.status === "added";
    if (isNew && entry.stagedSize && entry.stagedSize > 2 * 1024 * 1024) {
      findings.push(
        tag("diffLargeNewFile", {
          severity: "medium",
          file: entry.path,
          evidence: withSha256(`${entry.stagedSize} byte new file`, entry.stagedSha256),
          reason: "large new package artifact should be reviewed",
        }),
      );
    }
  }

  return findings;
}

// Media, font and archive formats, by name. The parser leaves one opaque only
// when its first byte proves Node cannot run it (see decodeBodyText), so such
// a body is no unread code; one with a scriptable start was decoded.
function isOpaqueFormatPath(path: string): boolean {
  return isInertAssetPath(path) || isPackedArchivePath(path);
}

// How far a file must be loaded to count. A hash-only body counts only as a
// run entrypoint: any other is one of the many files a large package pushes
// past the retention limits, which the aggregate retention-tier notice already
// reports. A source map counts where a manifest or static import names it, not
// where its name merely appears in a load call's line (`sourceMappingURL`
// trailers sit beside them in minified code).
type LoadScope = "any" | "static" | "run";

function unsampledReason(
  path: string,
  flags: readonly string[],
): { reason: string; scope: LoadScope } | null {
  if (flags.includes("content-skipped")) {
    return { reason: "hash-only, over the retention limits", scope: "run" };
  }
  if (flags.includes("binary")) {
    return isOpaqueFormatPath(path) ? null : { reason: "reads as binary", scope: "any" };
  }
  if (flags.includes("text-sample-skipped")) {
    return { reason: "never-sampled source map", scope: "static" };
  }
  return null;
}

interface LoadGrade {
  severity: Finding["severity"];
  prefix: string;
}

// Grades a file by how surely the package loads it; null when nothing does
// (see `loadedAsCode`). Script source counts as loaded on its own. Strong: a
// run entrypoint or lifecycle target, imported from code, or named in a load
// call. A bare non-root `exports`/`browser` target, or a media/font/archive
// file only an import names, grades one step lower: packages export and import
// fonts, images, styles and source maps for bundlers. The higher tier applies
// when the file is new, changed, or newly loaded against the previous manifest.
function loadGrader(ctx: RuleContext) {
  let lifecycleSeeds: string[] | undefined;
  let codeLoaded: Set<string> | undefined;
  let runEntrypoints: Set<string> | undefined;
  let previous: RuleContext | null | undefined;
  const seeds = () =>
    (lifecycleSeeds ??= lifecycleScriptSeedPaths(ctx.files, ctx.scripts, ctx.implicitScripts));
  const isRunEntrypoint = (path: string) =>
    (runEntrypoints ??= runEntrypointPaths(ctx.files, ctx.packageJson, seeds())).has(
      normalizeReachabilityPath(path),
    );
  const isCodeLoaded = (path: string) =>
    (codeLoaded ??= codeLoadedPaths(ctx.files, ctx.packageJson, seeds())).has(
      normalizeReachabilityPath(path),
    ) ||
    isLifecycleScriptFile(ctx, path) ||
    namedInLoadCall(ctx, path);
  const loadedBefore = (path: string, scope: LoadScope) => {
    if (previous === undefined) {
      const files = [...new Set(ctx.previousByPath.values())];
      previous = files.length
        ? buildRuleContext(files, [], null, { codePatternSet: ctx.codePatternSet })
        : null;
    }
    const predecessor = ctx.previousByPath.get(path);
    return Boolean(previous && predecessor && loadedWithin(previous, predecessor.path, scope));
  };
  const loadedWithin = (target: RuleContext, path: string, scope: LoadScope) => {
    if (scope === "any") return loadedAsCode(target, path);
    if (scope === "run") {
      return runEntrypointPaths(
        target.files,
        target.packageJson,
        lifecycleScriptSeedPaths(target.files, target.scripts, target.implicitScripts),
      ).has(normalizeReachabilityPath(path));
    }
    return (
      target.consumerReachable.has(normalizeReachabilityPath(path)) ||
      isLifecycleScriptFile(target, path)
    );
  };
  return (
    path: string,
    changed: string | undefined,
    script: boolean,
    inertAsset = false,
    scope: LoadScope = "any",
  ): LoadGrade | null => {
    if (!script && !(scope === "run" ? isRunEntrypoint(path) : loadedWithin(ctx, path, scope))) {
      return null;
    }
    const strong = script || isRunEntrypoint(path) || (!inertAsset && isCodeLoaded(path));
    const release = changed === "added" || changed === "modified";
    const newlyLoaded = !release && !script && !loadedBefore(path, scope);
    const tier = release || newlyLoaded ? 1 : 0;
    const severity = (["low", "medium", "high"] as const)[tier + (strong ? 1 : 0)];
    return { severity, prefix: newlyLoaded ? NEWLY_LOADED_EVIDENCE : "" };
  };
}

// PEP 263: a coding cookie on either of the first two lines makes CPython
// decode the file with that codec. UTF-8 and Latin-1 spellings, as CPython
// normalizes them, read as reviewed; single-byte ASCII supersets keep ASCII
// code as written; any other codec (utf-7, utf-16, EBCDIC, double-byte sets
// whose trail bytes include `\`) can make the bytes reviewers read differ
// from the code that runs.
const PYTHON_CODING_COOKIE = /^[ \t\f]*#.*?coding[:=][ \t]*([-\w.]+)/;
const PYTHON_SOURCE = /\.(?:pyw?|pth)$/i;
const READS_AS_WRITTEN =
  /^(?:utf-?8(?:-.*)?|(?:us-)?ascii|latin-?1(?:-.*)?|iso-?8859-1(?:-.*)?|iso-latin-1(?:-.*)?|l1|cp819)$/;
const ASCII_SUPERSET =
  /^(?:iso-?8859-\d+|latin-?\d+|l\d|cp125\d|windows-125\d|koi8-[a-z]+|mac-?(?:roman|latin2|cyrillic|greek|turkish|iceland)|euc-(?:jp|kr|jis-?2004|jisx0213)|cp4\d\d|cp8\d\d|cp1006|tis-?620)$/;

function pythonSourceEncoding(file: {
  path: string;
  textSample?: string;
}): { name: string; line: number; asciiSafe: boolean } | null {
  if (!file.textSample || !PYTHON_SOURCE.test(file.path)) return null;
  const lines = file.textSample.slice(0, 4096).split(/\r\n|\r|\n/, 2);
  for (let index = 0; index < lines.length; index++) {
    const match = PYTHON_CODING_COOKIE.exec(lines[index].replace(/^\uFEFF/, ""));
    if (!match) continue;
    const name = match[1].toLowerCase().replaceAll("_", "-");
    if (READS_AS_WRITTEN.test(name)) return null;
    return { name: match[1].slice(0, 40), line: index + 1, asciiSafe: ASCII_SUPERSET.test(name) };
  }
  return null;
}
