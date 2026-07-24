import type { FileRecord, PackageJsonSummary } from "../../review";
import { safeJson } from "../../review-rules";
import type { TarSuspiciousEntry } from "../../tar-parser.js";
import {
  VSCODE_RELEASE_MANIFEST_SCHEMA,
  type VscodeAdapterInput,
  type VscodeArtifactInput,
  type VscodeExtensionManifest,
  type VscodeReleaseManifest,
} from "./types";

// Case-insensitive to match vsce's own name validation: grandfathered
// Marketplace extensions keep capitalized names (golang.Go, ms-vscode.PowerShell).
const SAFE_EXTENSION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,127}$/i;
const SAFE_PUBLISHER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;

export function inferVscodeArtifactKind(path: string): "vsix" | null {
  return path.toLowerCase().endsWith(".vsix") ? "vsix" : null;
}

export function extensionIdFromManifest(
  manifest: Pick<VscodeExtensionManifest, "publisher" | "name">,
): string {
  return `${manifest.publisher}.${manifest.name}`;
}

export function normalizeVsixFiles(files: FileRecord[]): FileRecord[] {
  return files
    .map((file) => {
      // VSIX ZIPs store the installed extension payload under `extension/`.
      // Container-level metadata must not shadow payload paths after stripping.
      if (!file.path.startsWith("extension/")) return null;
      const path = file.path.slice("extension/".length);
      return path ? { ...file, path } : null;
    })
    .filter((file): file is FileRecord => file !== null);
}

export function findVscodeManifestFile(files: FileRecord[]): FileRecord | null {
  return files.find((file) => file.path === "package.json" && file.textSample) ?? null;
}

export function parseVscodeExtensionManifest(files: FileRecord[]): {
  file: FileRecord;
  manifest: VscodeExtensionManifest;
} {
  assertUniqueVscodePaths(files);
  const file = findVscodeManifestFile(files);
  if (!file?.textSample) throw new Error("VSIX artifact must include extension/package.json");
  const raw = safeJson(file.textSample);
  if (!isRecord(raw)) throw new Error("VSIX extension package.json must be an object");
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const publisher = typeof raw.publisher === "string" ? raw.publisher.trim() : "";
  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  if (!SAFE_EXTENSION_NAME_RE.test(name)) {
    throw new Error("VSIX package.json name must be alphanumeric/dash");
  }
  if (!SAFE_PUBLISHER_RE.test(publisher)) throw new Error("VSIX package.json publisher is invalid");
  if (!SAFE_VERSION_RE.test(version)) throw new Error("VSIX package.json version is invalid");

  const engines = isRecord(raw.engines) ? raw.engines : {};
  const enginesVscode = typeof engines.vscode === "string" ? engines.vscode : null;
  if (!enginesVscode || enginesVscode.trim() === "*") {
    throw new Error("VSIX package.json engines.vscode must be constrained");
  }

  return {
    file,
    manifest: {
      name,
      publisher,
      version,
      displayName: typeof raw.displayName === "string" ? raw.displayName : null,
      description: typeof raw.description === "string" ? raw.description : null,
      main: normalizeManifestPath(raw.main),
      browser: normalizeManifestPath(raw.browser),
      activationEvents: normalizeStringList(raw.activationEvents),
      extensionDependencies: normalizeStringList(raw.extensionDependencies),
      extensionPack: normalizeStringList(raw.extensionPack),
      configurationProperties: configurationProperties(raw.contributes),
      enginesVscode,
      dependencies: normalizeStringRecord(raw.dependencies),
      devDependencies: normalizeStringRecord(raw.devDependencies),
      files: normalizeOptionalStringList(raw.files),
    },
  };
}

function assertUniqueVscodePaths(files: FileRecord[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) {
      throw new Error(`VSIX artifact contains duplicate path ${file.path}`);
    }
    seen.add(file.path);
  }
}

export function packageJsonSummaryForVscode(manifest: VscodeExtensionManifest): PackageJsonSummary {
  return {
    name: extensionIdFromManifest(manifest),
    version: manifest.version,
    ...(manifest.dependencies && Object.keys(manifest.dependencies).length
      ? { dependencies: manifest.dependencies }
      : {}),
    ...(manifest.devDependencies && Object.keys(manifest.devDependencies).length
      ? { devDependencies: manifest.devDependencies }
      : {}),
    ...(manifest.files ? { files: manifest.files } : {}),
    ...(manifest.main ? { main: manifest.main } : {}),
    ...(manifest.browser ? { exports: { browser: manifest.browser } } : {}),
  };
}

export function buildVscodeReleaseManifest(
  extensionId: string,
  version: string,
  artifacts: Array<{ path: string; sha256: string }>,
): VscodeReleaseManifest {
  return parseVscodeReleaseManifest({
    schema: VSCODE_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "vscode",
    package: extensionId,
    version,
    artifacts,
  });
}

function parseVscodeReleaseManifest(value: unknown): VscodeReleaseManifest {
  if (!isRecord(value)) throw new Error("manifest must be an object");
  if (value.schema !== VSCODE_RELEASE_MANIFEST_SCHEMA) {
    throw new Error(`manifest schema must be ${VSCODE_RELEASE_MANIFEST_SCHEMA}`);
  }
  if (value.ecosystem !== "vscode") throw new Error("manifest ecosystem must be vscode");
  const packageName = String(value.package || "");
  const version = String(value.version || "");
  if (!isSafeExtensionId(packageName))
    throw new Error("manifest package is not a valid VS Code extension id");
  if (!SAFE_VERSION_RE.test(version)) throw new Error("manifest version is not safe");
  if (!Array.isArray(value.artifacts) || value.artifacts.length !== 1) {
    throw new Error("manifest must include exactly one VSIX artifact");
  }

  const artifact = value.artifacts[0];
  if (!isRecord(artifact)) throw new Error("artifact must be an object");
  const path = String(artifact.path || "");
  if (!isSafeManifestPath(path) || !inferVscodeArtifactKind(path)) {
    throw new Error("artifact path must be a safe .vsix path");
  }
  const sha256 = String(artifact.sha256 || "");
  if (!SHA256_RE.test(sha256)) throw new Error("artifact sha256 must be a hex SHA-256 digest");

  return {
    schema: VSCODE_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "vscode",
    package: packageName,
    version,
    artifacts: [{ path, sha256: sha256.toLowerCase(), kind: "vsix" }],
  };
}

export function parseVscodeAdapterInput(raw: unknown): VscodeAdapterInput {
  if (!isRecord(raw)) throw new Error("VS Code adapter input must be an object");
  return {
    manifest: parseVscodeReleaseManifest(raw.manifest ?? raw),
    artifact: parseVscodeArtifactInput(raw.artifact, "artifact"),
    previousArtifact:
      raw.previousArtifact === undefined
        ? undefined
        : parseVscodeArtifactInput(raw.previousArtifact, "previousArtifact"),
  };
}

function parseVscodeArtifactInput(raw: unknown, field: string): VscodeArtifactInput {
  if (!isRecord(raw)) throw new Error(`${field} must be an object`);
  const path = typeof raw.path === "string" ? raw.path : "";
  if (!isSafeManifestPath(path) || !inferVscodeArtifactKind(path)) {
    throw new Error(`${field}.path must be a safe .vsix path`);
  }
  const sha256 = typeof raw.sha256 === "string" ? raw.sha256 : "";
  if (!SHA256_RE.test(sha256)) throw new Error(`${field}.sha256 must be a hex SHA-256 digest`);
  if (!Array.isArray(raw.files)) throw new Error(`${field}.files must be an array`);
  return {
    path,
    sha256: sha256.toLowerCase(),
    files: raw.files.map((file, index) => parseFileRecord(file, field, index)),
    ...parseSuspiciousEntries(raw.suspiciousEntries),
  };
}

const SUSPICIOUS_ENTRY_KINDS = new Set([
  "non-regular",
  "duplicate",
  "unicode-confusable",
  "content-skipped",
  "retention-tier",
]);

function parseSuspiciousEntries(
  raw: unknown,
): { suspiciousEntries: TarSuspiciousEntry[] } | Record<string, never> {
  if (!Array.isArray(raw) || !raw.length) return {};
  const entries: TarSuspiciousEntry[] = [];
  for (const item of raw.slice(0, 5_000)) {
    if (!isRecord(item)) continue;
    if (typeof item.kind !== "string" || !SUSPICIOUS_ENTRY_KINDS.has(item.kind)) continue;
    entries.push({
      kind: item.kind as TarSuspiciousEntry["kind"],
      path: typeof item.path === "string" ? item.path : "",
      detail: typeof item.detail === "string" ? item.detail : "",
    });
  }
  return entries.length ? { suspiciousEntries: entries } : {};
}

function parseFileRecord(raw: unknown, field: string, index: number): FileRecord {
  if (!isRecord(raw)) throw new Error(`${field}.files[${index}] must be an object`);
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

function normalizeManifestPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let path = value.trim();
  while (path.startsWith("./")) path = path.slice(2);
  return isSafeManifestPath(path) ? path : null;
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function normalizeOptionalStringList(value: unknown): string[] | undefined {
  const list = normalizeStringList(value);
  return list.length ? list : undefined;
}

function configurationProperties(contributes: unknown): string[] {
  if (!isRecord(contributes)) return [];
  const configuration = contributes.configuration;
  const configs = Array.isArray(configuration)
    ? configuration
    : configuration
      ? [configuration]
      : [];
  const properties = new Set<string>();
  for (const config of configs) {
    if (!isRecord(config) || !isRecord(config.properties)) continue;
    for (const key of Object.keys(config.properties)) properties.add(key);
  }
  return [...properties].sort();
}

function isSafeExtensionId(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 2) return false;
  return SAFE_PUBLISHER_RE.test(parts[0]) && SAFE_EXTENSION_NAME_RE.test(parts[1]);
}

function isSafeManifestPath(path: string): boolean {
  if (!path || path.length > 512 || path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/") || path.startsWith("../") || path.includes("/../")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((part) => part && part !== "." && part !== "..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
