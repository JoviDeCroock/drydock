import { decodeHTMLAttribute } from "entities";
import { hasAsciiControlCharacter, isRecord } from "../../platform/guards";
import { decodeUrlPathForArchiveLookup, isSafeManifestPath } from "../../platform/path-safety";
import type { FileRecord, PackageJsonSummary } from "../../review";
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
const GECKO_EMAIL_ID_RE = /^[A-Za-z0-9._-]*@[A-Za-z0-9._-]+$/;
const GECKO_GUID_ID_RE = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i;
const GECKO_EMAIL_ID_MAX_LENGTH = 80;

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
  const raw = parseBrowserManifestJson(file.textSample);
  if (!isRecord(raw)) throw new Error("browser extension manifest.json must be an object");

  const name = safeIdentityText(raw.name, "manifest.json name", 128);
  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  if (!SAFE_VERSION_RE.test(version)) throw new Error("manifest.json version is invalid");
  if (raw.manifest_version !== 2 && raw.manifest_version !== 3) {
    throw new Error("manifest.json manifest_version must be 2 or 3");
  }

  const extensionId = geckoExtensionId(raw, raw.manifest_version);
  const background = isRecord(raw.background) ? raw.background : {};
  const declaredBackgroundPage =
    typeof background.page === "string"
      ? (manifestResourcePaths([background.page], { trimLeadingSlash: true })[0] ?? null)
      : null;
  const declaredBackgroundEntrypoints = manifestResourcePaths(
    [
      ...(typeof background.service_worker === "string" ? [background.service_worker] : []),
      ...stringList(background.scripts),
      ...(typeof background.page === "string" ? [background.page] : []),
    ],
    { trimLeadingSlash: true },
  );
  const backgroundEntrypoints = backgroundConsumerEntrypoints(
    files,
    declaredBackgroundEntrypoints,
    declaredBackgroundPage,
  );
  const extensionPageEntrypoints = htmlPageConsumerEntrypoints(
    files,
    manifestExtensionPagePaths(raw),
  );
  const userScriptEntrypoints =
    raw.manifest_version === 2 && isRecord(raw.user_scripts)
      ? manifestResourcePaths([manifestRecordString(raw.user_scripts, "api_script")])
      : [];
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
      contentScriptEntrypoints: manifestResourcePaths(nestedStringList(raw.content_scripts, "js"), {
        trimLeadingSlash: true,
      }),
      userScriptEntrypoints,
      externallyConnectableMatches: isRecord(raw.externally_connectable)
        ? stringList(raw.externally_connectable.matches)
        : [],
      externallyConnectableIds: isRecord(raw.externally_connectable)
        ? stringList(raw.externally_connectable.ids)
        : [],
      backgroundEntrypoints,
      extensionPageEntrypoints,
      contentSecurityPolicy,
    },
  };
}

/** Stable extension ID when present, otherwise the manifest's display label. */
export function browserExtensionCandidateName(manifest: BrowserExtensionManifest): string {
  return manifest.extensionId ?? manifest.name;
}

export function packageJsonSummaryForBrowser(
  manifest: BrowserExtensionManifest,
): PackageJsonSummary {
  return {
    name: browserExtensionCandidateName(manifest),
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

function geckoExtensionId(raw: Record<string, unknown>, manifestVersion: 2 | 3): string | null {
  const browserSettings = isRecord(raw.browser_specific_settings)
    ? raw.browser_specific_settings
    : null;
  const legacyApplications =
    manifestVersion === 2 && isRecord(raw.applications) ? raw.applications : null;
  const gecko = isRecord(browserSettings?.gecko)
    ? browserSettings.gecko
    : isRecord(legacyApplications?.gecko)
      ? legacyApplications.gecko
      : null;
  if (!gecko || typeof gecko.id !== "string") return null;

  const extensionId = gecko.id;
  if (!extensionId || hasAsciiControlCharacter(extensionId)) return null;
  if (GECKO_GUID_ID_RE.test(extensionId)) return extensionId;
  return extensionId.length <= GECKO_EMAIL_ID_MAX_LENGTH && GECKO_EMAIL_ID_RE.test(extensionId)
    ? extensionId
    : null;
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

function manifestResourcePaths(
  paths: Array<string | null>,
  options: { trimLeadingSlash?: boolean } = {},
): string[] {
  return paths.flatMap((path) => {
    if (path === null) return [];
    const normalized = options.trimLeadingSlash && path.startsWith("/") ? path.slice(1) : path;
    return isSafeManifestPath(normalized) ? [normalized] : [];
  });
}

function manifestExtensionPagePaths(raw: Record<string, unknown>): string[] {
  return [
    manifestRecordString(raw.action, "default_popup"),
    manifestRecordString(raw.browser_action, "default_popup"),
    manifestRecordString(raw.page_action, "default_popup"),
    manifestRecordString(raw.options_ui, "page"),
    manifestRecordString(raw.side_panel, "default_path"),
    manifestRecordString(raw.sidebar_action, "default_panel"),
    typeof raw.options_page === "string" ? raw.options_page : null,
    typeof raw.devtools_page === "string" ? raw.devtools_page : null,
    ...manifestRecordStrings(raw.chrome_url_overrides),
  ].filter((path): path is string => path !== null && isSafeManifestPath(path));
}

function manifestRecordString(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  return typeof value[key] === "string" ? value[key] : null;
}

function manifestRecordStrings(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.values(value).filter((item): item is string => typeof item === "string");
}

function parseBrowserManifestJson(text: string): unknown | null {
  try {
    return JSON.parse(stripJsonLineComments(text));
  } catch {
    return null;
  }
}

// Firefox accepts line comments in manifest.json. Strip only comments outside
// JSON strings, preserving newlines and character positions for finding lines.
function stripJsonLineComments(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      output += "  ";
      index += 2;
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") {
        output += " ";
        index += 1;
      }
      if (index < text.length) output += text[index];
      continue;
    }
    output += character;
  }
  return output;
}

function backgroundConsumerEntrypoints(
  files: FileRecord[],
  declaredEntrypoints: string[],
  backgroundPage: string | null,
): string[] {
  const entrypoints = new Set(declaredEntrypoints);
  if (backgroundPage) {
    for (const path of htmlPageConsumerEntrypoints(files, [backgroundPage])) {
      entrypoints.add(path);
    }
  }
  return [...entrypoints];
}

function htmlPageConsumerEntrypoints(files: FileRecord[], pagePaths: string[]): string[] {
  const entrypoints = new Set(pagePaths);
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const inspectedPages = new Set<string>();
  const pageQueue = [...pagePaths];
  while (pageQueue.length) {
    const pagePath = pageQueue.pop();
    if (!pagePath || inspectedPages.has(pagePath)) continue;
    inspectedPages.add(pagePath);
    const page = filesByPath.get(pagePath);
    if (!page?.textSample) continue;
    for (const { kind, source, baseHref } of htmlConsumerSources(page.textSample)) {
      const path = resolveExtensionResourcePath(pagePath, source, baseHref);
      if (!path) continue;
      entrypoints.add(path);
      if (kind === "page" && !inspectedPages.has(path)) pageQueue.push(path);
    }
  }
  return [...entrypoints];
}

function htmlConsumerSources(
  html: string,
): Array<{ kind: "script" | "page"; source: string; baseHref: string | null }> {
  const sources: Array<{
    kind: "script" | "page";
    source: string;
    baseHref: string | null;
  }> = [];
  const closingScriptPattern = /<\/script(?=[\s/>])/gi;
  let baseHref: string | null = null;
  let baseSeen = false;
  let index = 0;
  while (index < html.length) {
    const tagStart = html.indexOf("<", index);
    if (tagStart === -1) break;
    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);
      index = commentEnd === -1 ? html.length : commentEnd + 3;
      continue;
    }

    let cursor = tagStart + 1;
    const nameStart = cursor;
    while (cursor < html.length && /[A-Za-z0-9:-]/.test(html[cursor])) cursor += 1;
    const tagName = html.slice(nameStart, cursor).toLowerCase();
    if (
      (tagName !== "script" && tagName !== "base" && tagName !== "iframe") ||
      !/[\s/>]/.test(html[cursor] ?? "")
    ) {
      index = Math.max(cursor, tagStart + 1);
      continue;
    }

    const targetAttribute = tagName === "base" ? "href" : "src";
    let targetValue: string | null = null;
    let targetSeen = false;
    let tagClosed = false;
    while (cursor < html.length) {
      while (/\s/.test(html[cursor] ?? "")) cursor += 1;
      if (html[cursor] === ">") {
        cursor += 1;
        tagClosed = true;
        break;
      }
      if (html[cursor] === "/" && html[cursor + 1] === ">") {
        cursor += 2;
        tagClosed = true;
        break;
      }

      const attributeStart = cursor;
      while (cursor < html.length && !/[\s=/>]/.test(html[cursor])) cursor += 1;
      if (cursor === attributeStart) {
        cursor += 1;
        continue;
      }
      const attributeName = html.slice(attributeStart, cursor).toLowerCase();
      while (/\s/.test(html[cursor] ?? "")) cursor += 1;

      let value: string | null = null;
      if (html[cursor] === "=") {
        cursor += 1;
        while (/\s/.test(html[cursor] ?? "")) cursor += 1;
        const quote = html[cursor];
        if (quote === '"' || quote === "'") {
          cursor += 1;
          const valueStart = cursor;
          while (cursor < html.length && html[cursor] !== quote) cursor += 1;
          if (cursor >= html.length) break;
          value = html.slice(valueStart, cursor);
          cursor += 1;
        } else {
          const valueStart = cursor;
          while (cursor < html.length && !/[\s>]/.test(html[cursor])) cursor += 1;
          value = html.slice(valueStart, cursor);
        }
      }

      if (attributeName === targetAttribute && !targetSeen) {
        targetSeen = true;
        targetValue = value;
      }
    }
    if (tagClosed && tagName === "base" && targetSeen && !baseSeen) {
      baseHref = decodeHTMLAttribute(targetValue ?? "");
      baseSeen = true;
    } else if (tagClosed && (tagName === "script" || tagName === "iframe") && targetValue) {
      sources.push({
        kind: tagName === "iframe" ? "page" : "script",
        source: decodeHTMLAttribute(targetValue),
        baseHref,
      });
    }
    if (tagClosed && tagName === "script") {
      // Script data is raw text in HTML. A base-looking string inside JavaScript
      // must not become the document base for a later packaged script.
      closingScriptPattern.lastIndex = cursor;
      const closingScript = closingScriptPattern.exec(html);
      if (!closingScript) {
        index = html.length;
        continue;
      }
      const closingTagEnd = html.indexOf(">", closingScript.index + closingScript[0].length);
      index = closingTagEnd === -1 ? html.length : closingTagEnd + 1;
      continue;
    }
    index = Math.max(cursor, tagStart + 1);
  }
  return sources;
}

const EXTENSION_RESOURCE_ROOT = new URL("drydock-extension://artifact/");

function resolveExtensionResourcePath(
  pagePath: string,
  rawSource: string,
  rawBaseHref: string | null,
): string | null {
  const source = rawSource.trim();
  const baseHref = rawBaseHref?.trim() ?? null;
  if (!source || source.includes("\\") || baseHref?.includes("\\")) return null;
  try {
    const pageUrl = new URL(pagePath, EXTENSION_RESOURCE_ROOT);
    const documentBase = baseHref === null ? pageUrl : new URL(baseHref, pageUrl);
    const resolved = new URL(source, documentBase);
    if (
      resolved.protocol !== EXTENSION_RESOURCE_ROOT.protocol ||
      resolved.host !== EXTENSION_RESOURCE_ROOT.host
    ) {
      return null;
    }
    const path = decodeUrlPathForArchiveLookup(resolved.pathname.replace(/^\/+/, ""));
    return isSafeManifestPath(path) ? path : null;
  } catch {
    return null;
  }
}

function assertUniqueBrowserPaths(files: FileRecord[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path))
      throw new Error(`browser extension contains duplicate path ${file.path}`);
    seen.add(file.path);
  }
}
