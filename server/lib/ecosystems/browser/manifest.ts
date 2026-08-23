import { hasAsciiControlCharacter, isRecord } from "../../platform/guards";
import { isSafeManifestPath } from "../../platform/path-safety";
import type { FileRecord, PackageJsonSummary } from "../../review";
import { safeJson } from "../../review/rules";
import type { TarSuspiciousEntry } from "../../tar-parser.js";
import {
  BROWSER_RELEASE_MANIFEST_SCHEMA,
  type BrowserAdapterInput,
  type BrowserArtifactInput,
  type BrowserArtifactKind,
  type BrowserExtensionManifest,
  type BrowserReleaseManifest,
} from "./types";

const SAFE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;

export function inferBrowserArtifactKind(path: string): BrowserArtifactKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".xpi")) return "xpi";
  if (lower.endsWith(".zip")) return "zip";
  return null;
}

export function findBrowserManifestFile(files: FileRecord[]): FileRecord | null {
  return files.find((file) => file.path === "manifest.json" && file.textSample) ?? null;
}

export function parseBrowserExtensionManifest(files: FileRecord[]): {
  file: FileRecord;
  manifest: BrowserExtensionManifest;
} {
  assertUniqueBrowserPaths(files);
  const file = findBrowserManifestFile(files);
  if (!file?.textSample) throw new Error("browser extension must include a root manifest.json");
  const raw = safeJson(file.textSample);
  if (!isRecord(raw)) throw new Error("browser extension manifest.json must be an object");

  const name = safeIdentityText(raw.name, "manifest.json name", 128);
  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  if (!SAFE_VERSION_RE.test(version)) throw new Error("manifest.json version is invalid");
  if (raw.manifest_version !== 2 && raw.manifest_version !== 3) {
    throw new Error("manifest.json manifest_version must be 2 or 3");
  }

  const extensionId = geckoExtensionId(raw);
  const background = isRecord(raw.background) ? raw.background : {};
  const backgroundEntrypoints = [
    ...(typeof background.service_worker === "string" ? [background.service_worker] : []),
    ...stringList(background.scripts),
    ...(typeof background.page === "string" ? [background.page] : []),
  ].filter(isSafeManifestPath);
  const csp = raw.content_security_policy;
  const contentSecurityPolicy =
    typeof csp === "string"
      ? csp
      : isRecord(csp) && typeof csp.extension_pages === "string"
        ? csp.extension_pages
        : null;

  return {
    file,
    manifest: {
      name,
      version,
      manifestVersion: raw.manifest_version,
      extensionId,
      permissions: stringList(raw.permissions),
      optionalPermissions: stringList(raw.optional_permissions),
      hostPermissions: stringList(raw.host_permissions),
      optionalHostPermissions: stringList(raw.optional_host_permissions),
      contentScriptMatches: nestedStringList(raw.content_scripts, "matches"),
      contentScriptEntrypoints: nestedStringList(raw.content_scripts, "js").filter(
        isSafeManifestPath,
      ),
      externallyConnectableMatches: isRecord(raw.externally_connectable)
        ? stringList(raw.externally_connectable.matches)
        : [],
      backgroundEntrypoints,
      contentSecurityPolicy,
    },
  };
}

export function browserExtensionIdentity(manifest: BrowserExtensionManifest): string {
  return manifest.extensionId ?? manifest.name;
}

export function packageJsonSummaryForBrowser(
  manifest: BrowserExtensionManifest,
): PackageJsonSummary {
  return {
    name: browserExtensionIdentity(manifest),
    version: manifest.version,
  };
}

export function buildBrowserReleaseManifest(
  extensionId: string,
  version: string,
  artifacts: Array<{ path: string; sha256: string }>,
): BrowserReleaseManifest {
  return parseBrowserReleaseManifest({
    schema: BROWSER_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "browser",
    package: extensionId,
    version,
    artifacts,
  });
}

function parseBrowserReleaseManifest(value: unknown): BrowserReleaseManifest {
  if (!isRecord(value)) throw new Error("manifest must be an object");
  if (value.schema !== BROWSER_RELEASE_MANIFEST_SCHEMA) {
    throw new Error(`manifest schema must be ${BROWSER_RELEASE_MANIFEST_SCHEMA}`);
  }
  if (value.ecosystem !== "browser") throw new Error("manifest ecosystem must be browser");
  const packageName = safeIdentityText(value.package, "manifest package", 255);
  const version = typeof value.version === "string" ? value.version.trim() : "";
  if (!SAFE_VERSION_RE.test(version)) throw new Error("manifest version is not safe");
  if (!Array.isArray(value.artifacts) || value.artifacts.length !== 1) {
    throw new Error("manifest must include exactly one browser extension artifact");
  }
  const artifact = value.artifacts[0];
  if (!isRecord(artifact)) throw new Error("artifact must be an object");
  const path = typeof artifact.path === "string" ? artifact.path : "";
  const kind = inferBrowserArtifactKind(path);
  if (!isSafeManifestPath(path) || !kind) {
    throw new Error("artifact path must be a safe .zip or .xpi path");
  }
  const sha256 = typeof artifact.sha256 === "string" ? artifact.sha256 : "";
  if (!SHA256_RE.test(sha256)) throw new Error("artifact sha256 must be a hex SHA-256 digest");
  return {
    schema: BROWSER_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "browser",
    package: packageName,
    version,
    artifacts: [{ path, sha256: sha256.toLowerCase(), kind }],
  };
}

export function parseBrowserAdapterInput(raw: unknown): BrowserAdapterInput {
  if (!isRecord(raw)) throw new Error("browser adapter input must be an object");
  const manifest = parseBrowserReleaseManifest(raw.manifest ?? raw);
  const artifact = parseBrowserArtifactInput(raw.artifact, "artifact");
  const declaredArtifact = manifest.artifacts[0];
  if (artifact.path !== declaredArtifact.path) {
    throw new Error("artifact.path must match the release manifest artifact path");
  }
  if (artifact.sha256 !== declaredArtifact.sha256) {
    throw new Error("artifact.sha256 must match the release manifest artifact digest");
  }
  return {
    manifest,
    artifact,
    previousArtifact:
      raw.previousArtifact === undefined
        ? undefined
        : parseBrowserArtifactInput(raw.previousArtifact, "previousArtifact"),
  };
}

function parseBrowserArtifactInput(raw: unknown, field: string): BrowserArtifactInput {
  if (!isRecord(raw)) throw new Error(`${field} must be an object`);
  const path = typeof raw.path === "string" ? raw.path : "";
  if (!isSafeManifestPath(path) || !inferBrowserArtifactKind(path)) {
    throw new Error(`${field}.path must be a safe .zip or .xpi path`);
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

function parseFileRecord(raw: unknown, field: string, index: number): FileRecord {
  if (!isRecord(raw)) throw new Error(`${field}.files[${index}] must be an object`);
  return {
    path: typeof raw.path === "string" ? raw.path : "",
    size: typeof raw.size === "number" ? raw.size : 0,
    sha256: typeof raw.sha256 === "string" ? raw.sha256 : "",
    flags: Array.isArray(raw.flags)
      ? raw.flags.filter((flag): flag is string => typeof flag === "string")
      : [],
    ...(typeof raw.textSample === "string" ? { textSample: raw.textSample } : {}),
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

function safeIdentityText(value: unknown, field: string, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maxLength || hasAsciiControlCharacter(text)) {
    throw new Error(`${field} is invalid`);
  }
  return text;
}

function geckoExtensionId(raw: Record<string, unknown>): string | null {
  const settings = isRecord(raw.browser_specific_settings)
    ? raw.browser_specific_settings
    : isRecord(raw.applications)
      ? raw.applications
      : {};
  const gecko = isRecord(settings.gecko) ? settings.gecko : {};
  if (gecko.id === undefined) return null;
  return safeIdentityText(gecko.id, "manifest.json Gecko extension id", 255);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function nestedStringList(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (isRecord(item) ? stringList(item[key]) : []));
}

function assertUniqueBrowserPaths(files: FileRecord[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path))
      throw new Error(`browser extension contains duplicate path ${file.path}`);
    seen.add(file.path);
  }
}
