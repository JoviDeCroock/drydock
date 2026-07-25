import type { Finding } from "..";
import { tag } from "./helpers";
import type { RuleContext } from "./context";

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
    if (formatLabel || NATIVE_ARTIFACT_EXTENSION.test(file.path)) {
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
    if (entry.status === "added" && entry.stagedSize && entry.stagedSize > 2 * 1024 * 1024) {
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
