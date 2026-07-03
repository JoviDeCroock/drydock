import type { FileRecord } from "../../review";
import type { TarSuspiciousEntry } from "../../tar-parser.js";
import {
  COMPOSER_ARTIFACT_LIMIT,
  COMPOSER_PACKAGE_NAME_RE,
  COMPOSER_RELEASE_MANIFEST_SCHEMA,
  type ComposerAdapterInput,
  type ComposerArtifactInput,
  type ComposerArtifactKind,
  type ComposerPackageMetadata,
  type ComposerReleaseManifest,
  SAFE_VERSION_RE,
  SHA256_RE,
} from "./types";

export function normalizeComposerPackageName(name: string): string {
  return name.toLowerCase();
}

export function isValidComposerPackageName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 214 &&
    COMPOSER_PACKAGE_NAME_RE.test(name.toLowerCase())
  );
}

export function inferComposerArtifactKind(path: string): ComposerArtifactKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar";
  return null;
}

export function parseComposerReleaseManifest(value: unknown): ComposerReleaseManifest {
  if (!isRecord(value)) throw new Error("manifest must be an object");
  if (value.schema !== COMPOSER_RELEASE_MANIFEST_SCHEMA) {
    throw new Error(`manifest schema must be ${COMPOSER_RELEASE_MANIFEST_SCHEMA}`);
  }
  if (value.ecosystem !== "composer") throw new Error("manifest ecosystem must be composer");
  const packageName = String(value.package || "");
  const version = String(value.version || "");
  if (!isValidComposerPackageName(packageName)) {
    throw new Error("manifest package is not a valid Composer package name");
  }
  if (!SAFE_VERSION_RE.test(version)) {
    throw new Error("manifest version is not a safe Composer version string");
  }
  if (!Array.isArray(value.artifacts) || !value.artifacts.length) {
    throw new Error("manifest must include at least one artifact");
  }
  if (value.artifacts.length > COMPOSER_ARTIFACT_LIMIT) {
    throw new Error(`manifest must include no more than ${COMPOSER_ARTIFACT_LIMIT} artifact`);
  }

  const artifacts = value.artifacts.map((artifact, index) => {
    if (!isRecord(artifact)) throw new Error(`artifact ${index + 1} must be an object`);
    const path = String(artifact.path || "");
    if (!isSafeManifestPath(path)) throw new Error(`artifact ${index + 1} path is not safe`);
    const kind = inferComposerArtifactKind(path);
    if (!kind) throw new Error(`artifact ${index + 1} must be a .zip, .tar.gz, or .tgz archive`);
    const sha256 = String(artifact.sha256 || "");
    if (!SHA256_RE.test(sha256)) {
      throw new Error(`artifact ${index + 1} sha256 must be a hex SHA-256 digest`);
    }
    return { path, sha256: sha256.toLowerCase(), kind };
  });

  return {
    schema: COMPOSER_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "composer",
    package: normalizeComposerPackageName(packageName),
    version,
    artifacts,
  };
}

export function parseComposerAdapterInput(raw: unknown): ComposerAdapterInput {
  if (!isRecord(raw)) throw new Error("Composer adapter input must be an object");
  const manifest = parseComposerReleaseManifest(raw.manifest ?? raw);
  return {
    manifest,
    artifacts: parseComposerArtifactInputs(raw.artifacts, "artifacts"),
    previousArtifacts:
      raw.previousArtifacts === undefined
        ? undefined
        : parseComposerArtifactInputs(raw.previousArtifacts, "previousArtifacts"),
    metadata: isRecord(raw.metadata) ? (raw.metadata as ComposerPackageMetadata) : undefined,
  };
}

function parseComposerArtifactInputs(raw: unknown, field: string): ComposerArtifactInput[] {
  if (!Array.isArray(raw) || !raw.length) {
    throw new Error(`Composer adapter input must include ${field}`);
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
// re-validation on the adapter-input boundary so a hand-crafted input cannot
// materialize an unbounded array.
const SUSPICIOUS_ENTRY_INPUT_LIMIT = 5_000;

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
