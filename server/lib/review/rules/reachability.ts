import type { CodePatternSet, FileRecord, PackageJsonSummary } from "..";
import {
  decodeJsNoSubstitutionTemplate,
  jsTokenText,
  type JsToken,
  tokenizeJs,
} from "../../platform/js-lexer";
import {
  decodeUrlPathForArchiveLookup,
  encodeArchiveLookupPathForUrl,
} from "../../platform/path-safety";
import { isTestPath } from "./file-types";
import { CONSUMER_INSTALL_LIFECYCLE_SCRIPTS } from "./patterns";

// Static require/import/importScripts edges between files inside the package.
// The walk is conservative: bare dependency imports and dynamic expressions
// cannot pull a packaged file into the consumer graph. An unproven test-path
// edge receives the documented test-only demotion, so ecosystem-specific URL
// resolution must be opted in when the runtime supports it.
const RELATIVE_SPECIFIER_PATTERNS = [
  /\brequire\s*\(\s*["'](\.\.?\/[^"'\n]+)["']\s*\)/g,
  /\bimport\s*\(\s*["'](\.\.?\/[^"'\n]+)["']\s*\)/g,
];
const ROOT_RELATIVE_MODULE_SPECIFIER_PATTERNS = [/\bimport\s*\(\s*["'](\/[^"'\n]+)["']\s*\)/g];
const RESOLUTION_SUFFIXES = [
  "",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  "/index.js",
  "/index.mjs",
  "/index.cjs",
];

const PYTHON_RESOLUTION_SUFFIXES = [".py", "/__init__.py"];
const PYTHON_FROM_IMPORT_PATTERN =
  /^\s*from\s+([A-Za-z_][\w.]*|\.+[A-Za-z_][\w.]*|\.+)\s+import\s+([^#;\n]+)/gm;
const PYTHON_IMPORT_PATTERN = /^\s*import\s+([^#;\n]+)/gm;
// Archive limits bound files and bytes, but one source can execute under many
// document bases. Cap the resulting multiplicative work independently.
const MAX_CONSUMER_REACHABILITY_CONTEXTS = 10_000;
const MAX_CONSUMER_REACHABILITY_RESOLUTIONS = 1_000_000;
const MAX_CONSUMER_INLINE_DOCUMENT_CHARACTERS = 25 * 1024 * 1024;

export interface ConsumerReachabilityDependency {
  path: string;
  documentBaseUrl?: string;
}

interface ConsumerReachabilityQueueEntry {
  path: string;
  documentBaseUrl?: string;
  workerEntryBaseUrl?: string;
}

interface StaticConsumerDependencies {
  documentBases: DynamicDocumentBaseSpecifier[];
  fileDependencies: ConsumerReachabilityDependency[];
  importScripts: ImportScriptsSpecifier[];
  relativeSpecifiers: string[];
  webExtensionResources: WebExtensionResourceSpecifier[];
  workers: WorkerScriptSpecifier[];
}

// Files a registry tarball consumer install can execute: declared entrypoints
// (main/module/browser/exports), bin targets, lifecycle script targets, and everything
// statically importable from them. Seeding from lifecycle scripts matters for
// attack chains that split a payload across files an install hook pulls in
// transitively — those files must keep full finding severity.
export function consumerReachablePaths(
  files: FileRecord[],
  packageJson: PackageJsonSummary | null,
  extraSeedPaths: string[] = [],
  codePatternSet: CodePatternSet | undefined = "javascript",
  rootRelativeModuleImports = false,
  consumerDocumentBaseUrlsByPath: Record<string, string[]> = {},
  consumerFileDependencyPaths?: (
    path: string,
    file: FileRecord,
  ) => ConsumerReachabilityDependency[],
  consumerInlineDocumentDependencyPaths?: (
    html: string,
    documentBaseUrl: string,
  ) => ConsumerReachabilityDependency[],
): Set<string> {
  if (codePatternSet === "python") return pythonConsumerReachablePaths(files);

  const byNormalizedPath = new Map<string, FileRecord>();
  for (const file of files) {
    byNormalizedPath.set(stripPackagePrefix(file.path), file);
  }

  const queue: ConsumerReachabilityQueueEntry[] = [];
  const pendingContexts = new Set<string>();
  const inspectedContexts = new Set<string>();
  const contextKey = ({
    path,
    documentBaseUrl,
    workerEntryBaseUrl,
  }: ConsumerReachabilityQueueEntry): string =>
    `${path}\0${documentBaseUrl ?? ""}\0${workerEntryBaseUrl ?? ""}`;
  const enqueue = (entry: ConsumerReachabilityQueueEntry): void => {
    const key = contextKey(entry);
    if (pendingContexts.has(key) || inspectedContexts.has(key)) return;
    if (pendingContexts.size + inspectedContexts.size >= MAX_CONSUMER_REACHABILITY_CONTEXTS) {
      throw new Error("consumer reachability exceeds the execution-context work budget");
    }
    pendingContexts.add(key);
    queue.push(entry);
  };
  let remainingResolutionWork = MAX_CONSUMER_REACHABILITY_RESOLUTIONS;
  let remainingInlineDocumentCharacters = MAX_CONSUMER_INLINE_DOCUMENT_CHARACTERS;
  const spendResolutionWork = (work = 1): void => {
    remainingResolutionWork -= work;
    if (remainingResolutionWork < 0) {
      throw new Error("consumer reachability exceeds the dependency-resolution work budget");
    }
  };
  for (const candidate of entrypointCandidates(packageJson)) {
    const resolved = resolveModulePath(candidate, byNormalizedPath);
    if (resolved) enqueue({ path: resolved });
  }
  for (const candidate of extraSeedPaths) {
    // Browser manifest and HTML URLs select exact archive entries. Package
    // entrypoints retain Node-style extension and index fallback above.
    const resolved = rootRelativeModuleImports
      ? resolveExactModulePath(candidate, byNormalizedPath)
      : resolveModulePath(candidate, byNormalizedPath);
    if (!resolved) continue;
    const documentBases = consumerDocumentBaseUrlsByPath[resolved];
    if (documentBases?.length) {
      for (const documentBaseUrl of documentBases) enqueue({ path: resolved, documentBaseUrl });
    } else {
      enqueue({ path: resolved });
    }
  }

  const reachable = new Set<string>();
  const staticDependenciesByPath = new Map<string, StaticConsumerDependencies>();
  while (queue.length) {
    const queued = queue.pop();
    if (!queued) continue;
    const { path, documentBaseUrl, workerEntryBaseUrl } = queued;
    const queuedContextKey = contextKey(queued);
    pendingContexts.delete(queuedContextKey);
    if (inspectedContexts.has(queuedContextKey)) continue;
    inspectedContexts.add(queuedContextKey);
    reachable.add(path);
    const file = byNormalizedPath.get(path);
    if (!file?.textSample) continue;
    let dependencies = staticDependenciesByPath.get(path);
    if (!dependencies) {
      const browserDependencies = rootRelativeModuleImports
        ? staticWebExtensionDependencies(file.textSample)
        : { documentBases: [], resources: [] };
      dependencies = {
        documentBases: browserDependencies.documentBases,
        fileDependencies: consumerFileDependencyPaths?.(path, file) ?? [],
        relativeSpecifiers: relativeSpecifiers(file.textSample, rootRelativeModuleImports),
        importScripts: staticImportScriptsSpecifiers(file.textSample),
        webExtensionResources: browserDependencies.resources,
        workers: rootRelativeModuleImports ? staticWorkerScriptSpecifiers(file.textSample) : [],
      };
      staticDependenciesByPath.set(path, dependencies);
    }
    for (const dependency of dependencies.fileDependencies) {
      spendResolutionWork();
      const resolved = rootRelativeModuleImports
        ? resolveExactModulePath(dependency.path, byNormalizedPath)
        : resolveModulePath(dependency.path, byNormalizedPath);
      if (resolved) enqueue({ path: resolved, documentBaseUrl: dependency.documentBaseUrl });
    }
    for (const specifier of dependencies.relativeSpecifiers) {
      spendResolutionWork();
      const resolved = rootRelativeModuleImports
        ? resolveBrowserScriptModulePath(path, specifier, byNormalizedPath)
        : resolveModulePath(joinRelative(path, specifier), byNormalizedPath);
      if (resolved) enqueue({ path: resolved, documentBaseUrl, workerEntryBaseUrl });
    }
    for (const imported of dependencies.importScripts) {
      spendResolutionWork();
      if (!rootRelativeModuleImports && imported.resolution === "extension-root") continue;
      const activeWorkerEntryBaseUrl = workerEntryBaseUrl ?? browserArchiveUrl(path);
      const resolved = rootRelativeModuleImports
        ? imported.resolution === "extension-root"
          ? resolveBrowserDocumentModulePath(
              imported.path,
              BROWSER_ARCHIVE_ROOT.href,
              byNormalizedPath,
            )
          : activeWorkerEntryBaseUrl
            ? resolveBrowserDocumentModulePath(
                imported.path,
                activeWorkerEntryBaseUrl,
                byNormalizedPath,
              )
            : null
        : resolveModulePath(joinRelative(path, imported.path), byNormalizedPath);
      if (resolved) {
        enqueue({
          path: resolved,
          documentBaseUrl: rootRelativeModuleImports ? undefined : documentBaseUrl,
          workerEntryBaseUrl: rootRelativeModuleImports
            ? (activeWorkerEntryBaseUrl ?? undefined)
            : undefined,
        });
      }
    }
    if (rootRelativeModuleImports) {
      const activeDocumentBaseUrls = new Set(documentBaseUrl ? [documentBaseUrl] : []);
      if (documentBaseUrl) {
        for (const base of dependencies.documentBases) {
          spendResolutionWork();
          const resolutionBaseUrl =
            base.resolution === "root"
              ? BROWSER_ARCHIVE_ROOT.href
              : base.resolution === "document-module"
                ? browserArchiveUrl(path)
                : documentBaseUrl;
          const resolvedBaseUrl = resolutionBaseUrl
            ? resolveBrowserDocumentUrl(base.documentBasePath, resolutionBaseUrl)
            : null;
          if (resolvedBaseUrl) activeDocumentBaseUrls.add(resolvedBaseUrl);
        }
      }
      const enqueueResource = (
        resolved: string,
        inheritsExecutionContext: boolean | undefined,
      ): void => {
        if (!inheritsExecutionContext) {
          enqueue({ path: resolved });
          return;
        }
        if (activeDocumentBaseUrls.size) {
          for (const activeDocumentBaseUrl of activeDocumentBaseUrls) {
            enqueue({ path: resolved, documentBaseUrl: activeDocumentBaseUrl });
          }
          return;
        }
        enqueue({ path: resolved, workerEntryBaseUrl });
      };
      for (const resource of dependencies.webExtensionResources) {
        if ("inlineDocument" in resource) {
          if (!consumerInlineDocumentDependencyPaths) continue;
          for (const activeDocumentBaseUrl of activeDocumentBaseUrls) {
            remainingInlineDocumentCharacters -= resource.inlineDocument.length;
            if (remainingInlineDocumentCharacters < 0) {
              throw new Error("consumer reachability exceeds the inline-document work budget");
            }
            const inlineDependencies = consumerInlineDocumentDependencyPaths(
              resource.inlineDocument,
              activeDocumentBaseUrl,
            );
            spendResolutionWork(inlineDependencies.length);
            for (const dependency of inlineDependencies) {
              const resolved = resolveExactModulePath(dependency.path, byNormalizedPath);
              if (resolved) {
                enqueue({ path: resolved, documentBaseUrl: dependency.documentBaseUrl });
              }
            }
          }
          continue;
        }
        // Registration and explicit runtime.getURL()/extension.getURL()
        // resources are rooted at the extension origin. Static URL values constructed from
        // import.meta.url instead resolve against the owning script. Direct relative tab URLs and
        // Manifest V2 injection files differ across browser runtimes, so follow both the extension
        // root and the owning extension document when one is known.
        if (
          resource.resolution === "module" ||
          resource.resolution === "module-pathname" ||
          resource.resolution === "document-module" ||
          resource.resolution === "document-module-pathname"
        ) {
          if (resource.resolution.startsWith("document-") && !documentBaseUrl) continue;
          spendResolutionWork();
          const resolved = resolveBrowserScriptModulePath(
            path,
            resource.path,
            byNormalizedPath,
            resource.resolution.endsWith("-pathname"),
          );
          if (resolved) {
            enqueueResource(resolved, resource.inheritsExecutionContext);
          }
          continue;
        }
        const baseUrls =
          resource.resolution === "root"
            ? [BROWSER_ARCHIVE_ROOT.href]
            : resource.resolution === "document-root"
              ? documentBaseUrl
                ? [BROWSER_ARCHIVE_ROOT.href]
                : []
              : resource.resolution === "document"
                ? [...activeDocumentBaseUrls]
                : activeDocumentBaseUrls.size
                  ? [BROWSER_ARCHIVE_ROOT.href, ...activeDocumentBaseUrls]
                  : [BROWSER_ARCHIVE_ROOT.href];
        for (const baseUrl of new Set(baseUrls)) {
          spendResolutionWork();
          const resolved = resolveBrowserDocumentModulePath(
            resource.path,
            baseUrl,
            byNormalizedPath,
          );
          if (resolved) {
            enqueueResource(resolved, resource.inheritsExecutionContext);
          }
        }
      }
      for (const worker of dependencies.workers) {
        spendResolutionWork();
        if (worker.resolution === "root") {
          const resolved = resolveBrowserDocumentModulePath(
            worker.path,
            BROWSER_ARCHIVE_ROOT.href,
            byNormalizedPath,
          );
          if (resolved) {
            enqueue({ path: resolved, workerEntryBaseUrl: browserArchiveUrl(resolved) });
          }
          continue;
        }
        if (worker.resolution === "module" || worker.resolution === "module-pathname") {
          const resolved = resolveBrowserScriptModulePath(
            path,
            worker.path,
            byNormalizedPath,
            worker.resolution === "module-pathname",
          );
          if (resolved) {
            enqueue({ path: resolved, workerEntryBaseUrl: browserArchiveUrl(resolved) });
          }
        } else {
          const executionBaseUrl = workerEntryBaseUrl ?? documentBaseUrl;
          if (!executionBaseUrl) continue;
          const resolved = resolveBrowserDocumentModulePath(
            worker.path,
            executionBaseUrl,
            byNormalizedPath,
          );
          if (resolved) {
            enqueue({ path: resolved, workerEntryBaseUrl: browserArchiveUrl(resolved) });
          }
        }
      }
    }
  }
  return reachable;
}

// Python packages do not have a package.json-style entrypoint manifest. Treat
// every non-test Python module as consumer-reachable, then follow its static
// imports into test trees. This is deliberately conservative: an import edge
// can only keep a finding loud, never hide one.
function pythonConsumerReachablePaths(files: FileRecord[]): Set<string> {
  const byNormalizedPath = new Map<string, FileRecord>();
  const queue: string[] = [];
  for (const file of files) {
    const path = stripPackagePrefix(file.path);
    byNormalizedPath.set(path, file);
    if (/\.py$/i.test(path) && !isTestPath(path)) queue.push(path);
  }

  const reachable = new Set<string>();
  while (queue.length) {
    const path = queue.pop();
    if (!path || reachable.has(path)) continue;
    reachable.add(path);
    const file = byNormalizedPath.get(path);
    if (!file?.textSample) continue;
    for (const candidate of pythonImportCandidates(path, file.textSample)) {
      for (const resolved of resolvePythonModulePaths(candidate, byNormalizedPath)) {
        if (!reachable.has(resolved)) queue.push(resolved);
      }
    }
  }
  return reachable;
}

function pythonImportCandidates(sourcePath: string, text: string): string[] {
  const candidates: string[] = [];
  PYTHON_FROM_IMPORT_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(PYTHON_FROM_IMPORT_PATTERN)) {
    const base = pythonModuleCandidate(sourcePath, match[1]);
    if (base) candidates.push(base);
    for (const imported of pythonImportedNames(match[2])) {
      const separator = match[1].endsWith(".") ? "" : ".";
      const nested = pythonModuleCandidate(sourcePath, `${match[1]}${separator}${imported}`);
      if (nested) candidates.push(nested);
    }
  }
  PYTHON_IMPORT_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(PYTHON_IMPORT_PATTERN)) {
    for (const imported of pythonImportedNames(match[1])) {
      const candidate = pythonModuleCandidate(sourcePath, imported);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function pythonImportedNames(value: string): string[] {
  return value
    .replace(/[()]/g, "")
    .split(",")
    .map((part) => part.trim().split(/\s+as\s+/i)[0])
    .filter((part) => /^[A-Za-z_][\w.]*$/.test(part));
}

function pythonModuleCandidate(sourcePath: string, moduleName: string): string | null {
  const root = pythonArtifactRoot(sourcePath);
  const rootSegments = root ? root.split("/") : [];
  const relative = /^(\.+)(.*)$/.exec(moduleName);
  let segments: string[];
  let remainder: string;
  if (relative) {
    segments = sourcePath.split("/").slice(0, -1);
    for (let index = 1; index < relative[1].length; index += 1) {
      if (segments.length <= rootSegments.length) return null;
      segments.pop();
    }
    remainder = relative[2];
  } else {
    segments = [...rootSegments];
    remainder = moduleName;
  }
  if (remainder) segments.push(...remainder.split(".").filter(Boolean));
  return normalizePathSegments(segments.join("/"));
}

function pythonArtifactRoot(path: string): string {
  const segments = path.split("/");
  if (segments[0] === "sdist") return "sdist";
  if (segments[0] === "wheel" && segments[1]) return `wheel/${segments[1]}`;
  return "";
}

function resolvePythonModulePaths(
  candidate: string,
  byNormalizedPath: Map<string, FileRecord>,
): string[] {
  const resolved = new Set<string>();
  for (const suffix of PYTHON_RESOLUTION_SUFFIXES) {
    const exact = candidate + suffix;
    if (byNormalizedPath.has(exact)) resolved.add(exact);

    // Sdists commonly keep importable packages below src/. Absolute imports
    // omit that source-root segment, so conservatively match the same module
    // suffix anywhere inside this artifact namespace.
    const root = pythonArtifactRoot(candidate);
    const modulePath = root ? candidate.slice(root.length + 1) : candidate;
    const ending = `/${modulePath}${suffix}`;
    for (const path of byNormalizedPath.keys()) {
      if (pythonArtifactRoot(path) === root && path.endsWith(ending)) resolved.add(path);
    }
  }
  return [...resolved];
}

function entrypointCandidates(packageJson: PackageJsonSummary | null): string[] {
  if (!packageJson) return ["index.js"];
  const candidates: string[] = [];
  if (typeof packageJson.main === "string") candidates.push(packageJson.main);
  else candidates.push("index.js");
  if (typeof packageJson.module === "string") candidates.push(packageJson.module);
  if (typeof packageJson.bin === "string") candidates.push(packageJson.bin);
  else if (packageJson.bin && typeof packageJson.bin === "object") {
    for (const target of Object.values(packageJson.bin)) {
      if (typeof target === "string") candidates.push(target);
    }
  }
  candidates.push(...exportTargets(packageJson.exports));
  if (typeof packageJson.browser === "string") candidates.push(packageJson.browser);
  return candidates;
}

function exportTargets(exports: unknown): string[] {
  if (typeof exports === "string") return [exports];
  if (Array.isArray(exports)) return exports.flatMap((entry) => exportTargets(entry));
  if (exports && typeof exports === "object") {
    return Object.values(exports as Record<string, unknown>).flatMap((entry) =>
      exportTargets(entry),
    );
  }
  return [];
}

// Files a consumer install lifecycle script command names directly (`postinstall: "node
// test/setup.js"`). Matching reuses the same token/candidate scheme as the
// install-script rules so the two notions of "lifecycle script file" agree.
export function lifecycleScriptSeedPaths(
  files: FileRecord[],
  scripts: Record<string, string>,
  implicitScripts: Record<string, string>,
): string[] {
  const tokens = new Set<string>();
  for (const script of CONSUMER_INSTALL_LIFECYCLE_SCRIPTS) {
    const command = scripts[script];
    if (!command || implicitScripts[script] === command) continue;
    for (const token of scriptCommandTokens(command)) tokens.add(token);
  }
  if (!tokens.size) return [];
  const seeds: string[] = [];
  for (const file of files) {
    const candidates = scriptPathCandidates(file.path);
    for (const candidate of candidates) {
      if (tokens.has(candidate)) {
        seeds.push(stripPackagePrefix(file.path));
        break;
      }
    }
  }
  return seeds;
}

export function scriptPathCandidates(path: string): Set<string> {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const withoutPackage = normalized.startsWith("package/")
    ? normalized.slice("package/".length)
    : normalized;
  const basename = withoutPackage.split("/").at(-1) ?? withoutPackage;
  const baseValues = [normalized, withoutPackage, basename];
  const values = [...baseValues];
  for (const value of baseValues) {
    values.push(value.replace(/\.[^/.]+$/, ""));
  }
  return new Set(values.filter(Boolean));
}

export function scriptCommandTokens(command: string): string[] {
  return [...command.matchAll(/(?:\.\/)?[\w@./-]+(?:\.[\w-]+)?\b/g)].map((match) =>
    match[0].replace(/^\.\//, ""),
  );
}

function relativeSpecifiers(text: string, rootRelativeModuleImports: boolean): string[] {
  const specifiers: string[] = [];
  const patterns = rootRelativeModuleImports
    ? [...RELATIVE_SPECIFIER_PATTERNS, ...ROOT_RELATIVE_MODULE_SPECIFIER_PATTERNS]
    : RELATIVE_SPECIFIER_PATTERNS;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  specifiers.push(...staticModuleDeclarationSpecifiers(text, rootRelativeModuleImports));
  return specifiers;
}

function staticModuleDeclarationSpecifiers(
  text: string,
  rootRelativeModuleImports: boolean,
): string[] {
  const tokens = tokenizeJs(text, { sourceGoal: "module" }).filter(
    (token) => token.type !== "ws" && token.type !== "comment",
  );
  const specifiers: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const declaration = tokenText(tokens[index], text);
    if (declaration !== "import" && declaration !== "export") continue;
    if (isMemberSeparator(tokenText(tokens[index - 1], text))) continue;
    if (
      declaration === "import" &&
      (tokenText(tokens[index + 1], text) === "(" || tokenText(tokens[index + 1], text) === ".")
    ) {
      continue;
    }
    if (
      declaration === "export" &&
      [
        "async",
        "class",
        "const",
        "default",
        "enum",
        "function",
        "interface",
        "let",
        "var",
      ].includes(tokenText(tokens[index + 1], text))
    ) {
      continue;
    }

    for (let sourceIndex = index + 1; sourceIndex < tokens.length; sourceIndex += 1) {
      const sourceToken = tokens[sourceIndex];
      const sourceText = tokenText(sourceToken, text);
      if (sourceText === ";") break;
      const isSideEffectImport =
        declaration === "import" && sourceIndex === index + 1 && sourceToken?.type === "string";
      const isFromSource = sourceText === "from" && tokens[sourceIndex + 1]?.type === "string";
      if (!isSideEffectImport && !isFromSource) continue;
      const pathToken = isSideEffectImport ? sourceToken : tokens[sourceIndex + 1];
      const path = pathToken?.value;
      if (
        path?.startsWith("./") ||
        path?.startsWith("../") ||
        (rootRelativeModuleImports && path?.startsWith("/"))
      ) {
        specifiers.push(path);
      }
      break;
    }
  }
  return specifiers;
}

type WebExtensionResourceProperty = "file" | "files" | "js" | "panel" | "path" | "popup" | "url";
type WebExtensionScriptValueShape =
  | "string"
  | "string-array"
  | "string-or-string-array"
  | "file-object-array";
type WebExtensionResourceArgument = "first" | "first-object";
type WebExtensionResourceResolution =
  | "document"
  | "document-module"
  | "document-module-pathname"
  | "document-or-root"
  | "document-root"
  | "module"
  | "module-pathname"
  | "root";

type WebExtensionResourceSpecifier =
  | {
      path: string;
      resolution: WebExtensionResourceResolution;
      inheritsExecutionContext?: boolean;
    }
  | { inlineDocument: string };

interface DynamicDocumentBaseSpecifier {
  documentBasePath: string;
  resolution: "document" | "document-module" | "root";
}

interface StaticWebExtensionDependencies {
  documentBases: DynamicDocumentBaseSpecifier[];
  resources: WebExtensionResourceSpecifier[];
}

interface ImportScriptsSpecifier {
  path: string;
  resolution: "extension-root" | "script";
}

type WebExtensionResourceCall =
  | {
      openIndex: number;
      source: "property";
      property: WebExtensionResourceProperty;
      valueShape: WebExtensionScriptValueShape;
      argument: WebExtensionResourceArgument;
      resolution: WebExtensionResourceResolution;
    }
  | { openIndex: number; source: "argument"; argumentIndex: number };

const STATIC_BROWSER_GLOBALS = new Set(["globalThis", "parent", "self", "this", "top", "window"]);
const STATIC_WORKER_GLOBALS = new Set(["globalThis", "self", "this"]);
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const BROWSER_NAVIGATION_EXPRESSION_CONTINUATIONS = new Set([
  "!=",
  "!==",
  "%",
  "%=",
  "&",
  "&&",
  "&&=",
  "&=",
  "(",
  "*",
  "**",
  "**=",
  "*=",
  "+",
  "++",
  "+=",
  "-",
  "--",
  "-=",
  ".",
  "/",
  "/=",
  ":",
  "<",
  "<<",
  "<<=",
  "<=",
  "=",
  "==",
  "===",
  "=>",
  ">",
  ">=",
  ">>",
  ">>=",
  ">>>",
  ">>>=",
  "?",
  "?.",
  "??",
  "??=",
  "[",
  "^",
  "^=",
  "as",
  "in",
  "instanceof",
  "satisfies",
  "|",
  "|=",
  "||",
  "||=",
]);

// Classic workers may load more packaged scripts without a module edge. Parse
// only literal arguments on the worker-global call so API-shaped text in
// strings, comments, regexes, or unrelated object methods stays inert.
function staticImportScriptsSpecifiers(text: string): ImportScriptsSpecifier[] {
  const tokens = tokenizeJs(text).filter(
    (token) => token.type !== "ws" && token.type !== "comment",
  );
  const specifiers: ImportScriptsSpecifier[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokenText(tokens[index], text);
    let callIndex: number | null = null;
    if (
      current === "importScripts" &&
      !isMemberSeparator(tokenText(tokens[index - 1], text)) &&
      tokenText(tokens[index - 1], text) !== "]"
    ) {
      callIndex = index + 1;
    } else if (STATIC_WORKER_GLOBALS.has(current)) {
      const member = staticMemberAccess(tokens, text, index + 1);
      if (member?.name === "importScripts") callIndex = member.nextIndex;
    }
    if (callIndex === null) continue;

    const openIndex = staticCallOpenIndex(tokens, text, callIndex);
    if (openIndex === null) continue;
    const closeIndex = matchingPunctuation(tokens, text, openIndex, "(", ")");
    if (closeIndex === null) continue;
    for (const [start, end] of staticCallArgumentRanges(tokens, text, openIndex + 1, closeIndex)) {
      if (end === start + 1) {
        const path = staticScriptPath(tokens[start], text);
        if (path !== null) specifiers.push({ path, resolution: "script" });
        continue;
      }
      const runtimeUrl = staticWebExtensionGetUrlPath(tokens, text, start);
      if (runtimeUrl?.nextIndex === end) {
        specifiers.push({ path: runtimeUrl.path, resolution: "extension-root" });
      }
    }
    index = closeIndex;
  }
  return specifiers;
}

// WebExtension APIs and runtime- or module-URL dynamic imports can make packaged
// scripts or HTML documents executable without a manifest or literal module edge.
// Follow only literal resource properties on the statically named APIs; dynamic
// expressions remain unproven. The shared lexer keeps API-shaped text in
// comments, strings, and regular expressions inert.
function staticWebExtensionDependencies(text: string): StaticWebExtensionDependencies {
  const tokens = tokenizeJs(text).filter(
    (token) => token.type !== "ws" && token.type !== "comment",
  );
  const documentBases: DynamicDocumentBaseSpecifier[] = [];
  const resources: WebExtensionResourceSpecifier[] = [];
  const domConsumerBindings = staticDomConsumerBindings(tokens, text);

  for (let index = 0; index < tokens.length; index += 1) {
    const dynamicImport = staticBrowserDynamicImportResource(tokens, text, index);
    if (dynamicImport) resources.push(dynamicImport);
    const navigation = staticBrowserNavigationResource(tokens, text, index);
    if (navigation) resources.push(navigation);
    const worklet = staticWorkletModuleResource(tokens, text, index);
    if (worklet) resources.push(worklet);
    const documentBase = staticDynamicDocumentBaseResource(
      tokens,
      text,
      index,
      domConsumerBindings.documentBases,
    );
    if (documentBase) documentBases.push(documentBase);
    const domResource = staticDomConsumerResource(
      tokens,
      text,
      index,
      domConsumerBindings.elements,
    );
    if (domResource) resources.push(domResource);
    const appendedDomResource = staticAppendedDomConsumerResource(tokens, text, index);
    if (appendedDomResource) resources.push(appendedDomResource);
    resources.push(...staticDomInlineDocuments(tokens, text, index));
    const call = webExtensionScriptCall(tokens, text, index);
    if (!call) continue;
    const closeIndex = matchingPunctuation(tokens, text, call.openIndex, "(", ")");
    if (closeIndex === null) continue;
    if (call.source === "property") {
      const argumentRanges = staticCallArgumentRanges(tokens, text, call.openIndex + 1, closeIndex);
      const selectedRanges =
        call.argument === "first"
          ? argumentRanges.slice(0, 1)
          : argumentRanges.filter(([start]) => tokenText(tokens[start], text) === "{").slice(0, 1);
      for (const [start, end] of selectedRanges) {
        resources.push(
          ...staticPropertyScriptPaths(
            tokens,
            text,
            start,
            end,
            call.property,
            call.valueShape,
            call.resolution,
          ),
        );
      }
    } else {
      const path = staticLiteralCallArgument(
        tokens,
        text,
        call.openIndex + 1,
        closeIndex,
        call.argumentIndex,
      );
      if (path !== null) resources.push({ path, resolution: "root" });
    }
  }

  return { documentBases, resources };
}

// Packaged scripts and documents can become executable without a WebExtension
// API when an extension page creates a resource-bearing element and assigns a
// literal local URL or inline document. Requiring an observable append, click,
// or navigation would introduce fragile local data-flow assumptions, so the
// assignment itself is conservative evidence of reachability.
const DOM_CONSUMER_ELEMENT_PROPERTIES = new Map<string, ReadonlySet<string>>([
  ["a", new Set(["href"])],
  ["area", new Set(["href"])],
  ["button", new Set(["formAction", "formaction"])],
  ["script", new Set(["src"])],
  ["frame", new Set(["src"])],
  ["iframe", new Set(["src", "srcdoc"])],
  ["embed", new Set(["src"])],
  ["object", new Set(["data"])],
  ["form", new Set(["action"])],
  ["input", new Set(["formAction", "formaction"])],
]);
const SVG_DOM_CONSUMER_ELEMENT_PROPERTIES = new Map<string, ReadonlySet<string>>([
  ["a", new Set(["href"])],
  ["script", new Set(["href"])],
]);

interface StaticDomConsumerElement {
  namespace: "html" | "svg";
  tag: string;
  nextIndex: number;
}

interface StaticDomConsumerElementBinding {
  properties: Set<string>;
  inheritsExecutionContext: boolean;
}

interface StaticDomConsumerBindings {
  documentBases: Set<string>;
  elements: Map<string, StaticDomConsumerElementBinding>;
}

function staticDomConsumerElementProperties(
  element: StaticDomConsumerElement,
): ReadonlySet<string> | undefined {
  const properties =
    element.namespace === "html"
      ? DOM_CONSUMER_ELEMENT_PROPERTIES
      : SVG_DOM_CONSUMER_ELEMENT_PROPERTIES;
  return properties.get(element.tag.slice(element.tag.lastIndexOf(":") + 1).toLowerCase());
}

function staticDomConsumerElementInheritsExecutionContext(
  element: StaticDomConsumerElement,
): boolean {
  return element.tag.slice(element.tag.lastIndexOf(":") + 1).toLowerCase() === "script";
}

function staticDomConsumerBindings(tokens: JsToken[], text: string): StaticDomConsumerBindings {
  const documentBases = new Set<string>();
  const elements = new Map<string, StaticDomConsumerElementBinding>();
  for (let index = 0; index < tokens.length - 2; index += 1) {
    const declaration = tokenText(tokens[index - 1], text);
    const binding = tokens[index];
    if (binding?.type !== "ident" || tokenText(tokens[index + 1], text) !== "=") continue;
    if (
      declaration !== "const" &&
      declaration !== "let" &&
      declaration !== "var" &&
      isMemberSeparator(declaration)
    ) {
      continue;
    }
    const element = staticDocumentCreateElement(tokens, text, index + 2);
    if (!element) continue;
    const bindingName = staticIdentifierName(binding, text);
    if (bindingName === null) continue;
    if (
      element.namespace === "html" &&
      element.tag.slice(element.tag.lastIndexOf(":") + 1).toLowerCase() === "base"
    ) {
      documentBases.add(bindingName);
    }
    const properties = staticDomConsumerElementProperties(element);
    if (!properties) continue;
    const bindingRecord = elements.get(bindingName) ?? {
      properties: new Set<string>(),
      inheritsExecutionContext: false,
    };
    for (const property of properties) bindingRecord.properties.add(property);
    bindingRecord.inheritsExecutionContext ||=
      staticDomConsumerElementInheritsExecutionContext(element);
    elements.set(bindingName, bindingRecord);
  }
  return { documentBases, elements };
}

function staticDocumentCreateElement(
  tokens: JsToken[],
  text: string,
  start: number,
): StaticDomConsumerElement | null {
  let index = start;
  const first = staticIdentifierName(tokens[index], text) ?? tokenText(tokens[index], text);
  if (STATIC_BROWSER_GLOBALS.has(first)) {
    let member = staticMemberAccess(tokens, text, index + 1);
    if (!member) return null;
    while (STATIC_BROWSER_GLOBALS.has(member.name)) {
      member = staticMemberAccess(tokens, text, member.nextIndex);
      if (!member) return null;
    }
    if (member.name !== "document") return null;
    index = member.nextIndex;
  } else if (first === "document") {
    index += 1;
  } else {
    return null;
  }

  const createElement = staticMemberAccess(tokens, text, index);
  if (createElement?.name !== "createElement" && createElement?.name !== "createElementNS") {
    return null;
  }
  const openIndex = staticCallOpenIndex(tokens, text, createElement.nextIndex);
  if (openIndex === null) return null;
  const closeIndex = matchingPunctuation(tokens, text, openIndex, "(", ")");
  if (closeIndex === null) return null;
  if (createElement.name === "createElement") {
    const tag = staticLiteralCallArgument(tokens, text, openIndex + 1, closeIndex, 0);
    return tag === null ? null : { namespace: "html", tag, nextIndex: closeIndex + 1 };
  }
  const namespace = staticLiteralCallArgument(tokens, text, openIndex + 1, closeIndex, 0);
  const tag = staticLiteralCallArgument(tokens, text, openIndex + 1, closeIndex, 1);
  if (tag === null) return null;
  if (namespace === HTML_NAMESPACE) {
    return { namespace: "html", tag, nextIndex: closeIndex + 1 };
  }
  return namespace === SVG_NAMESPACE ? { namespace: "svg", tag, nextIndex: closeIndex + 1 } : null;
}

function staticDomConsumerResource(
  tokens: JsToken[],
  text: string,
  start: number,
  consumerElementBindings: Map<string, StaticDomConsumerElementBinding>,
): WebExtensionResourceSpecifier | null {
  const binding = staticIdentifierName(tokens[start], text) ?? tokenText(tokens[start], text);
  const bindingRecord = consumerElementBindings.get(binding);
  if (!bindingRecord || isMemberSeparator(tokenText(tokens[start - 1], text))) {
    return null;
  }
  const member = staticMemberAccess(tokens, text, start + 1);
  if (!member) return null;

  return staticDomConsumerMemberResource(
    tokens,
    text,
    member,
    bindingRecord.properties,
    bindingRecord.inheritsExecutionContext,
  );
}

function staticDynamicDocumentBaseResource(
  tokens: JsToken[],
  text: string,
  start: number,
  documentBaseBindings: ReadonlySet<string>,
): DynamicDocumentBaseSpecifier | null {
  const binding = staticIdentifierName(tokens[start], text) ?? tokenText(tokens[start], text);
  if (!documentBaseBindings.has(binding) || isMemberSeparator(tokenText(tokens[start - 1], text))) {
    return null;
  }
  const member = staticMemberAccess(tokens, text, start + 1);
  if (!member) return null;
  const resource = staticDomConsumerMemberResource(tokens, text, member, new Set(["href"]), false);
  if (!resource || "inlineDocument" in resource) return null;
  if (
    resource.resolution !== "document" &&
    resource.resolution !== "document-module" &&
    resource.resolution !== "root"
  ) {
    return null;
  }
  return { documentBasePath: resource.path, resolution: resource.resolution };
}

function staticAppendedDomConsumerResource(
  tokens: JsToken[],
  text: string,
  start: number,
): WebExtensionResourceSpecifier | null {
  const appendChild = staticMemberAccess(tokens, text, start);
  if (appendChild?.name !== "appendChild") return null;
  const openIndex = staticCallOpenIndex(tokens, text, appendChild.nextIndex);
  if (openIndex === null) return null;
  const closeIndex = matchingPunctuation(tokens, text, openIndex, "(", ")");
  if (closeIndex === null) return null;
  const arguments_ = staticCallArgumentRanges(tokens, text, openIndex + 1, closeIndex);
  if (arguments_.length !== 1) return null;
  const [elementStart, elementEnd] = arguments_[0];
  const element = staticDocumentCreateElement(tokens, text, elementStart);
  if (!element || element.nextIndex !== elementEnd) return null;
  const resourceProperties = staticDomConsumerElementProperties(element);
  if (!resourceProperties) return null;
  const member = staticMemberAccess(tokens, text, closeIndex + 1);
  if (!member) return null;

  return staticDomConsumerMemberResource(
    tokens,
    text,
    member,
    resourceProperties,
    staticDomConsumerElementInheritsExecutionContext(element),
  );
}

function staticDomConsumerMemberResource(
  tokens: JsToken[],
  text: string,
  member: { name: string; nextIndex: number },
  resourceProperties: ReadonlySet<string>,
  inheritsExecutionContext: boolean,
): WebExtensionResourceSpecifier | null {
  if (member.name === "setAttribute" || member.name === "setAttributeNS") {
    const openIndex = staticCallOpenIndex(tokens, text, member.nextIndex);
    if (openIndex === null) return null;
    const closeIndex = matchingPunctuation(tokens, text, openIndex, "(", ")");
    if (closeIndex === null) return null;
    const arguments_ = staticCallArgumentRanges(tokens, text, openIndex + 1, closeIndex);
    const nameArgument = member.name === "setAttributeNS" ? 1 : 0;
    const valueArgument = nameArgument + 1;
    if (arguments_.length <= valueArgument) return null;
    const [nameStart, nameEnd] = arguments_[nameArgument];
    const rawProperty =
      nameEnd === nameStart + 1 ? staticScriptPath(tokens[nameStart], text)?.toLowerCase() : null;
    const property = rawProperty?.slice(rawProperty.lastIndexOf(":") + 1) ?? null;
    if (!property || !resourceProperties.has(property)) return null;
    const [valueStart, valueEnd] = arguments_[valueArgument];
    if (property === "srcdoc") {
      const inlineDocument =
        valueEnd === valueStart + 1 ? staticScriptPath(tokens[valueStart], text) : null;
      return inlineDocument === null ? null : { inlineDocument };
    }
    const value = staticWebExtensionResourcePath(tokens, text, valueStart, [
      tokenText(tokens[valueEnd], text),
    ]);
    if (value?.nextIndex !== valueEnd) return null;
    return {
      path: value.path,
      resolution: value.moduleUrl
        ? value.modulePathname
          ? "document-module-pathname"
          : "document-module"
        : value.runtimeUrl
          ? "root"
          : "document",
      ...(inheritsExecutionContext ? { inheritsExecutionContext: true } : {}),
    };
  }

  if (!resourceProperties.has(member.name)) return null;

  let assignmentIndex = member.nextIndex;
  if (member.name === "href") {
    const nestedMember = staticMemberAccess(tokens, text, assignmentIndex);
    if (nestedMember?.name === "baseVal") assignmentIndex = nestedMember.nextIndex;
  }
  if (tokenText(tokens[assignmentIndex], text) !== "=") return null;

  const valueIndex = assignmentIndex + 1;
  if (member.name === "srcdoc") {
    const inlineDocument = staticScriptPath(tokens[valueIndex], text);
    if (inlineDocument === null) return null;
    const value = {
      path: inlineDocument,
      nextIndex: valueIndex + 1,
      runtimeUrl: false,
      moduleUrl: false,
      modulePathname: false,
    };
    return browserNavigationAssignmentEnds(tokens, text, value, ["", ",", ";", ")", "]", "}"])
      ? { inlineDocument }
      : null;
  }
  const allowedFollowingTokens = ["", ",", ";", ")", "]", "}"];
  const runtimeUrl = staticWebExtensionGetUrlPath(tokens, text, valueIndex);
  const parsingFollowingTokens = runtimeUrl
    ? [...allowedFollowingTokens, tokenText(tokens[runtimeUrl.nextIndex], text)]
    : allowedFollowingTokens;
  const value = staticWebExtensionResourcePath(tokens, text, valueIndex, parsingFollowingTokens);
  if (!value || !browserNavigationAssignmentEnds(tokens, text, value, allowedFollowingTokens)) {
    return null;
  }
  return {
    path: value.path,
    resolution: value.moduleUrl
      ? value.modulePathname
        ? "document-module-pathname"
        : "document-module"
      : value.runtimeUrl
        ? "root"
        : "document",
    ...(inheritsExecutionContext ? { inheritsExecutionContext: true } : {}),
  };
}

function staticDomInlineDocuments(
  tokens: JsToken[],
  text: string,
  start: number,
): Array<{ inlineDocument: string }> {
  const documents: Array<{ inlineDocument: string }> = [];
  const member = staticMemberAccess(tokens, text, start);
  if (member?.name === "innerHTML" || member?.name === "outerHTML") {
    const assignmentIndex = member.nextIndex;
    const valueIndex = assignmentIndex + 1;
    const inlineDocument = staticScriptPath(tokens[valueIndex], text);
    if (
      (tokenText(tokens[assignmentIndex], text) === "=" ||
        tokenText(tokens[assignmentIndex], text) === "+=") &&
      inlineDocument !== null &&
      browserNavigationAssignmentEnds(
        tokens,
        text,
        {
          path: inlineDocument,
          nextIndex: valueIndex + 1,
          runtimeUrl: false,
          moduleUrl: false,
          modulePathname: false,
        },
        ["", ",", ";", ")", "]", "}"],
      )
    ) {
      documents.push({ inlineDocument });
    }
  }

  if (member?.name === "insertAdjacentHTML") {
    const openIndex = staticCallOpenIndex(tokens, text, member.nextIndex);
    if (openIndex !== null) {
      const closeIndex = matchingPunctuation(tokens, text, openIndex, "(", ")");
      if (closeIndex !== null) {
        const inlineDocument = staticLiteralCallArgument(
          tokens,
          text,
          openIndex + 1,
          closeIndex,
          1,
        );
        if (inlineDocument !== null) documents.push({ inlineDocument });
      }
    }
  }

  const writeOpenIndex = staticDocumentWriteCallOpenIndex(tokens, text, start);
  if (writeOpenIndex === null) return documents;
  const writeCloseIndex = matchingPunctuation(tokens, text, writeOpenIndex, "(", ")");
  if (writeCloseIndex === null) return documents;
  const fragments: string[] = [];
  for (const [fragmentStart, fragmentEnd] of staticCallArgumentRanges(
    tokens,
    text,
    writeOpenIndex + 1,
    writeCloseIndex,
  )) {
    if (fragmentEnd !== fragmentStart + 1) return documents;
    const fragment = staticScriptPath(tokens[fragmentStart], text);
    if (fragment === null) return documents;
    fragments.push(fragment);
  }
  if (fragments.length) documents.push({ inlineDocument: fragments.join("") });
  return documents;
}

function staticDocumentWriteCallOpenIndex(
  tokens: JsToken[],
  text: string,
  start: number,
): number | null {
  if (start > 0 && isMemberSeparator(tokenText(tokens[start - 1], text))) return null;

  let index = start;
  const first = staticIdentifierName(tokens[index], text) ?? tokenText(tokens[index], text);
  if (STATIC_BROWSER_GLOBALS.has(first)) {
    let member = staticMemberAccess(tokens, text, index + 1);
    if (!member) return null;
    while (STATIC_BROWSER_GLOBALS.has(member.name)) {
      member = staticMemberAccess(tokens, text, member.nextIndex);
      if (!member) return null;
    }
    if (member.name !== "document") return null;
    index = member.nextIndex;
  } else if (first === "document") {
    index += 1;
  } else {
    return null;
  }

  const method = staticMemberAccess(tokens, text, index);
  if (method?.name !== "write" && method?.name !== "writeln") return null;
  return staticCallOpenIndex(tokens, text, method.nextIndex);
}

function staticBrowserDynamicImportResource(
  tokens: JsToken[],
  text: string,
  start: number,
): WebExtensionResourceSpecifier | null {
  if (
    tokenText(tokens[start], text) !== "import" ||
    isMemberSeparator(tokenText(tokens[start - 1], text))
  ) {
    return null;
  }
  const openIndex = staticCallOpenIndex(tokens, text, start + 1);
  if (openIndex === null) return null;
  const closeIndex = matchingPunctuation(tokens, text, openIndex, "(", ")");
  if (closeIndex === null) return null;
  const firstArgument = staticCallArgumentRanges(tokens, text, openIndex + 1, closeIndex)[0];
  if (!firstArgument) return null;
  const resource = staticWebExtensionResourcePath(tokens, text, firstArgument[0], [
    tokenText(tokens[firstArgument[1]], text),
  ]);
  if (
    !resource ||
    resource.nextIndex !== firstArgument[1] ||
    (!resource.runtimeUrl && !resource.moduleUrl)
  ) {
    return null;
  }
  return {
    path: resource.path,
    resolution: resource.moduleUrl
      ? resource.modulePathname
        ? "module-pathname"
        : "module"
      : "root",
    inheritsExecutionContext: true,
  };
}

function staticWorkletModuleResource(
  tokens: JsToken[],
  text: string,
  start: number,
): WebExtensionResourceSpecifier | null {
  const current = staticIdentifierName(tokens[start], text) ?? tokenText(tokens[start], text);
  let workletMember: { name: string; nextIndex: number } | null = null;
  if (current === "CSS" && !isMemberSeparator(tokenText(tokens[start - 1], text))) {
    const member = staticMemberAccess(tokens, text, start + 1);
    if (member && ["animationWorklet", "layoutWorklet", "paintWorklet"].includes(member.name)) {
      workletMember = member;
    }
  } else if (
    current === "audioWorklet" &&
    (isMemberSeparator(tokenText(tokens[start - 1], text)) ||
      tokenText(tokens[start - 1], text) === "]")
  ) {
    workletMember = { name: current, nextIndex: start + 1 };
  }
  if (!workletMember) return null;

  const addModule = staticMemberAccess(tokens, text, workletMember.nextIndex);
  if (addModule?.name !== "addModule") return null;
  const openIndex = staticCallOpenIndex(tokens, text, addModule.nextIndex);
  if (openIndex === null) return null;
  const closeIndex = matchingPunctuation(tokens, text, openIndex, "(", ")");
  if (closeIndex === null) return null;
  const firstArgument = staticCallArgumentRanges(tokens, text, openIndex + 1, closeIndex)[0];
  if (!firstArgument) return null;
  const resource = staticWebExtensionResourcePath(tokens, text, firstArgument[0], [
    tokenText(tokens[firstArgument[1]], text),
  ]);
  if (!resource || resource.nextIndex !== firstArgument[1]) return null;
  return {
    path: resource.path,
    resolution: resource.moduleUrl
      ? resource.modulePathname
        ? "document-module-pathname"
        : "document-module"
      : resource.runtimeUrl
        ? "root"
        : "document",
  };
}

function staticBrowserNavigationResource(
  tokens: JsToken[],
  text: string,
  start: number,
): WebExtensionResourceSpecifier | null {
  if (start > 0 && isMemberSeparator(tokenText(tokens[start - 1], text))) return null;

  let index = start;
  const first = staticIdentifierName(tokens[index], text) ?? tokenText(tokens[index], text);
  if (first === "open") {
    const openIndex = staticCallOpenIndex(tokens, text, index + 1);
    if (openIndex === null) return null;
    const closeIndex = matchingPunctuation(tokens, text, openIndex, "(", ")");
    if (closeIndex === null) return null;
    return staticBrowserNavigationCallResource(tokens, text, openIndex, closeIndex);
  }
  if (STATIC_BROWSER_GLOBALS.has(first)) {
    let member = staticMemberAccess(tokens, text, index + 1);
    if (!member) return null;
    while (STATIC_BROWSER_GLOBALS.has(member.name)) {
      member = staticMemberAccess(tokens, text, member.nextIndex);
      if (!member) return null;
    }
    if (member.name === "document") {
      member = staticMemberAccess(tokens, text, member.nextIndex);
      if (member?.name !== "location") return null;
      index = member.nextIndex;
    } else {
      if (member.name === "open") {
        const openIndex = staticCallOpenIndex(tokens, text, member.nextIndex);
        if (openIndex === null) return null;
        const closeIndex = matchingPunctuation(tokens, text, openIndex, "(", ")");
        if (closeIndex === null) return null;
        return staticBrowserNavigationCallResource(tokens, text, openIndex, closeIndex);
      }
      if (member.name !== "location") return null;
      index = member.nextIndex;
    }
  } else if (first === "document") {
    const member = staticMemberAccess(tokens, text, index + 1);
    if (member?.name !== "location") return null;
    index = member.nextIndex;
  } else if (first === "location") {
    index += 1;
  } else {
    return null;
  }

  if (tokenText(tokens[index], text) === "=") {
    return staticBrowserNavigationAssignmentResource(tokens, text, index + 1);
  }
  const member = staticMemberAccess(tokens, text, index);
  if (!member) return null;
  if (member.name === "href" && tokenText(tokens[member.nextIndex], text) === "=") {
    return staticBrowserNavigationAssignmentResource(tokens, text, member.nextIndex + 1);
  }
  if (member.name === "pathname" && tokenText(tokens[member.nextIndex], text) === "=") {
    return staticBrowserPathnameAssignmentResource(tokens, text, member.nextIndex + 1);
  }
  if (member.name !== "assign" && member.name !== "replace") return null;
  const openIndex = staticCallOpenIndex(tokens, text, member.nextIndex);
  if (openIndex === null) return null;
  const closeIndex = matchingPunctuation(tokens, text, openIndex, "(", ")");
  if (closeIndex === null) return null;
  return staticBrowserNavigationCallResource(tokens, text, openIndex, closeIndex);
}

function staticBrowserPathnameAssignmentResource(
  tokens: JsToken[],
  text: string,
  valueIndex: number,
): WebExtensionResourceSpecifier | null {
  const path = staticScriptPath(tokens[valueIndex], text);
  if (path === null) return null;
  const allowedFollowingTokens = ["", ",", ";", ")", "]", "}"];
  const value: StaticWebExtensionResourcePath = {
    path,
    nextIndex: valueIndex + 1,
    runtimeUrl: false,
    moduleUrl: false,
    modulePathname: false,
  };
  if (!browserNavigationAssignmentEnds(tokens, text, value, allowedFollowingTokens)) return null;
  return { path, resolution: "document-root" };
}

function staticBrowserNavigationCallResource(
  tokens: JsToken[],
  text: string,
  openIndex: number,
  closeIndex: number,
): WebExtensionResourceSpecifier | null {
  const firstArgument = staticCallArgumentRanges(tokens, text, openIndex + 1, closeIndex)[0];
  if (!firstArgument) return null;
  return staticBrowserNavigationValue(tokens, text, firstArgument[0], firstArgument[1]);
}

function staticBrowserNavigationAssignmentResource(
  tokens: JsToken[],
  text: string,
  valueIndex: number,
): WebExtensionResourceSpecifier | null {
  const allowedFollowingTokens = ["", ",", ";", ")", "]", "}"];
  const runtimeUrl = staticWebExtensionGetUrlPath(tokens, text, valueIndex);
  const parsingFollowingTokens = runtimeUrl
    ? [...allowedFollowingTokens, tokenText(tokens[runtimeUrl.nextIndex], text)]
    : allowedFollowingTokens;
  const value = staticWebExtensionResourcePath(tokens, text, valueIndex, parsingFollowingTokens);
  if (!value || !browserNavigationAssignmentEnds(tokens, text, value, allowedFollowingTokens)) {
    return null;
  }
  return {
    path: value.path,
    resolution: value.moduleUrl
      ? value.modulePathname
        ? "document-module-pathname"
        : "document-module"
      : value.runtimeUrl
        ? "document-root"
        : "document",
  };
}

function browserNavigationAssignmentEnds(
  tokens: JsToken[],
  text: string,
  value: StaticWebExtensionResourcePath,
  allowedFollowingTokens: string[],
): boolean {
  const next = tokens[value.nextIndex];
  const nextText = tokenText(next, text);
  if (allowedFollowingTokens.includes(nextText)) return true;
  const previous = tokens[value.nextIndex - 1];
  if (!previous || !next || !/[\n\r\u2028\u2029]/.test(text.slice(previous.end, next.start))) {
    return false;
  }
  return next.type !== "template" && !BROWSER_NAVIGATION_EXPRESSION_CONTINUATIONS.has(nextText);
}

function staticBrowserNavigationValue(
  tokens: JsToken[],
  text: string,
  start: number,
  end: number,
): WebExtensionResourceSpecifier | null {
  const value = staticWebExtensionResourcePath(tokens, text, start, [tokenText(tokens[end], text)]);
  if (!value || value.nextIndex !== end) return null;
  return {
    path: value.path,
    resolution: value.moduleUrl
      ? value.modulePathname
        ? "document-module-pathname"
        : "document-module"
      : value.runtimeUrl
        ? "document-root"
        : "document",
  };
}

function webExtensionScriptCall(
  tokens: JsToken[],
  text: string,
  start: number,
): WebExtensionResourceCall | null {
  if (start > 0 && isMemberSeparator(tokenText(tokens[start - 1], text))) return null;

  let index = start;
  let first = staticIdentifierName(tokens[index], text) ?? tokenText(tokens[index], text);
  let browserQualified = false;
  if (STATIC_BROWSER_GLOBALS.has(first)) {
    const globalMember = staticMemberAccess(tokens, text, index + 1);
    if (!globalMember || (globalMember.name !== "chrome" && globalMember.name !== "browser")) {
      return null;
    }
    first = globalMember.name;
    index = globalMember.nextIndex - 1;
  }
  let namespace: string;
  if (first === "chrome" || first === "browser") {
    browserQualified = true;
    const member = staticMemberAccess(tokens, text, index + 1);
    if (!member) return null;
    namespace = member.name;
    index = member.nextIndex;
  } else {
    namespace = first;
    index += 1;
  }

  let subnamespace: string | null = null;
  if (namespace === "devtools") {
    const member = staticMemberAccess(tokens, text, index);
    if (!member) return null;
    subnamespace = member.name;
    index = member.nextIndex;
  }

  if (
    !browserQualified &&
    (namespace === "action" ||
      namespace === "browserAction" ||
      namespace === "pageAction" ||
      namespace === "sidebarAction" ||
      namespace === "sidePanel" ||
      namespace === "devtools")
  ) {
    return null;
  }

  if (
    namespace !== "tabs" &&
    namespace !== "windows" &&
    namespace !== "scripting" &&
    namespace !== "contentScripts" &&
    namespace !== "userScripts" &&
    namespace !== "offscreen" &&
    namespace !== "action" &&
    namespace !== "browserAction" &&
    namespace !== "pageAction" &&
    namespace !== "sidebarAction" &&
    namespace !== "sidePanel" &&
    namespace !== "devtools"
  ) {
    return null;
  }
  const methodMember = staticMemberAccess(tokens, text, index);
  if (!methodMember) return null;
  const method = methodMember.name;
  const openIndex = staticCallOpenIndex(tokens, text, methodMember.nextIndex);
  if (openIndex === null) return null;
  if (namespace === "tabs" && method === "create") {
    return {
      openIndex,
      source: "property",
      property: "url",
      valueShape: "string",
      argument: "first",
      resolution: "document-or-root",
    };
  }
  if (namespace === "tabs" && method === "update") {
    return {
      openIndex,
      source: "property",
      property: "url",
      valueShape: "string",
      argument: "first-object",
      resolution: "document-or-root",
    };
  }
  if (namespace === "windows" && method === "create") {
    return {
      openIndex,
      source: "property",
      property: "url",
      valueShape: "string-or-string-array",
      argument: "first",
      resolution: "document-or-root",
    };
  }
  if (namespace === "tabs" && method === "executeScript") {
    return {
      openIndex,
      source: "property",
      property: "file",
      valueShape: "string",
      argument: "first-object",
      resolution: "document-or-root",
    };
  }
  if (namespace === "scripting" && method === "executeScript") {
    return {
      openIndex,
      source: "property",
      property: "files",
      valueShape: "string-array",
      argument: "first",
      resolution: "root",
    };
  }
  if (
    namespace === "scripting" &&
    (method === "registerContentScripts" || method === "updateContentScripts")
  ) {
    return {
      openIndex,
      source: "property",
      property: "js",
      valueShape: "string-array",
      argument: "first",
      resolution: "root",
    };
  }
  if (namespace === "contentScripts" && method === "register") {
    return {
      openIndex,
      source: "property",
      property: "js",
      valueShape: "file-object-array",
      argument: "first",
      resolution: "root",
    };
  }
  if (
    namespace === "userScripts" &&
    (method === "register" || method === "update" || method === "execute")
  ) {
    return {
      openIndex,
      source: "property",
      property: "js",
      valueShape: "file-object-array",
      argument: "first",
      resolution: "root",
    };
  }
  if (namespace === "offscreen" && method === "createDocument") {
    return {
      openIndex,
      source: "property",
      property: "url",
      valueShape: "string",
      argument: "first",
      resolution: "root",
    };
  }
  if (
    (namespace === "action" || namespace === "browserAction" || namespace === "pageAction") &&
    method === "setPopup"
  ) {
    return {
      openIndex,
      source: "property",
      property: "popup",
      valueShape: "string",
      argument: "first",
      resolution: "root",
    };
  }
  if (namespace === "sidePanel" && method === "setOptions") {
    return {
      openIndex,
      source: "property",
      property: "path",
      valueShape: "string",
      argument: "first",
      resolution: "root",
    };
  }
  if (namespace === "sidebarAction" && method === "setPanel") {
    return {
      openIndex,
      source: "property",
      property: "panel",
      valueShape: "string",
      argument: "first",
      resolution: "root",
    };
  }
  if (namespace === "devtools" && subnamespace === "panels" && method === "create") {
    return { openIndex, source: "argument", argumentIndex: 2 };
  }
  return null;
}

function staticPropertyScriptPaths(
  tokens: JsToken[],
  text: string,
  start: number,
  end: number,
  property: WebExtensionResourceProperty,
  valueShape: WebExtensionScriptValueShape,
  resolution: WebExtensionResourceResolution,
): WebExtensionResourceSpecifier[] {
  const paths: WebExtensionResourceSpecifier[] = [];
  const root = tokenText(tokens[start], text);
  const propertyDepth = root === "{" ? 1 : root === "[" ? 2 : null;
  if (propertyDepth === null) return paths;
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    const token = tokenText(tokens[index], text);
    const valueIndex =
      depth === propertyDepth
        ? staticObjectPropertyValueIndex(tokens, text, index, property)
        : null;
    if (valueIndex !== null) {
      if (valueShape === "string" || valueShape === "string-or-string-array") {
        const value = staticWebExtensionResourcePath(tokens, text, valueIndex, [",", "}"]);
        if (value !== null && (!value.moduleUrl || property === "url")) {
          paths.push({
            path: value.path,
            resolution: value.moduleUrl
              ? value.modulePathname
                ? "module-pathname"
                : "module"
              : value.runtimeUrl
                ? "root"
                : resolution,
          });
          continue;
        }
        if (valueShape === "string") continue;
      }
      if (tokenText(tokens[valueIndex], text) !== "[") continue;
      const closeIndex = matchingPunctuation(tokens, text, valueIndex, "[", "]");
      if (closeIndex === null || closeIndex > end) continue;
      if (valueShape === "file-object-array") {
        paths.push(
          ...staticNamedPropertyPaths(tokens, text, valueIndex + 1, closeIndex, "file", resolution),
        );
        index = closeIndex;
        continue;
      }
      let nestedDepth = 0;
      for (let itemIndex = valueIndex + 1; itemIndex < closeIndex; itemIndex += 1) {
        const item = tokenText(tokens[itemIndex], text);
        const value =
          nestedDepth === 0
            ? staticWebExtensionResourcePath(tokens, text, itemIndex, [",", "]"])
            : null;
        if (value !== null && (!value.moduleUrl || property === "url")) {
          paths.push({
            path: value.path,
            resolution: value.moduleUrl
              ? value.modulePathname
                ? "module-pathname"
                : "module"
              : value.runtimeUrl
                ? "root"
                : resolution,
          });
          itemIndex = value.nextIndex - 1;
          continue;
        }
        if (item === "[" || item === "{" || item === "(") {
          nestedDepth += 1;
          continue;
        }
        if (item === "]" || item === "}" || item === ")") {
          nestedDepth -= 1;
          continue;
        }
      }
      index = closeIndex;
      continue;
    }
    if (token === "[" || token === "{" || token === "(") {
      depth += 1;
      continue;
    }
    if (token === "]" || token === "}" || token === ")") {
      depth -= 1;
      continue;
    }
  }
  return paths;
}

function staticNamedPropertyPaths(
  tokens: JsToken[],
  text: string,
  start: number,
  end: number,
  property: string,
  resolution: WebExtensionResourceResolution,
): WebExtensionResourceSpecifier[] {
  const paths: WebExtensionResourceSpecifier[] = [];
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    const token = tokenText(tokens[index], text);
    const valueIndex =
      depth === 1 ? staticObjectPropertyValueIndex(tokens, text, index, property) : null;
    if (valueIndex !== null) {
      const value = staticWebExtensionResourcePath(tokens, text, valueIndex, [",", "}"]);
      if (value !== null && !value.moduleUrl) {
        paths.push({
          path: value.path,
          resolution: value.runtimeUrl ? "root" : resolution,
        });
      }
      continue;
    }
    if (token === "[" || token === "{" || token === "(") {
      depth += 1;
      continue;
    }
    if (token === "]" || token === "}" || token === ")") {
      depth -= 1;
      continue;
    }
  }
  return paths;
}

function staticCallArgumentRanges(
  tokens: JsToken[],
  text: string,
  start: number,
  end: number,
): Array<[start: number, end: number]> {
  const ranges: Array<[start: number, end: number]> = [];
  let argumentStart = start;
  let depth = 0;
  for (let index = start; index <= end; index += 1) {
    const value = index === end ? "," : tokenText(tokens[index], text);
    if (value === "[" || value === "{" || value === "(") depth += 1;
    else if (value === "]" || value === "}" || value === ")") depth -= 1;
    if (value !== "," || depth !== 0) continue;
    if (argumentStart < index) ranges.push([argumentStart, index]);
    argumentStart = index + 1;
  }
  return ranges;
}

interface WorkerScriptSpecifier {
  path: string;
  resolution: "document" | "module" | "module-pathname" | "root";
}

interface StaticWebExtensionResourcePath {
  path: string;
  nextIndex: number;
  runtimeUrl: boolean;
  moduleUrl: boolean;
  modulePathname: boolean;
}

function staticWebExtensionResourcePath(
  tokens: JsToken[],
  text: string,
  start: number,
  allowedFollowingTokens: string[],
): StaticWebExtensionResourcePath | null {
  const literal = staticScriptPath(tokens[start], text);
  if (literal !== null) {
    return {
      path: literal,
      nextIndex: start + 1,
      runtimeUrl: false,
      moduleUrl: false,
      modulePathname: false,
    };
  }
  const moduleUrl = staticImportMetaUrlPath(tokens, text, start);
  if (moduleUrl !== null) {
    if (!allowedFollowingTokens.includes(tokenText(tokens[moduleUrl.nextIndex], text))) {
      return null;
    }
    return {
      path: moduleUrl.path,
      nextIndex: moduleUrl.nextIndex,
      runtimeUrl: false,
      moduleUrl: true,
      modulePathname: moduleUrl.projection === "pathname",
    };
  }
  const runtimeUrl = staticWebExtensionGetUrlPath(tokens, text, start);
  if (
    !runtimeUrl ||
    !allowedFollowingTokens.includes(tokenText(tokens[runtimeUrl.nextIndex], text))
  ) {
    return null;
  }
  return { ...runtimeUrl, runtimeUrl: true, moduleUrl: false, modulePathname: false };
}

function staticWorkerScriptSpecifiers(text: string): WorkerScriptSpecifier[] {
  const tokens = tokenizeJs(text).filter(
    (token) => token.type !== "ws" && token.type !== "comment",
  );
  const specifiers: WorkerScriptSpecifier[] = [];
  for (let index = 0; index < tokens.length - 3; index += 1) {
    if (tokenText(tokens[index], text) !== "new") continue;
    let constructorIndex = index + 1;
    let constructor =
      staticIdentifierName(tokens[constructorIndex], text) ??
      tokenText(tokens[constructorIndex], text);
    if (STATIC_BROWSER_GLOBALS.has(constructor)) {
      const globalMember = staticMemberAccess(tokens, text, constructorIndex + 1);
      if (!globalMember) continue;
      constructor = globalMember.name;
      constructorIndex = globalMember.nextIndex - 1;
    }
    if (constructor !== "Worker" && constructor !== "SharedWorker") continue;
    if (tokenText(tokens[constructorIndex + 1], text) !== "(") continue;
    const documentPath = staticScriptPath(tokens[constructorIndex + 2], text);
    if (documentPath !== null) {
      specifiers.push({ path: documentPath, resolution: "document" });
      continue;
    }
    const moduleUrl = staticImportMetaUrlPath(tokens, text, constructorIndex + 2);
    if (moduleUrl !== null) {
      specifiers.push({
        path: moduleUrl.path,
        resolution: moduleUrl.projection === "pathname" ? "module-pathname" : "module",
      });
      continue;
    }
    const rootPath = staticWebExtensionResourcePath(tokens, text, constructorIndex + 2, [")", ","]);
    if (rootPath?.runtimeUrl) specifiers.push({ path: rootPath.path, resolution: "root" });
  }
  return specifiers;
}

function staticWebExtensionGetUrlPath(
  tokens: JsToken[],
  text: string,
  start: number,
): Omit<StaticWebExtensionResourcePath, "runtimeUrl" | "moduleUrl" | "modulePathname"> | null {
  let index = start;
  let global = staticIdentifierName(tokens[index], text) ?? tokenText(tokens[index], text);
  if (STATIC_BROWSER_GLOBALS.has(global)) {
    const globalMember = staticMemberAccess(tokens, text, index + 1);
    if (!globalMember || (globalMember.name !== "chrome" && globalMember.name !== "browser")) {
      return null;
    }
    global = globalMember.name;
    index = globalMember.nextIndex - 1;
  }
  if (global !== "chrome" && global !== "browser") return null;
  const apiMember = staticMemberAccess(tokens, text, index + 1);
  if (apiMember?.name !== "runtime" && apiMember?.name !== "extension") return null;
  const getUrlMember = staticMemberAccess(tokens, text, apiMember.nextIndex);
  if (getUrlMember?.name !== "getURL") return null;
  const openIndex = staticCallOpenIndex(tokens, text, getUrlMember.nextIndex);
  if (openIndex === null) return null;
  const closeIndex = matchingPunctuation(tokens, text, openIndex, "(", ")");
  if (closeIndex === null) return null;
  const path = staticLiteralCallArgument(tokens, text, openIndex + 1, closeIndex, 0);
  return path === null ? null : { path, nextIndex: closeIndex + 1 };
}

function resolveBrowserDocumentModulePath(
  specifier: string,
  documentBaseUrl: string,
  byNormalizedPath: Map<string, FileRecord>,
): string | null {
  try {
    const base = new URL(documentBaseUrl);
    const resolved = new URL(specifier, base);
    if (resolved.protocol !== base.protocol || resolved.host !== base.host) return null;
    const path = decodeUrlPathForArchiveLookup(resolved.pathname.replace(/^\/+/, ""));
    return resolveExactModulePath(path, byNormalizedPath);
  } catch {
    return null;
  }
}

function resolveBrowserDocumentUrl(specifier: string, documentBaseUrl: string): string | null {
  try {
    const base = new URL(documentBaseUrl);
    const resolved = new URL(specifier, base);
    return resolved.protocol === base.protocol && resolved.host === base.host
      ? resolved.href
      : null;
  } catch {
    return null;
  }
}

function resolveExactModulePath(
  candidate: string,
  byNormalizedPath: Map<string, FileRecord>,
): string | null {
  const normalized = normalizePathSegments(stripPackagePrefix(candidate));
  return normalized && byNormalizedPath.has(normalized) ? normalized : null;
}

const BROWSER_ARCHIVE_ROOT = new URL("drydock-extension://artifact/");

function browserArchiveUrl(path: string): string | undefined {
  try {
    return new URL(encodeArchiveLookupPathForUrl(path), BROWSER_ARCHIVE_ROOT).href;
  } catch {
    return undefined;
  }
}

function resolveBrowserScriptModulePath(
  fromPath: string,
  specifier: string,
  byNormalizedPath: Map<string, FileRecord>,
  pathnameOnly = false,
): string | null {
  const baseUrl = browserArchiveUrl(fromPath);
  if (!baseUrl) return null;
  if (!pathnameOnly) {
    return resolveBrowserDocumentModulePath(specifier, baseUrl, byNormalizedPath);
  }
  try {
    const pathname = new URL(specifier, baseUrl).pathname;
    return resolveBrowserDocumentModulePath(pathname, BROWSER_ARCHIVE_ROOT.href, byNormalizedPath);
  } catch {
    return null;
  }
}

function staticImportMetaUrlPath(
  tokens: JsToken[],
  text: string,
  start: number,
): { path: string; nextIndex: number; projection: "url" | "pathname" } | null {
  if (
    tokenText(tokens[start], text) !== "new" ||
    tokenText(tokens[start + 1], text) !== "URL" ||
    tokenText(tokens[start + 2], text) !== "("
  ) {
    return null;
  }
  const closeIndex = matchingPunctuation(tokens, text, start + 2, "(", ")");
  if (closeIndex === null) return null;
  const path = staticScriptPath(tokens[start + 3], text);
  if (
    path === null ||
    tokenText(tokens[start + 4], text) !== "," ||
    tokenText(tokens[start + 5], text) !== "import" ||
    tokenText(tokens[start + 6], text) !== "." ||
    tokenText(tokens[start + 7], text) !== "meta"
  ) {
    return null;
  }
  const url = staticMemberAccess(tokens, text, start + 8);
  if (url?.name !== "url" || url.nextIndex !== closeIndex) return null;
  let nextIndex = closeIndex + 1;
  const projection = staticMemberAccess(tokens, text, nextIndex);
  if (projection?.name === "href") {
    return { path, nextIndex: projection.nextIndex, projection: "url" };
  }
  if (projection?.name === "pathname") {
    return { path, nextIndex: projection.nextIndex, projection: "pathname" };
  }
  return { path, nextIndex, projection: "url" };
}

function staticMemberAccess(
  tokens: JsToken[],
  text: string,
  separatorIndex: number,
): { name: string; nextIndex: number } | null {
  const separator = tokenText(tokens[separatorIndex], text);
  const bracketIndex =
    separator === "[" ? separatorIndex : separator === "?." ? separatorIndex + 1 : -1;
  if (bracketIndex >= 0 && tokenText(tokens[bracketIndex], text) === "[") {
    const property = tokens[bracketIndex + 1];
    const name = staticScriptPath(property, text);
    if (name === null || tokenText(tokens[bracketIndex + 2], text) !== "]") {
      return null;
    }
    return { name, nextIndex: bracketIndex + 3 };
  }
  if (separator !== "." && separator !== "?.") return null;
  const property = tokens[separatorIndex + 1];
  const name = staticIdentifierName(property, text);
  return name === null ? null : { name, nextIndex: separatorIndex + 2 };
}

function staticCallOpenIndex(tokens: JsToken[], text: string, index: number): number | null {
  if (tokenText(tokens[index], text) === "(") return index;
  return tokenText(tokens[index], text) === "?." && tokenText(tokens[index + 1], text) === "("
    ? index + 1
    : null;
}

function staticLiteralCallArgument(
  tokens: JsToken[],
  text: string,
  start: number,
  end: number,
  targetArgument: number,
): string | null {
  let argumentStart = start;
  let argument = 0;
  let depth = 0;
  for (let index = start; index <= end; index += 1) {
    const value = index === end ? "," : tokenText(tokens[index], text);
    if (value === "[" || value === "{" || value === "(") depth += 1;
    else if (value === "]" || value === "}" || value === ")") depth -= 1;
    if (value !== "," || depth !== 0) continue;
    if (argument === targetArgument) {
      return index === argumentStart + 1 ? staticScriptPath(tokens[argumentStart], text) : null;
    }
    argument += 1;
    argumentStart = index + 1;
  }
  return null;
}

function staticPropertyName(token: JsToken | undefined, text: string): string | null {
  if (!token) return null;
  if (token.type === "ident") return staticIdentifierName(token, text);
  return staticScriptPath(token, text);
}

function staticObjectPropertyValueIndex(
  tokens: JsToken[],
  text: string,
  index: number,
  property: string,
): number | null {
  const directName = staticPropertyName(tokens[index], text);
  if (directName === property && tokenText(tokens[index + 1], text) === ":") return index + 2;
  if (
    tokenText(tokens[index], text) !== "[" ||
    staticPropertyName(tokens[index + 1], text) !== property ||
    tokenText(tokens[index + 2], text) !== "]" ||
    tokenText(tokens[index + 3], text) !== ":"
  ) {
    return null;
  }
  return index + 4;
}

function staticIdentifierName(token: JsToken | undefined, text: string): string | null {
  if (token?.type !== "ident") return null;
  return tokenText(token, text).replace(
    /\\u(?:\{([0-9a-f]+)\}|([0-9a-f]{4}))/gi,
    (_match, braced: string | undefined, fixed: string | undefined) =>
      String.fromCodePoint(Number.parseInt(braced ?? fixed ?? "0", 16)),
  );
}

function staticScriptPath(token: JsToken | undefined, text: string): string | null {
  if (!token) return null;
  if (token.type === "string") return token.value ?? null;
  if (token.type !== "template") return null;
  return decodeJsNoSubstitutionTemplate(tokenText(token, text));
}

function matchingPunctuation(
  tokens: JsToken[],
  text: string,
  openIndex: number,
  open: string,
  close: string,
): number | null {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const value = tokenText(tokens[index], text);
    if (value === open) depth += 1;
    else if (value === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function isMemberSeparator(value: string): boolean {
  return value === "." || value === "?.";
}

function tokenText(token: JsToken | undefined, text: string): string {
  return token ? jsTokenText(text, token) : "";
}

function resolveModulePath(
  candidate: string,
  byNormalizedPath: Map<string, FileRecord>,
): string | null {
  const base = normalizePathSegments(stripPackagePrefix(candidate));
  if (!base) return null;
  for (const suffix of RESOLUTION_SUFFIXES) {
    const resolved = base + suffix;
    if (byNormalizedPath.has(resolved)) return resolved;
  }
  return null;
}

function joinRelative(fromPath: string, specifier: string): string {
  if (specifier.startsWith("/")) return specifier.replace(/^\/+/, "");
  const directory = fromPath.split("/").slice(0, -1).join("/");
  return directory ? `${directory}/${specifier}` : specifier;
}

function stripPackagePrefix(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized.startsWith("package/") ? normalized.slice("package/".length) : normalized;
}

function normalizePathSegments(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

// `isTestPath` callers need the same prefix normalization the resolver uses so
// reachable-set membership checks line up with finding file paths.
export function normalizeReachabilityPath(path: string): string {
  return stripPackagePrefix(path);
}
