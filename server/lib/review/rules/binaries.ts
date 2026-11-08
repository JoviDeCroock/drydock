import type { Finding } from "../types";
import {
  lifecycleScriptSeedPaths,
  normalizeReachabilityPath,
  resolveSeedPaths,
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
    const releaseSeverity = changed === "added" || changed === "modified" ? "high" : "medium";
    if (file.flags.includes("control-bytes")) {
      findings.push(
        testScope(
          isUnreachableTestFile(ctx, file.path),
          false,
          tag("fileControlBytes", {
            severity: releaseSeverity,
            file: file.path,
            evidence: withSha256("source file contains raw NUL or control bytes", file.sha256),
            reason:
              "raw control bytes make source read as binary to review tools while interpreters still run it; legitimate source writes them as escapes",
          }),
        ),
      );
    }
    const unsampled = unsampledReason(file.flags);
    // The parser flags an empty body `binary` too; it hides nothing.
    if (unsampled && !native && file.size > 0 && !file.textSample && isSeed(file.path)) {
      findings.push(
        tag("fileUnsampledEntrypoint", {
          severity: releaseSeverity,
          file: file.path,
          evidence: withSha256(
            `manifest entrypoint or install script target has no text sample (${unsampled})`,
            file.sha256,
          ),
          reason:
            "Node runs an entrypoint whatever its extension, so code in a file the review cannot read runs unreviewed",
        }),
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

function unsampledReason(flags: readonly string[]): string | null {
  if (flags.includes("binary")) return "reads as binary";
  if (flags.includes("text-sample-skipped")) return "never-sampled source map";
  return null;
}

// Node runs `main`, a `bin` target or a file an install script names whatever
// its extension, so a body with no text sample there is code nobody reviewed.
// `exports`/`browser` targets and imports are left out: packages export and
// import images, fonts and source maps as assets. Python's entrypoints are
// `.py` modules, which the parser already decodes.
function declaredSeedPaths(ctx: RuleContext): Set<string> {
  if (ctx.codePatternSet === "python") return new Set();
  const manifest = ctx.packageJson;
  const bin = manifest?.bin;
  const candidates = [
    ...(typeof manifest?.main === "string" ? [manifest.main] : []),
    ...(typeof bin === "string" ? [bin] : Object.values(bin ?? {})).filter(
      (target): target is string => typeof target === "string",
    ),
    ...lifecycleScriptSeedPaths(ctx.files, ctx.scripts, ctx.implicitScripts),
  ];
  return resolveSeedPaths(ctx.files, candidates);
}
