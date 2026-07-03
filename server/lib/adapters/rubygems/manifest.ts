import type { FileRecord } from "../../review";
import type { TarSuspiciousEntry } from "../../tar-parser.js";
import {
  RUBYGEMS_ARTIFACT_LIMIT,
  RUBYGEMS_GEM_NAME_RE,
  RUBYGEMS_RELEASE_MANIFEST_SCHEMA,
  type RubygemsAdapterInput,
  type RubygemsArtifactInput,
  type RubygemsArtifactKind,
  type RubygemsReleaseManifest,
  type RubygemsVersionInfo,
  SAFE_VERSION_RE,
  SHA256_RE,
} from "./types";

// RubyGems.org treats gem names case-insensitively for uniqueness, so identity
// comparisons normalize to lowercase.
export function normalizeRubygemsGemName(name: string): string {
  return name.toLowerCase();
}

export function isValidRubygemsGemName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 214 &&
    RUBYGEMS_GEM_NAME_RE.test(name)
  );
}

export function inferRubygemsArtifactKind(path: string): RubygemsArtifactKind | null {
  return path.toLowerCase().endsWith(".gem") ? "gem" : null;
}

export function parseRubygemsReleaseManifest(value: unknown): RubygemsReleaseManifest {
  if (!isRecord(value)) throw new Error("manifest must be an object");
  if (value.schema !== RUBYGEMS_RELEASE_MANIFEST_SCHEMA) {
    throw new Error(`manifest schema must be ${RUBYGEMS_RELEASE_MANIFEST_SCHEMA}`);
  }
  if (value.ecosystem !== "rubygems") throw new Error("manifest ecosystem must be rubygems");
  const packageName = String(value.package || "");
  const version = String(value.version || "");
  if (!isValidRubygemsGemName(packageName))
    throw new Error("manifest package is not a valid RubyGems gem name");
  if (!SAFE_VERSION_RE.test(version))
    throw new Error("manifest version is not a safe RubyGems version string");
  if (!Array.isArray(value.artifacts) || !value.artifacts.length) {
    throw new Error("manifest must include at least one artifact");
  }
  if (value.artifacts.length > RUBYGEMS_ARTIFACT_LIMIT) {
    throw new Error(`manifest must include no more than ${RUBYGEMS_ARTIFACT_LIMIT} artifacts`);
  }

  const artifacts = value.artifacts.map((artifact, index) => {
    if (!isRecord(artifact)) throw new Error(`artifact ${index + 1} must be an object`);
    const path = String(artifact.path || "");
    if (!isSafeManifestPath(path)) throw new Error(`artifact ${index + 1} path is not safe`);
    const kind = inferRubygemsArtifactKind(path);
    if (!kind) throw new Error(`artifact ${index + 1} must be a .gem archive`);
    const sha256 = String(artifact.sha256 || "");
    if (!SHA256_RE.test(sha256))
      throw new Error(`artifact ${index + 1} sha256 must be a hex SHA-256 digest`);
    const url = typeof artifact.url === "string" && artifact.url ? artifact.url : undefined;
    if (url && !isSafeHttpsUrl(url)) throw new Error(`artifact ${index + 1} url must be https`);
    return { path, sha256: sha256.toLowerCase(), url, kind };
  });

  return {
    schema: RUBYGEMS_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "rubygems",
    package: packageName,
    version,
    artifacts,
  };
}

export function parseRubygemsAdapterInput(raw: unknown): RubygemsAdapterInput {
  if (!isRecord(raw)) throw new Error("RubyGems adapter input must be an object");
  const manifest = parseRubygemsReleaseManifest(raw.manifest ?? raw);
  return {
    manifest,
    artifacts: parseRubygemsArtifactInputs(raw.artifacts, "artifacts"),
    previousArtifacts:
      raw.previousArtifacts === undefined
        ? undefined
        : parseRubygemsArtifactInputs(raw.previousArtifacts, "previousArtifacts"),
    metadata: Array.isArray(raw.metadata) ? (raw.metadata as RubygemsVersionInfo[]) : undefined,
  };
}

function parseRubygemsArtifactInputs(raw: unknown, field: string): RubygemsArtifactInput[] {
  if (!Array.isArray(raw) || !raw.length) {
    throw new Error(`RubyGems adapter input must include ${field}`);
  }
  return raw.map((artifact, index) => {
    if (!isRecord(artifact)) throw new Error(`${field}[${index}] must be an object`);
    const path = typeof artifact.path === "string" ? artifact.path : "";
    if (!isSafeManifestPath(path)) throw new Error(`${field}[${index}] path is not safe`);
    if (!Array.isArray(artifact.files))
      throw new Error(`${field}[${index}] files must be an array`);
    const suspiciousEntries = parseSuspiciousEntries(artifact.suspiciousEntries);
    return {
      path,
      files: artifact.files.map((file, fileIndex) =>
        parseFileRecord(file, field, index, fileIndex),
      ),
      ...(suspiciousEntries ? { suspiciousEntries } : {}),
    };
  });
}

const SUSPICIOUS_ENTRY_KINDS = new Set([
  "non-regular",
  "duplicate",
  "unicode-confusable",
  "content-skipped",
]);

// The sandbox parser caps suspicious entries at maxFiles; this bounds the
// re-validation on the adapter-input boundary so a hand-crafted input (not
// straight from the sandbox) cannot materialize an unbounded array.
const SUSPICIOUS_ENTRY_INPUT_LIMIT = 5_000;

// Preserve (and re-validate) the tar-parser's suspicious entries across the
// adapter-input boundary so oversized content-skipped bodies still reach the
// gate's findings instead of being silently dropped during input parsing.
function parseSuspiciousEntries(raw: unknown): TarSuspiciousEntry[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const entries: TarSuspiciousEntry[] = [];
  for (const item of raw.slice(0, SUSPICIOUS_ENTRY_INPUT_LIMIT)) {
    if (!isRecord(item)) continue;
    if (typeof item.kind !== "string" || !SUSPICIOUS_ENTRY_KINDS.has(item.kind)) continue;
    entries.push({
      kind: item.kind as TarSuspiciousEntry["kind"],
      path: typeof item.path === "string" ? item.path : "",
      detail: typeof item.detail === "string" ? item.detail : "",
    });
  }
  return entries.length ? entries : undefined;
}

function parseFileRecord(
  raw: unknown,
  field: string,
  artifactIndex: number,
  fileIndex: number,
): FileRecord {
  if (!isRecord(raw)) {
    throw new Error(`${field}[${artifactIndex}].files[${fileIndex}] must be an object`);
  }
  const path = typeof raw.path === "string" ? raw.path : "";
  const size = typeof raw.size === "number" ? raw.size : 0;
  const sha256 = typeof raw.sha256 === "string" ? raw.sha256 : "";
  const flags = Array.isArray(raw.flags)
    ? raw.flags.filter((flag): flag is string => typeof flag === "string")
    : [];
  return {
    path,
    size,
    sha256,
    flags,
    ...(typeof raw.textSample === "string" ? { textSample: raw.textSample } : {}),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeManifestPath(path: string): boolean {
  if (!path || path.length > 512 || path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/") || path.startsWith("../") || path.includes("/../")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((part) => part && part !== "." && part !== "..");
}

function isSafeHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
