import { decodeHTMLAttribute } from "entities";
import { hasAsciiControlCharacter, isRecord } from "../../platform/guards";
import {
  decodeUrlPathForArchiveLookup,
  encodeArchiveLookupPathForUrl,
  isSafeManifestPath,
} from "../../platform/path-safety";
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

// Common WebExtension/store grammar. Individual stores may impose narrower
// component bounds, but descriptive prerelease text belongs in version_name.
const BROWSER_VERSION_RE = /^(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){0,3}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const GECKO_EMAIL_ID_RE = /^[A-Za-z0-9._-]*@[A-Za-z0-9._-]+$/;
const GECKO_GUID_ID_RE = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i;
const GECKO_EMAIL_ID_MAX_LENGTH = 80;
const LOCALIZED_MESSAGE_NAME_RE = /^__MSG_([A-Za-z0-9_@]+)__$/i;
const DEFAULT_LOCALE_RE = /^[A-Za-z0-9_@-]{1,64}$/;
const HTML_TEXT_ONLY_ELEMENTS = new Set(["script", "style", "textarea", "title"]);

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

  const name = browserExtensionDisplayName(raw, files);
  const version = typeof raw.version === "string" ? raw.version : "";
  if (!BROWSER_VERSION_RE.test(version)) throw new Error("manifest.json version is invalid");
  if (raw.manifest_version !== 2 && raw.manifest_version !== 3) {
    throw new Error("manifest.json manifest_version must be 2 or 3");
  }

  const extensionId = geckoExtensionId(raw, raw.manifest_version);
  const background = isRecord(raw.background) ? raw.background : {};
  const declaredBackgroundPage =
    typeof background.page === "string"
      ? (manifestResourcePaths([background.page])[0] ?? null)
      : null;
  const declaredBackgroundEntrypoints = manifestResourcePaths([
    ...(typeof background.service_worker === "string" ? [background.service_worker] : []),
    ...stringList(background.scripts),
    ...(typeof background.page === "string" ? [background.page] : []),
  ]);
  const backgroundConsumers = backgroundConsumerEntrypoints(
    files,
    declaredBackgroundEntrypoints,
    declaredBackgroundPage,
  );
  const extensionPageConsumers = htmlPageConsumerEntrypoints(
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
      contentScriptEntrypoints: manifestResourcePaths(nestedStringList(raw.content_scripts, "js")),
      userScriptEntrypoints,
      externallyConnectableMatches: isRecord(raw.externally_connectable)
        ? stringList(raw.externally_connectable.matches)
        : [],
      externallyConnectableIds: isRecord(raw.externally_connectable)
        ? stringList(raw.externally_connectable.ids)
        : [],
      backgroundEntrypoints: backgroundConsumers.entrypoints,
      extensionPageEntrypoints: extensionPageConsumers.entrypoints,
      consumerDocumentBaseUrlsByPath: mergeDocumentBaseUrlsByPath(
        backgroundConsumers.documentBaseUrlsByPath,
        extensionPageConsumers.documentBaseUrlsByPath,
      ),
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
  const version = typeof value.version === "string" ? value.version : "";
  if (!BROWSER_VERSION_RE.test(version)) throw new Error("manifest version is invalid");
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

function browserExtensionDisplayName(raw: Record<string, unknown>, files: FileRecord[]): string {
  const name = safeIdentityText(raw.name, "manifest.json name", 128);
  const localized = LOCALIZED_MESSAGE_NAME_RE.exec(name);
  if (!localized) return name;

  const defaultLocale = typeof raw.default_locale === "string" ? raw.default_locale.trim() : "";
  if (!DEFAULT_LOCALE_RE.test(defaultLocale)) {
    throw new Error("manifest.json localized name requires a valid default_locale");
  }
  const messagesPath = `_locales/${defaultLocale}/messages.json`;
  const messagesFile = files.find((file) => file.path === messagesPath && file.textSample);
  if (!messagesFile?.textSample) {
    throw new Error(`browser extension must include ${messagesPath} for its localized name`);
  }
  const messages = parseBrowserManifestJson(messagesFile.textSample);
  if (!isRecord(messages)) throw new Error(`${messagesPath} must be an object`);
  const messageName = localized[1].toLowerCase();
  const messageKey = Object.keys(messages).find((key) => key.toLowerCase() === messageName);
  const message = messageKey ? messages[messageKey] : null;
  if (!isRecord(message)) {
    throw new Error(`${messagesPath} does not define localized name ${localized[1]}`);
  }
  return safeIdentityText(message.message, `${messagesPath} localized name`, 128);
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

function manifestResourcePaths(paths: Array<string | null>): string[] {
  return paths.flatMap((path) => {
    if (path === null) return [];
    const resolved = resolveExtensionRootResourcePath(path);
    return resolved === null ? [] : [resolved];
  });
}

function manifestExtensionPagePaths(raw: Record<string, unknown>): string[] {
  return manifestResourcePaths([
    manifestRecordString(raw.action, "default_popup"),
    manifestRecordString(raw.browser_action, "default_popup"),
    manifestRecordString(raw.page_action, "default_popup"),
    manifestRecordString(raw.options_ui, "page"),
    manifestRecordString(raw.side_panel, "default_path"),
    manifestRecordString(raw.sidebar_action, "default_panel"),
    typeof raw.options_page === "string" ? raw.options_page : null,
    typeof raw.devtools_page === "string" ? raw.devtools_page : null,
    ...manifestRecordStrings(raw.chrome_url_overrides),
    ...(isRecord(raw.sandbox) ? stringList(raw.sandbox.pages) : []),
  ]);
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
): HtmlPageConsumers {
  const entrypoints = new Set(declaredEntrypoints);
  let documentBaseUrlsByPath: Record<string, string[]> = {};
  if (backgroundPage) {
    const pageConsumers = htmlPageConsumerEntrypoints(files, [backgroundPage]);
    for (const path of pageConsumers.entrypoints) {
      entrypoints.add(path);
    }
    documentBaseUrlsByPath = pageConsumers.documentBaseUrlsByPath;
  }
  return { entrypoints: [...entrypoints], documentBaseUrlsByPath };
}

interface HtmlPageConsumers {
  entrypoints: string[];
  documentBaseUrlsByPath: Record<string, string[]>;
}

function htmlPageConsumerEntrypoints(files: FileRecord[], pagePaths: string[]): HtmlPageConsumers {
  const entrypoints = new Set(pagePaths);
  const documentBaseUrlsByPath = new Map<string, Set<string>>();
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const inspectedPages = new Set<string>();
  const pageQueue: Array<{
    pagePath: string;
    inlineHtml?: string;
    fallbackBaseUrl?: string;
  }> = pagePaths.map((pagePath) => ({ pagePath }));
  while (pageQueue.length) {
    const queuedPage = pageQueue.pop();
    if (!queuedPage) continue;
    const { pagePath, inlineHtml, fallbackBaseUrl } = queuedPage;
    if (inlineHtml === undefined) {
      if (inspectedPages.has(pagePath)) continue;
      inspectedPages.add(pagePath);
    }
    const html = inlineHtml ?? filesByPath.get(pagePath)?.textSample;
    if (!html) continue;
    for (const consumer of htmlConsumerSources(html)) {
      if (consumer.kind === "inline-page") {
        const documentBase = extensionDocumentBaseUrl(pagePath, consumer.baseHref, fallbackBaseUrl);
        if (documentBase) {
          pageQueue.push({
            pagePath,
            inlineHtml: consumer.html,
            fallbackBaseUrl: documentBase.href,
          });
        }
        continue;
      }
      const { kind, source, baseHref } = consumer;
      const documentBase = extensionDocumentBaseUrl(pagePath, baseHref, fallbackBaseUrl);
      if (!documentBase) continue;
      const path = resolveExtensionResourcePath(source, documentBase);
      if (!path) continue;
      entrypoints.add(path);
      if (kind === "script") {
        const bases = documentBaseUrlsByPath.get(path) ?? new Set<string>();
        bases.add(documentBase.href);
        documentBaseUrlsByPath.set(path, bases);
      }
      if (kind === "page" && !inspectedPages.has(path)) pageQueue.push({ pagePath: path });
    }
  }
  return {
    entrypoints: [...entrypoints],
    documentBaseUrlsByPath: Object.fromEntries(
      [...documentBaseUrlsByPath].map(([path, bases]) => [path, [...bases]]),
    ),
  };
}

export function browserHtmlConsumerDependencies(
  files: FileRecord[],
  pagePath: string,
): Array<{ path: string; documentBaseUrl?: string }> {
  const consumers = htmlPageConsumerEntrypoints(files, [pagePath]);
  return consumers.entrypoints.flatMap((path) => {
    const bases = consumers.documentBaseUrlsByPath[path];
    return bases?.length ? bases.map((documentBaseUrl) => ({ path, documentBaseUrl })) : [{ path }];
  });
}

function mergeDocumentBaseUrlsByPath(
  ...values: Array<Record<string, string[]>>
): Record<string, string[]> {
  const merged = new Map<string, Set<string>>();
  for (const value of values) {
    for (const [path, urls] of Object.entries(value)) {
      const bases = merged.get(path) ?? new Set<string>();
      for (const url of urls) bases.add(url);
      merged.set(path, bases);
    }
  }
  return Object.fromEntries([...merged].map(([path, bases]) => [path, [...bases]]));
}

type HtmlConsumerSource =
  | { kind: "script" | "page"; source: string; baseHref: string | null }
  | { kind: "inline-page"; html: string; baseHref: string | null };

function htmlConsumerSources(html: string): HtmlConsumerSource[] {
  const sources: HtmlConsumerSource[] = [];
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
      (!HTML_TEXT_ONLY_ELEMENTS.has(tagName) &&
        tagName !== "base" &&
        tagName !== "embed" &&
        tagName !== "frame" &&
        tagName !== "iframe" &&
        tagName !== "meta" &&
        tagName !== "object") ||
      !/[\s/>]/.test(html[cursor] ?? "")
    ) {
      index = Math.max(cursor, tagStart + 1);
      continue;
    }

    const targetAttribute =
      tagName === "base"
        ? "href"
        : tagName === "object"
          ? "data"
          : tagName === "meta"
            ? null
            : "src";
    let targetValue: string | null = null;
    let targetSeen = false;
    let metaHttpEquiv: string | null = null;
    let metaContent: string | null = null;
    let srcdocValue: string | null = null;
    let srcdocSeen = false;
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

      if (targetAttribute !== null && attributeName === targetAttribute && !targetSeen) {
        targetSeen = true;
        targetValue = value;
      }
      if (tagName === "meta" && attributeName === "http-equiv" && metaHttpEquiv === null) {
        metaHttpEquiv = decodeHTMLAttribute(value ?? "");
      }
      if (tagName === "meta" && attributeName === "content" && metaContent === null) {
        metaContent = decodeHTMLAttribute(value ?? "");
      }
      if (tagName === "iframe" && attributeName === "srcdoc" && !srcdocSeen) {
        srcdocSeen = true;
        srcdocValue = value;
      }
    }
    if (tagClosed && tagName === "base" && targetSeen && !baseSeen) {
      baseHref = decodeHTMLAttribute(targetValue ?? "");
      baseSeen = true;
    } else if (tagClosed && tagName === "iframe" && srcdocSeen) {
      sources.push({
        kind: "inline-page",
        html: decodeHTMLAttribute(srcdocValue ?? ""),
        baseHref,
      });
    } else if (
      tagClosed &&
      tagName === "meta" &&
      metaHttpEquiv?.trim().toLowerCase() === "refresh"
    ) {
      const refreshUrl = metaRefreshUrl(metaContent ?? "");
      if (refreshUrl) sources.push({ kind: "page", source: refreshUrl, baseHref });
    } else if (
      tagClosed &&
      (tagName === "script" ||
        tagName === "embed" ||
        tagName === "frame" ||
        tagName === "iframe" ||
        tagName === "object") &&
      targetValue
    ) {
      sources.push({
        kind: tagName === "script" ? "script" : "page",
        source: decodeHTMLAttribute(targetValue),
        baseHref,
      });
    }
    if (tagClosed && HTML_TEXT_ONLY_ELEMENTS.has(tagName)) {
      // Raw-text and escapable raw-text contents do not create nested elements.
      // Skip them so tag-shaped CSS, JavaScript, titles, and textarea values
      // cannot invent consumer edges or document bases.
      const closingTextElementPattern = new RegExp(`</${tagName}(?=[\\s/>])`, "gi");
      closingTextElementPattern.lastIndex = cursor;
      const closingTextElement = closingTextElementPattern.exec(html);
      if (!closingTextElement) {
        index = html.length;
        continue;
      }
      const closingTagEnd = html.indexOf(
        ">",
        closingTextElement.index + closingTextElement[0].length,
      );
      index = closingTagEnd === -1 ? html.length : closingTagEnd + 1;
      continue;
    }
    index = Math.max(cursor, tagStart + 1);
  }
  return sources;
}

function metaRefreshUrl(content: string): string | null {
  const match = /^\s*\d+\s*;\s*url\s*=\s*(.*?)\s*$/i.exec(content);
  if (!match) return null;
  const value = match[1];
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1).trim() || null;
  }
  return value || null;
}

const EXTENSION_RESOURCE_ROOT = new URL("drydock-extension://artifact/");

function resolveExtensionRootResourcePath(rawPath: string): string | null {
  const source = rawPath.trim();
  if (!source || source.includes("\\")) return null;
  try {
    const resolved = new URL(source, EXTENSION_RESOURCE_ROOT);
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

function extensionDocumentBaseUrl(
  pagePath: string,
  rawBaseHref: string | null,
  rawFallbackBaseUrl?: string,
): URL | null {
  const baseHref = rawBaseHref?.trim() ?? null;
  if (baseHref?.includes("\\")) return null;
  try {
    // pagePath is already decoded for archive lookup. Re-encode each path
    // segment before URL resolution so a literal archive `#`, `?`, or `%` does
    // not become URL syntax and change the document base.
    const encodedPagePath = encodeArchiveLookupPathForUrl(pagePath);
    const pageUrl = new URL(encodedPagePath, EXTENSION_RESOURCE_ROOT);
    const fallbackBaseUrl = rawFallbackBaseUrl ? new URL(rawFallbackBaseUrl) : pageUrl;
    if (
      fallbackBaseUrl.protocol !== EXTENSION_RESOURCE_ROOT.protocol ||
      fallbackBaseUrl.host !== EXTENSION_RESOURCE_ROOT.host
    ) {
      return null;
    }
    let documentBase = fallbackBaseUrl;
    if (baseHref !== null) {
      try {
        documentBase = new URL(baseHref, fallbackBaseUrl);
      } catch {
        // The HTML base-element algorithm falls back to the document URL when
        // its href cannot be parsed; later relative resources still load.
      }
    }
    return documentBase.protocol === EXTENSION_RESOURCE_ROOT.protocol &&
      documentBase.host === EXTENSION_RESOURCE_ROOT.host
      ? documentBase
      : null;
  } catch {
    return null;
  }
}

function resolveExtensionResourcePath(rawSource: string, documentBase: URL): string | null {
  const source = rawSource.trim();
  if (!source || source.includes("\\")) return null;
  try {
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
