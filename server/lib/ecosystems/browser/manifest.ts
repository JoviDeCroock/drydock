import { decodeHTMLAttribute, decodeXML } from "entities";
import { SaxesParser } from "saxes";
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
const MAX_WEB_ACCESSIBLE_RESOURCE_DECLARATIONS = 10_000;
const MAX_WEB_ACCESSIBLE_RESOURCE_WILDCARD_CHECKS = 1_000_000;
const BROWSER_DOCUMENT_PATH_RE = /\.(?:html?|xml|xhtml|xht|svg)$/i;
const BROWSER_XML_DOCUMENT_PATH_RE = /\.(?:xml|xhtml|xht|svg)$/i;
// URL-valued attribute local names that can make some engine fetch, navigate
// to, or execute a packaged resource. Collected on every tag-shaped token —
// consumer-edge extraction is a deliberate over-approximation of browser
// parsing; see the doc comment on `scanDocumentConsumerTokens`.
const CONSUMER_URL_ATTRIBUTE_LOCAL_NAMES = new Set(["src", "href", "data", "action", "formaction"]);
// Benign documents declare at most one <base>. The cap only bounds hostile
// resolution work; exceeding it fails the review loudly instead of silently
// dropping a base candidate, which could hide a real consumer edge.
const MAX_DOCUMENT_BASE_CANDIDATES = 16;
const MAX_DOCUMENT_CONSUMER_RESOLUTIONS = 1_000_000;
const MAX_XML_GENERAL_ENTITIES = 1_024;
const MAX_XML_ENTITY_EXPANSION_DEPTH = 32;
const MAX_XML_ENTITY_EXPANDED_CHARACTERS = 1_000_000;

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
  const declaredBackgroundScripts = manifestResourcePaths(stringList(background.scripts));
  const declaredBackgroundEntrypoints = manifestResourcePaths([
    ...(typeof background.service_worker === "string" ? [background.service_worker] : []),
    ...declaredBackgroundScripts,
    ...(typeof background.page === "string" ? [background.page] : []),
  ]);
  const backgroundConsumers = backgroundConsumerEntrypoints(
    files,
    declaredBackgroundEntrypoints,
    declaredBackgroundPage,
    declaredBackgroundScripts,
  );
  const webAccessibleResources = manifestWebAccessibleResourcePaths(raw, files);
  const extensionPageConsumers = htmlPageConsumerEntrypoints(files, [
    ...manifestExtensionPagePaths(raw),
    ...webAccessibleResources.filter((path) => /\.html?$/i.test(path)),
  ]);
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
      extensionPageEntrypoints: [
        ...new Set([...extensionPageConsumers.entrypoints, ...webAccessibleResources]),
      ],
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
    manifestRecordString(raw.chrome_settings_overrides, "homepage"),
    ...manifestRecordStrings(raw.chrome_url_overrides),
    ...(isRecord(raw.sandbox) ? stringList(raw.sandbox.pages) : []),
    ...(Array.isArray(raw.protocol_handlers)
      ? raw.protocol_handlers.flatMap((handler) =>
          isRecord(handler) && typeof handler.uriTemplate === "string" ? [handler.uriTemplate] : [],
        )
      : []),
  ]);
}

function manifestWebAccessibleResourcePaths(
  raw: Record<string, unknown>,
  files: FileRecord[],
): string[] {
  const declarations: string[] = [];
  const append = (value: unknown): void => {
    if (typeof value !== "string" || !value.trim()) return;
    if (declarations.length >= MAX_WEB_ACCESSIBLE_RESOURCE_DECLARATIONS) {
      throw new Error("manifest.json declares too many web-accessible resources");
    }
    declarations.push(value);
  };
  if (Array.isArray(raw.web_accessible_resources)) {
    for (const declaration of raw.web_accessible_resources) {
      if (typeof declaration === "string") {
        append(declaration);
        continue;
      }
      if (!isRecord(declaration) || !Array.isArray(declaration.resources)) continue;
      for (const resource of declaration.resources) append(resource);
    }
  }

  const patterns = [...new Set(manifestResourcePaths(declarations))];
  const exactPatterns = new Set(patterns.filter((pattern) => !pattern.includes("*")));
  const wildcardPatterns = patterns
    .filter((pattern) => pattern.includes("*"))
    .map((pattern) => pattern.split("*"));
  const wildcardWork = wildcardPatterns.reduce((work, parts) => work + parts.length, 0);
  if (wildcardWork * files.length > MAX_WEB_ACCESSIBLE_RESOURCE_WILDCARD_CHECKS) {
    throw new Error("manifest.json web-accessible resource patterns exceed the review work budget");
  }
  return files
    .map((file) => file.path)
    .filter(
      (path) =>
        exactPatterns.has(path) ||
        wildcardPatterns.some((pattern) => wildcardManifestPathMatches(path, pattern)),
    );
}

function wildcardManifestPathMatches(path: string, parts: string[]): boolean {
  const first = parts[0];
  if (!path.startsWith(first)) return false;
  let offset = first.length;
  for (const part of parts.slice(1, -1)) {
    const matchAt = path.indexOf(part, offset);
    if (matchAt === -1) return false;
    offset = matchAt + part.length;
  }
  const last = parts.at(-1) ?? "";
  return last.length === 0 || (path.length - last.length >= offset && path.endsWith(last));
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
  backgroundScripts: string[],
): HtmlPageConsumers {
  const entrypoints = new Set(declaredEntrypoints);
  let documentBaseUrlsByPath = Object.fromEntries(
    backgroundScripts.map((path) => [path, [EXTENSION_RESOURCE_ROOT.href]]),
  );
  if (backgroundPage) {
    const pageConsumers = htmlPageConsumerEntrypoints(files, [backgroundPage]);
    for (const path of pageConsumers.entrypoints) {
      entrypoints.add(path);
    }
    documentBaseUrlsByPath = mergeDocumentBaseUrlsByPath(
      documentBaseUrlsByPath,
      pageConsumers.documentBaseUrlsByPath,
    );
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
  const pageQueue = [...pagePaths];
  while (pageQueue.length) {
    const pagePath = pageQueue.pop();
    if (pagePath === undefined || inspectedPages.has(pagePath)) continue;
    inspectedPages.add(pagePath);
    for (const dependency of browserDocumentConsumerEdges(filesByPath, pagePath)) {
      entrypoints.add(dependency.path);
      if (dependency.documentBaseUrl !== undefined) {
        const bases = documentBaseUrlsByPath.get(dependency.path) ?? new Set<string>();
        bases.add(dependency.documentBaseUrl);
        documentBaseUrlsByPath.set(dependency.path, bases);
      }
      if (isBrowserConsumerDocumentPath(dependency.path) && !inspectedPages.has(dependency.path)) {
        pageQueue.push(dependency.path);
      }
    }
  }
  return {
    entrypoints: [...entrypoints],
    documentBaseUrlsByPath: Object.fromEntries(
      [...documentBaseUrlsByPath].map(([path, bases]) => [path, [...bases]]),
    ),
  };
}

export function createBrowserHtmlConsumerDependencyResolver(
  files: FileRecord[],
): (pagePath: string) => Array<{ path: string; documentBaseUrl?: string }> {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  return (pagePath) =>
    isBrowserConsumerDocumentPath(pagePath)
      ? browserDocumentConsumerEdges(filesByPath, pagePath)
      : [];
}

// Direct consumer edges of one packaged document. Callers decide which paths
// are documents worth traversing — manifest-declared pages are scanned
// whatever their extension, while discovered edges recurse only into
// document-suffixed paths. Each source resolves against
// every base candidate the document could plausibly use (see
// `documentBaseCandidates`), so mistracking which <base> a browser would pick
// can only add edges, never hide one.
function browserDocumentConsumerEdges(
  filesByPath: Map<string, FileRecord>,
  pagePath: string,
): Array<{ path: string; documentBaseUrl?: string }> {
  const text = filesByPath.get(pagePath)?.textSample;
  if (!text) return [];
  const pageUrl = extensionPageUrl(pagePath);
  if (!pageUrl) return [];
  return browserDocumentConsumerEdgesFromText(
    text,
    pageUrl,
    pagePath,
    BROWSER_XML_DOCUMENT_PATH_RE.test(pagePath),
  );
}

export function createBrowserInlineDocumentConsumerDependencyResolver(): (
  html: string,
  documentBaseUrl: string,
) => Array<{ path: string; documentBaseUrl?: string }> {
  return (html, documentBaseUrl) => {
    let base: URL;
    try {
      base = new URL(documentBaseUrl);
    } catch {
      return [];
    }
    if (
      base.protocol !== EXTENSION_RESOURCE_ROOT.protocol ||
      base.host !== EXTENSION_RESOURCE_ROOT.host
    ) {
      return [];
    }
    return browserDocumentConsumerEdgesFromText(html, base, "inline srcdoc document", false);
  };
}

function browserDocumentConsumerEdgesFromText(
  text: string,
  pageUrl: URL,
  documentLabel: string,
  xmlSyntax: boolean,
): Array<{ path: string; documentBaseUrl?: string }> {
  const edges = new Map<string, { path: string; documentBaseUrl?: string }>();
  let resolutionBudget = MAX_DOCUMENT_CONSUMER_RESOLUTIONS;
  const spendResolutionBudget = (work: number): void => {
    resolutionBudget -= work;
    if (resolutionBudget < 0) {
      throw new Error(`document ${documentLabel} exceeds the consumer resolution work budget`);
    }
  };
  const inlineQueue: Array<{ html: string; fallbackBases: URL[]; xmlSyntax: boolean }> = [
    {
      html: text,
      fallbackBases: [pageUrl],
      xmlSyntax,
    },
  ];
  while (inlineQueue.length) {
    const inline = inlineQueue.pop();
    if (!inline) continue;
    const tokens = scanDocumentConsumerTokens(inline.html, inline.xmlSyntax);
    spendResolutionBudget(tokens.baseHrefs.length * inline.fallbackBases.length);
    const bases = documentBaseCandidates(inline.fallbackBases, tokens.baseHrefs);
    spendResolutionBudget(
      (tokens.scriptSources.length + tokens.resourceSources.length) * bases.length,
    );
    for (const html of tokens.inlineDocuments) {
      inlineQueue.push({ html, fallbackBases: bases, xmlSyntax: false });
    }
    for (const source of tokens.scriptSources) {
      for (const base of bases) {
        const path = resolveExtensionResourcePath(source, base);
        if (path) edges.set(`${path}\0${base.href}`, { path, documentBaseUrl: base.href });
      }
    }
    for (const source of tokens.resourceSources) {
      for (const base of bases) {
        const path = resolveExtensionResourcePath(source, base);
        if (path) edges.set(`${path}\0`, { path });
      }
    }
  }
  return [...edges.values()];
}

export function isBrowserConsumerDocumentPath(path: string): boolean {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return BROWSER_DOCUMENT_PATH_RE.test(path) || (basename.length > 0 && !basename.includes("."));
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

interface DocumentConsumerTokens {
  scriptSources: string[];
  resourceSources: string[];
  inlineDocuments: string[];
  baseHrefs: string[];
}

// Deliberate over-approximation of browser document parsing.
//
// Consumer edges only ever cancel the test-path demotion — findings are
// demoted, never dropped — so a missed edge lets a hostile package keep
// reduced severity while an invented edge merely reports an inert reference
// at full severity. The failure directions are asymmetric, and bit-exact
// emulation of engine parsing (namespaces, foreign content, raw text, CDATA,
// integration points, self-closing rules) is an unbounded goal that this
// scanner deliberately does not attempt. It reads every tag-shaped token in
// the document — including comment, raw-text, template, and foreign-content
// context — and collects every URL-valued attribute that could make some
// engine fetch, navigate to, or execute a packaged resource. Anything a real
// parser reaches, this scan reaches by construction. An edge no browser
// would follow is by design, not a bug; only a missed edge is a bug. See the
// precision-boundary note in docs/security-detection-corpus.md before
// narrowing this.
function scanDocumentConsumerTokens(html: string, xmlSyntax = false): DocumentConsumerTokens {
  const tokens: DocumentConsumerTokens = {
    scriptSources: [],
    resourceSources: [],
    inlineDocuments: [],
    baseHrefs: [],
  };
  let index = 0;
  while (index < html.length) {
    const tagStart = html.indexOf("<", index);
    if (tagStart === -1) break;
    let cursor = tagStart + 1;
    if (html[cursor] === "/") cursor += 1;
    const nameStart = cursor;
    while (cursor < html.length && /[A-Za-z0-9:_.-]/.test(html[cursor])) cursor += 1;
    const rawTagName = html.slice(nameStart, cursor).toLowerCase();
    if (!rawTagName || !/[\s/>]/.test(html[cursor] ?? "")) {
      index = Math.max(cursor, tagStart + 1);
      continue;
    }
    // XML documents can alias any element behind a namespace prefix, so match
    // on the local name.
    const tagName = rawTagName.slice(rawTagName.lastIndexOf(":") + 1);
    while (cursor < html.length) {
      while (/\s/.test(html[cursor] ?? "")) cursor += 1;
      if (html[cursor] === ">") {
        cursor += 1;
        break;
      }
      if (html[cursor] === "/" && html[cursor + 1] === ">") {
        cursor += 2;
        break;
      }

      const attributeStart = cursor;
      while (cursor < html.length && !/[\s=/>]/.test(html[cursor])) cursor += 1;
      if (cursor === attributeStart) {
        cursor += 1;
        continue;
      }
      const rawAttributeName = html.slice(attributeStart, cursor).toLowerCase();
      const attributeName = rawAttributeName.slice(rawAttributeName.lastIndexOf(":") + 1);
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
      if (value === null) continue;

      collectDocumentConsumerAttribute(tokens, tagName, attributeName, decodeHTMLAttribute(value));
    }
    index = Math.max(cursor, tagStart + 1);
  }
  if (xmlSyntax) scanXmlDocumentConsumerTokens(html, tokens);
  return tokens;
}

function collectDocumentConsumerAttribute(
  tokens: DocumentConsumerTokens,
  tagName: string,
  attributeName: string,
  value: string,
): void {
  if (attributeName === "srcdoc") {
    tokens.inlineDocuments.push(value);
    return;
  }
  if (attributeName === "content") {
    // Meta-refresh URLs live inside the content attribute's own grammar.
    // Matching the grammar on any element keeps the edge tag-independent.
    const refreshUrl = metaRefreshUrl(value);
    if (refreshUrl) tokens.resourceSources.push(refreshUrl);
    return;
  }
  if (!CONSUMER_URL_ATTRIBUTE_LOCAL_NAMES.has(attributeName)) return;
  if (tagName === "base") {
    // A base element is never fetched itself; it only changes resolution.
    if (attributeName === "href") tokens.baseHrefs.push(value);
  } else if (tagName === "script") {
    tokens.scriptSources.push(value);
  } else {
    tokens.resourceSources.push(value);
  }
}

// The flat scanner intentionally ignores tree-construction details, but XML
// names and internal entities have grammars that a byte-level token scan cannot
// safely approximate. Supplement valid XHTML/SVG documents with a non-executing
// XML parse; malformed documents retain the flat scan's conservative edges.
function scanXmlDocumentConsumerTokens(xml: string, tokens: DocumentConsumerTokens): void {
  const supplemental: DocumentConsumerTokens = {
    scriptSources: [],
    resourceSources: [],
    inlineDocuments: [],
    baseHrefs: [],
  };
  const parser = new SaxesParser({ xmlns: true });
  let fatalError: Error | null = null;
  parser.on("doctype", (doctype) => {
    try {
      for (const [name, replacement] of xmlGeneralEntityReplacements(doctype)) {
        Object.defineProperty(parser.ENTITIES, name, {
          configurable: true,
          enumerable: true,
          value: replacement,
          writable: true,
        });
        // Entity replacement text may become an attribute URL or parsed markup.
        // Following both shapes is conservative and avoids depending on where
        // the document references the entity.
        supplemental.resourceSources.push(replacement);
        supplemental.inlineDocuments.push(replacement);
      }
    } catch (error) {
      fatalError =
        error instanceof Error ? error : new Error("browser XML entity processing failed");
      throw error;
    }
  });
  parser.on("opentag", (tag) => {
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.uri === "http://www.w3.org/XML/1998/namespace" && attribute.local === "base") {
        supplemental.baseHrefs.push(attribute.value);
      }
      collectDocumentConsumerAttribute(supplemental, tag.local, attribute.local, attribute.value);
    }
  });
  // XML parse failures mean the browser will not construct an executable XML
  // document. The flat scan above still preserves any tag-shaped evidence.
  parser.on("error", () => {});
  try {
    parser.write(xml).close();
  } catch {
    // Event-handler budget failures are rethrown below; syntax failures merely
    // suppress this supplemental exact-name pass.
  }
  if (fatalError) throw fatalError;
  mergeSupplementalDocumentConsumerTokens(tokens, supplemental);
}

function mergeSupplementalDocumentConsumerTokens(
  tokens: DocumentConsumerTokens,
  supplemental: DocumentConsumerTokens,
): void {
  for (const key of ["scriptSources", "resourceSources", "inlineDocuments", "baseHrefs"] as const) {
    const seen = new Set(tokens[key]);
    for (const value of supplemental[key]) {
      if (seen.has(value)) continue;
      seen.add(value);
      tokens[key].push(value);
    }
  }
}

function xmlGeneralEntityReplacements(doctype: string): Map<string, string> {
  const declarationStarts = [...doctype.matchAll(/<!ENTITY\s+/g)];
  if (declarationStarts.length > MAX_XML_GENERAL_ENTITIES) {
    throw new Error("browser XML document declares too many general entities");
  }
  const declarations = new Map<string, string>();
  const declarationPattern = /<!ENTITY\s+(?!%)([^\s]+)\s+(["'])(.*?)\2\s*>/gs;
  for (const match of doctype.matchAll(declarationPattern)) {
    const [, name, , replacement] = match;
    if (declarations.has(name)) throw new Error(`browser XML entity ${name} is duplicated`);
    declarations.set(name, replacement);
  }
  if (declarations.size !== declarationStarts.length) {
    throw new Error("browser XML document uses an unsupported entity declaration");
  }

  const expanded = new Map<string, string>();
  let expandedCharacters = 0;
  const expand = (name: string, stack: string[]): string => {
    const cached = expanded.get(name);
    if (cached !== undefined) return cached;
    if (stack.includes(name)) throw new Error(`browser XML entity ${name} is recursive`);
    if (stack.length >= MAX_XML_ENTITY_EXPANSION_DEPTH) {
      throw new Error("browser XML entity expansion is too deeply nested");
    }
    const raw = declarations.get(name) ?? "";
    let output = "";
    let cursor = 0;
    for (const match of raw.matchAll(/&([^\s;]+);/g)) {
      const index = match.index;
      const reference = match[1];
      const replacement = declarations.has(reference)
        ? expand(reference, [...stack, name])
        : decodeXML(match[0]);
      const fragment = raw.slice(cursor, index) + replacement;
      if (output.length + fragment.length > MAX_XML_ENTITY_EXPANDED_CHARACTERS) {
        throw new Error("browser XML entity expansion exceeds the character budget");
      }
      output += fragment;
      cursor = index + match[0].length;
    }
    const tail = raw.slice(cursor);
    if (output.length + tail.length > MAX_XML_ENTITY_EXPANDED_CHARACTERS) {
      throw new Error("browser XML entity expansion exceeds the character budget");
    }
    output += tail;
    expandedCharacters += output.length;
    if (expandedCharacters > MAX_XML_ENTITY_EXPANDED_CHARACTERS) {
      throw new Error("browser XML entity expansion exceeds the character budget");
    }
    expanded.set(name, output);
    return output;
  };
  for (const name of declarations.keys()) expand(name, []);
  return expanded;
}

function metaRefreshUrl(content: string): string | null {
  const match = /^\s*(?:\d+(?:\.\d*)?|\.\d+)\s*[;,]\s*(.*?)\s*$/i.exec(content);
  if (!match) return null;
  const value = match[1].replace(/^url\s*=\s*/i, "");
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

// Every base URL the document could plausibly resolve sources against: the
// document URL (or the embedding candidates for an inline srcdoc document)
// plus every declared HTML <base> or XML xml:base href. Browsers use only the
// first HTML base element, while XML bases inherit through the element tree.
// Resolving each candidate against every earlier candidate over-approximates
// both shapes so parser ambiguity cannot hide an edge.
function documentBaseCandidates(fallbackBases: URL[], baseHrefs: string[]): URL[] {
  const candidates = new Map<string, URL>(fallbackBases.map((base) => [base.href, base]));
  for (const rawHref of baseHrefs) {
    const href = rawHref.trim();
    if (!href || href.includes("\\")) continue;
    const currentCandidates = Array.from(candidates.values());
    for (const fallback of currentCandidates) {
      try {
        const resolved = new URL(href, fallback);
        if (
          resolved.protocol !== EXTENSION_RESOURCE_ROOT.protocol ||
          resolved.host !== EXTENSION_RESOURCE_ROOT.host
        ) {
          continue;
        }
        candidates.set(resolved.href, resolved);
      } catch {
        // The HTML base-element algorithm falls back to the document URL when
        // its href cannot be parsed; that URL is already a candidate.
      }
      if (candidates.size > MAX_DOCUMENT_BASE_CANDIDATES) {
        throw new Error("document declares too many distinct base URL candidates");
      }
    }
  }
  return [...candidates.values()];
}

function extensionPageUrl(pagePath: string): URL | null {
  try {
    // pagePath is already decoded for archive lookup. Re-encode each path
    // segment before URL resolution so a literal archive `#`, `?`, or `%`
    // does not become URL syntax and change the document base.
    return new URL(encodeArchiveLookupPathForUrl(pagePath), EXTENSION_RESOURCE_ROOT);
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
