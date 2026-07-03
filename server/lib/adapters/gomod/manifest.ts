import type { FileRecord } from "../../review";
import { isRecord, isSafeManifestPath, parseArtifactFilesInputs } from "../artifact-input";
import {
  GO_ARTIFACT_LIMIT,
  GO_MODULE_PATH_RE,
  GO_RELEASE_MANIFEST_SCHEMA,
  GO_VERSION_RE,
  SHA256_RE,
  type GoAdapterInput,
  type GoArtifactKind,
  type GoModuleSummary,
  type GoReleaseManifest,
} from "./types";

export function isValidGoModulePath(path: string): boolean {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 512 &&
    !path.includes("..") &&
    GO_MODULE_PATH_RE.test(path)
  );
}

export function isValidGoVersion(version: string): boolean {
  return typeof version === "string" && GO_VERSION_RE.test(version);
}

export function inferGoArtifactKind(path: string): GoArtifactKind | null {
  return path.toLowerCase().endsWith(".zip") ? "module" : null;
}

export function parseGoReleaseManifest(value: unknown): GoReleaseManifest {
  if (!isRecord(value)) throw new Error("manifest must be an object");
  if (value.schema !== GO_RELEASE_MANIFEST_SCHEMA) {
    throw new Error(`manifest schema must be ${GO_RELEASE_MANIFEST_SCHEMA}`);
  }
  if (value.ecosystem !== "go") throw new Error("manifest ecosystem must be go");
  const modulePath = String(value.package || "");
  const version = String(value.version || "");
  if (!isValidGoModulePath(modulePath)) {
    throw new Error("manifest package is not a valid Go module path");
  }
  if (!isValidGoVersion(version)) {
    throw new Error("manifest version is not a canonical Go semver version");
  }
  if (!Array.isArray(value.artifacts) || !value.artifacts.length) {
    throw new Error("manifest must include at least one artifact");
  }
  if (value.artifacts.length > GO_ARTIFACT_LIMIT) {
    throw new Error(`manifest must include no more than ${GO_ARTIFACT_LIMIT} artifacts`);
  }

  const artifacts = value.artifacts.map((artifact, index) => {
    if (!isRecord(artifact)) throw new Error(`artifact ${index + 1} must be an object`);
    const path = String(artifact.path || "");
    if (!isSafeManifestPath(path)) throw new Error(`artifact ${index + 1} path is not safe`);
    const kind = inferGoArtifactKind(path);
    if (!kind) throw new Error(`artifact ${index + 1} must be a module .zip archive`);
    const sha256 = String(artifact.sha256 || "");
    if (!SHA256_RE.test(sha256))
      throw new Error(`artifact ${index + 1} sha256 must be a hex SHA-256 digest`);
    return { path, sha256: sha256.toLowerCase(), kind };
  });

  return {
    schema: GO_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "go",
    package: modulePath,
    version,
    artifacts,
  };
}

export function parseGoAdapterInput(raw: unknown): GoAdapterInput {
  if (!isRecord(raw)) throw new Error("Go adapter input must be an object");
  const manifest = parseGoReleaseManifest(raw.manifest ?? raw);
  return {
    manifest,
    artifacts: parseArtifactFilesInputs(raw.artifacts, "artifacts"),
    previousArtifacts:
      raw.previousArtifacts === undefined
        ? undefined
        : parseArtifactFilesInputs(raw.previousArtifacts, "previousArtifacts"),
    metadata: Array.isArray(raw.metadata)
      ? raw.metadata.filter((entry): entry is string => typeof entry === "string")
      : undefined,
  };
}

/**
 * Parse the `{module}@{version}/` root every Go module zip carries. All files
 * must share the same root; a zip with inconsistent roots yields `null` (fail
 * toward `metadata-missing`).
 */
export function parseGoModuleZipRoot(
  files: FileRecord[],
): { modulePath: string; version: string } | null {
  let root: string | null = null;
  for (const file of files) {
    const at = file.path.indexOf("@");
    if (at <= 0) return null;
    const slash = file.path.indexOf("/", at);
    if (slash < 0) return null;
    const candidate = file.path.slice(0, slash);
    if (root === null) root = candidate;
    else if (root !== candidate) return null;
  }
  if (!root) return null;
  const at = root.lastIndexOf("@");
  const modulePath = root.slice(0, at);
  const version = root.slice(at + 1);
  if (!isValidGoModulePath(modulePath) || !isValidGoVersion(version)) return null;
  return { modulePath, version };
}

/** Line-oriented reader for the facts the rules need from `go.mod`. */
export function parseGoModFile(text: string): Pick<GoModuleSummary, "modulePath"> & {
  replaceDirectives: string[];
} {
  let modulePath: string | null = null;
  const replaceDirectives: string[] = [];
  let inReplaceBlock = false;
  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    if (inReplaceBlock) {
      if (line === ")") inReplaceBlock = false;
      else replaceDirectives.push(line);
      continue;
    }
    const moduleMatch = /^module\s+("?)([^\s"]+)\1$/.exec(line);
    if (moduleMatch && modulePath === null) {
      modulePath = moduleMatch[2];
      continue;
    }
    if (/^replace\s*\($/.test(line)) {
      inReplaceBlock = true;
      continue;
    }
    const replaceMatch = /^replace\s+(.+)$/.exec(line);
    if (replaceMatch) replaceDirectives.push(replaceMatch[1].trim());
  }
  return { modulePath, replaceDirectives };
}
