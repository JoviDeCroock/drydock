import type { Finding } from "../types";
import {
  javascriptSeedPaths,
  lifecycleScriptSeedPaths,
  normalizeReachabilityPath,
} from "./reachability";
import { tag, testScope } from "./helpers";
import { isUnreachableTestFile, type RuleContext } from "./context";

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

// Large binary, native, and oversized-artifact rules: package contents that
// execute or ship outside JavaScript policy checks and resist manual audit.
export function binaryFindings(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];
  let seeds: Set<string> | undefined;
  const isSeed = (path: string) => {
    seeds ??= declaredSeedPaths(ctx);
    return seeds.has(normalizeReachabilityPath(path));
  };

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
    // The parser flags an empty body `binary` too; it hides nothing.
    const hiddenEntrypoint =
      !native && file.size > 0 && file.flags.includes("binary") && isSeed(file.path);
    if (file.flags.includes("control-bytes") || hiddenEntrypoint) {
      findings.push(
        testScope(
          isUnreachableTestFile(ctx, file.path),
          false,
          tag("fileControlBytes", {
            severity: changed === "added" || changed === "modified" ? "high" : "medium",
            file: file.path,
            evidence: withSha256(
              hiddenEntrypoint
                ? "manifest entrypoint or install script target reads as binary"
                : "source file contains raw NUL or control bytes",
              file.sha256,
            ),
            reason:
              "raw control bytes make source read as binary to review tools while interpreters still run it; legitimate source writes them as escapes",
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

// Node runs a manifest entrypoint or a file an install script names whatever
// its extension, so a body with no text sample there is code nobody reviewed.
// Imported files are left out: bundler-targeted code imports images and fonts.
// Python's entrypoints are `.py` modules, which the parser already decodes.
function declaredSeedPaths(ctx: RuleContext): Set<string> {
  if (ctx.codePatternSet === "python") return new Set();
  return javascriptSeedPaths(
    ctx.files,
    ctx.packageJson,
    lifecycleScriptSeedPaths(ctx.files, ctx.scripts, ctx.implicitScripts),
  );
}
