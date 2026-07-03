import type { FileRecord } from "../../review";
import {
  GEM_NAME_RE,
  GEM_VERSION_RE,
  RUBYGEMS_ARTIFACT_LIMIT,
  RUBYGEMS_RELEASE_MANIFEST_SCHEMA,
  type RubyGemsAdapterInput,
  type RubyGemsArtifactInput,
  type RubyGemsReleaseManifest,
  type RubyGemsVersion,
  SHA256_RE,
} from "./types";

// RubyGems treats names case-sensitively for resolution but the registry index
// is effectively case-insensitive; normalize to lowercase only for grouping
// equality so two `.gem` files that disagree only in case are still one package.
export function normalizeGemName(name: string): string {
  return name.toLowerCase();
}

export function isValidGemName(name: string): boolean {
  return (
    typeof name === "string" && name.length > 0 && name.length <= 100 && GEM_NAME_RE.test(name)
  );
}

export function isValidGemVersion(version: string): boolean {
  return typeof version === "string" && GEM_VERSION_RE.test(version);
}

export function parseRubyGemsReleaseManifest(value: unknown): RubyGemsReleaseManifest {
  if (!isRecord(value)) throw new Error("manifest must be an object");
  if (value.schema !== RUBYGEMS_RELEASE_MANIFEST_SCHEMA) {
    throw new Error(`manifest schema must be ${RUBYGEMS_RELEASE_MANIFEST_SCHEMA}`);
  }
  if (value.ecosystem !== "rubygems") throw new Error("manifest ecosystem must be rubygems");
  const packageName = String(value.package || "");
  const version = String(value.version || "");
  if (!isValidGemName(packageName)) throw new Error("manifest package is not a valid gem name");
  if (!isValidGemVersion(version)) throw new Error("manifest version is not a safe gem version");
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
    if (!path.toLowerCase().endsWith(".gem"))
      throw new Error(`artifact ${index + 1} must be a .gem`);
    const sha256 = String(artifact.sha256 || "");
    if (!SHA256_RE.test(sha256)) {
      throw new Error(`artifact ${index + 1} sha256 must be a hex SHA-256 digest`);
    }
    const url = typeof artifact.url === "string" && artifact.url ? artifact.url : undefined;
    if (url && !isSafeHttpsUrl(url)) throw new Error(`artifact ${index + 1} url must be https`);
    return { path, sha256: sha256.toLowerCase(), url };
  });

  return {
    schema: RUBYGEMS_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "rubygems",
    package: packageName,
    version,
    artifacts,
  };
}

export function parseRubyGemsAdapterInput(raw: unknown): RubyGemsAdapterInput {
  if (!isRecord(raw)) throw new Error("rubygems adapter input must be an object");
  const manifest = parseRubyGemsReleaseManifest(raw.manifest ?? raw);
  return {
    manifest,
    artifacts: parseRubyGemsArtifactInputs(raw.artifacts, "artifacts"),
    previousArtifacts:
      raw.previousArtifacts === undefined
        ? undefined
        : parseRubyGemsArtifactInputs(raw.previousArtifacts, "previousArtifacts"),
    versions: Array.isArray(raw.versions) ? (raw.versions as RubyGemsVersion[]) : undefined,
  };
}

function parseRubyGemsArtifactInputs(raw: unknown, field: string): RubyGemsArtifactInput[] {
  if (!Array.isArray(raw) || !raw.length) {
    throw new Error(`rubygems adapter input must include ${field}`);
  }
  return raw.map((artifact, index) => {
    if (!isRecord(artifact)) throw new Error(`${field}[${index}] must be an object`);
    const path = typeof artifact.path === "string" ? artifact.path : "";
    if (!isSafeManifestPath(path)) throw new Error(`${field}[${index}] path is not safe`);
    if (!Array.isArray(artifact.files))
      throw new Error(`${field}[${index}] files must be an array`);
    return {
      path,
      gemMetadata: typeof artifact.gemMetadata === "string" ? artifact.gemMetadata : null,
      ...(Array.isArray(artifact.suspiciousEntries)
        ? {
            suspiciousEntries:
              artifact.suspiciousEntries as RubyGemsArtifactInput["suspiciousEntries"],
          }
        : {}),
      files: artifact.files.map((file, fileIndex) =>
        parseFileRecord(file, field, index, fileIndex),
      ),
    };
  });
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
