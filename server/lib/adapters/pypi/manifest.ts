import type { FileRecord } from "../../review";
import {
  PYPI_ARTIFACT_LIMIT,
  PYPI_PROJECT_NAME_RE,
  PYPI_RELEASE_MANIFEST_SCHEMA,
  type PyPiAdapterInput,
  type PyPiArtifactInput,
  type PyPiArtifactKind,
  type PyPiProjectMetadata,
  type PyPiReleaseManifest,
  SAFE_VERSION_RE,
  SHA256_RE,
} from "./types";

export function normalizePyPiProjectName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

export function isValidPyPiProjectName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 214 &&
    PYPI_PROJECT_NAME_RE.test(name)
  );
}

export function inferPyPiArtifactKind(path: string): PyPiArtifactKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".whl")) return "wheel";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "sdist";
  return null;
}

export function parsePyPiReleaseManifest(value: unknown): PyPiReleaseManifest {
  if (!isRecord(value)) throw new Error("manifest must be an object");
  if (value.schema !== PYPI_RELEASE_MANIFEST_SCHEMA) {
    throw new Error(`manifest schema must be ${PYPI_RELEASE_MANIFEST_SCHEMA}`);
  }
  if (value.ecosystem !== "pypi") throw new Error("manifest ecosystem must be pypi");
  const packageName = String(value.package || "");
  const version = String(value.version || "");
  if (!isValidPyPiProjectName(packageName))
    throw new Error("manifest package is not a valid PyPI project name");
  if (!SAFE_VERSION_RE.test(version))
    throw new Error("manifest version is not a safe PyPI version string");
  if (!Array.isArray(value.artifacts) || !value.artifacts.length) {
    throw new Error("manifest must include at least one artifact");
  }
  if (value.artifacts.length > PYPI_ARTIFACT_LIMIT) {
    throw new Error(`manifest must include no more than ${PYPI_ARTIFACT_LIMIT} artifacts`);
  }

  const artifacts = value.artifacts.map((artifact, index) => {
    if (!isRecord(artifact)) throw new Error(`artifact ${index + 1} must be an object`);
    const path = String(artifact.path || "");
    if (!isSafeManifestPath(path)) throw new Error(`artifact ${index + 1} path is not safe`);
    const kind = inferPyPiArtifactKind(path);
    if (!kind) throw new Error(`artifact ${index + 1} must be a wheel or sdist`);
    const sha256 = String(artifact.sha256 || "");
    if (!SHA256_RE.test(sha256))
      throw new Error(`artifact ${index + 1} sha256 must be a hex SHA-256 digest`);
    const url = typeof artifact.url === "string" && artifact.url ? artifact.url : undefined;
    if (url && !isSafeHttpsUrl(url)) throw new Error(`artifact ${index + 1} url must be https`);
    return { path, sha256: sha256.toLowerCase(), url, kind };
  });

  return {
    schema: PYPI_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "pypi",
    package: packageName,
    version,
    artifacts,
  };
}

export function parsePyPiAdapterInput(raw: unknown): PyPiAdapterInput {
  if (!isRecord(raw)) throw new Error("PyPI adapter input must be an object");
  const manifest = parsePyPiReleaseManifest(raw.manifest ?? raw);
  return {
    manifest,
    artifacts: parsePyPiArtifactInputs(raw.artifacts, "artifacts"),
    previousArtifacts:
      raw.previousArtifacts === undefined
        ? undefined
        : parsePyPiArtifactInputs(raw.previousArtifacts, "previousArtifacts"),
    metadata: isRecord(raw.metadata) ? (raw.metadata as PyPiProjectMetadata) : undefined,
  };
}

function parsePyPiArtifactInputs(raw: unknown, field: string): PyPiArtifactInput[] {
  if (!Array.isArray(raw) || !raw.length) {
    throw new Error(`PyPI adapter input must include ${field}`);
  }
  return raw.map((artifact, index) => {
    if (!isRecord(artifact)) throw new Error(`${field}[${index}] must be an object`);
    const path = typeof artifact.path === "string" ? artifact.path : "";
    if (!isSafeManifestPath(path)) throw new Error(`${field}[${index}] path is not safe`);
    if (!Array.isArray(artifact.files))
      throw new Error(`${field}[${index}] files must be an array`);
    return {
      path,
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
