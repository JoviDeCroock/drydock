import type { CodePatternSet, FileRecord, PackageJsonSummary } from "..";
import { jsTokenText, type JsToken, tokenizeJs } from "../../platform/js-lexer";
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
  /\b(?:import|export)\s+[^"'\n]*?from\s+["'](\.\.?\/[^"'\n]+)["']/g,
  /\b(?:import|export)\s+["'](\.\.?\/[^"'\n]+)["']/g,
];
const ROOT_RELATIVE_MODULE_SPECIFIER_PATTERNS = [
  /\bimport\s*\(\s*["'](\/[^"'\n]+)["']\s*\)/g,
  /\b(?:import|export)\s+[^"'\n]*?from\s+["'](\/[^"'\n]+)["']/g,
  /\b(?:import|export)\s+["'](\/[^"'\n]+)["']/g,
];
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

export interface ConsumerReachabilityDependency {
  path: string;
  documentBaseUrl?: string;
}

interface ConsumerReachabilityQueueEntry {
  path: string;
  documentBaseUrl?: string;
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
): Set<string> {
  if (codePatternSet === "python") return pythonConsumerReachablePaths(files);

  const byNormalizedPath = new Map<string, FileRecord>();
  for (const file of files) {
    byNormalizedPath.set(stripPackagePrefix(file.path), file);
  }

  const queue: ConsumerReachabilityQueueEntry[] = [];
  for (const candidate of [...entrypointCandidates(packageJson), ...extraSeedPaths]) {
    // Entrypoints are already decoded, validated archive paths. URL semantics
    // apply to specifiers discovered inside those files, not to the seeds.
    const resolved = resolveModulePath(candidate, byNormalizedPath);
    if (!resolved) continue;
    const documentBases = consumerDocumentBaseUrlsByPath[resolved];
    if (documentBases?.length) {
      for (const documentBaseUrl of documentBases) queue.push({ path: resolved, documentBaseUrl });
    } else {
      queue.push({ path: resolved });
    }
  }

  const reachable = new Set<string>();
  const inspectedContexts = new Set<string>();
  while (queue.length) {
    const queued = queue.pop();
    if (!queued) continue;
    const { path, documentBaseUrl } = queued;
    const contextKey = `${path}\0${documentBaseUrl ?? ""}`;
    if (inspectedContexts.has(contextKey)) continue;
    inspectedContexts.add(contextKey);
    reachable.add(path);
    const file = byNormalizedPath.get(path);
    if (!file?.textSample) continue;
    for (const dependency of consumerFileDependencyPaths?.(path, file) ?? []) {
      const resolved = resolveModulePath(dependency.path, byNormalizedPath);
      if (resolved) queue.push({ path: resolved, documentBaseUrl: dependency.documentBaseUrl });
    }
    for (const specifier of relativeSpecifiers(file.textSample, rootRelativeModuleImports)) {
      const resolved = rootRelativeModuleImports
        ? resolveBrowserScriptModulePath(path, specifier, byNormalizedPath)
        : resolveModulePath(joinRelative(path, specifier), byNormalizedPath);
      if (resolved) queue.push({ path: resolved, documentBaseUrl });
    }
    if (rootRelativeModuleImports) {
      for (const resource of staticWebExtensionResourceSpecifiers(file.textSample)) {
        // Chrome resolves packaged injection, registration, and offscreen
        // document files from the extension root, not from the JavaScript
        // module that names them.
        const resolved = resolveBrowserDocumentModulePath(
          resource,
          BROWSER_ARCHIVE_ROOT.href,
          byNormalizedPath,
        );
        if (resolved) queue.push({ path: resolved });
      }
      for (const worker of staticWorkerScriptSpecifiers(file.textSample)) {
        if (worker.resolution === "root") {
          const resolved = resolveBrowserDocumentModulePath(
            worker.path,
            BROWSER_ARCHIVE_ROOT.href,
            byNormalizedPath,
          );
          if (resolved) queue.push({ path: resolved });
          continue;
        }
        const moduleResolved = resolveBrowserScriptModulePath(path, worker.path, byNormalizedPath);
        if (moduleResolved) queue.push({ path: moduleResolved });
        if (worker.resolution === "document" && documentBaseUrl) {
          const resolved = resolveBrowserDocumentModulePath(
            worker.path,
            documentBaseUrl,
            byNormalizedPath,
          );
          if (resolved) queue.push({ path: resolved });
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
  specifiers.push(...staticImportScriptsSpecifiers(text));
  return specifiers;
}

type WebExtensionResourceProperty = "file" | "files" | "js" | "path" | "popup" | "url";
type WebExtensionScriptValueShape =
  | "string"
  | "string-array"
  | "string-or-string-array"
  | "file-object-array";
type WebExtensionResourceArgument = "first" | "first-object";

type WebExtensionResourceCall =
  | {
      openIndex: number;
      source: "property";
      property: WebExtensionResourceProperty;
      valueShape: WebExtensionScriptValueShape;
      argument: WebExtensionResourceArgument;
    }
  | { openIndex: number; source: "argument"; argumentIndex: number };

const STATIC_BROWSER_GLOBALS = new Set(["globalThis", "self", "window"]);

// Classic workers may load more packaged scripts without a module edge. Parse
// only literal arguments on the worker-global call so API-shaped text in
// strings, comments, regexes, or unrelated object methods stays inert.
function staticImportScriptsSpecifiers(text: string): string[] {
  const tokens = tokenizeJs(text).filter(
    (token) => token.type !== "ws" && token.type !== "comment",
  );
  const specifiers: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokenText(tokens[index], text);
    let callIndex: number | null = null;
    if (
      current === "importScripts" &&
      !isMemberSeparator(tokenText(tokens[index - 1], text)) &&
      tokenText(tokens[index - 1], text) !== "]"
    ) {
      callIndex = index + 1;
    } else if (current === "self" || current === "globalThis") {
      const member = staticMemberAccess(tokens, text, index + 1);
      if (member?.name === "importScripts") callIndex = member.nextIndex;
    }
    if (callIndex === null) continue;

    const openIndex = staticCallOpenIndex(tokens, text, callIndex);
    if (openIndex === null) continue;
    const closeIndex = matchingPunctuation(tokens, text, openIndex, "(", ")");
    if (closeIndex === null) continue;
    specifiers.push(...staticLiteralCallArguments(tokens, text, openIndex + 1, closeIndex));
    index = closeIndex;
  }
  return specifiers;
}

// WebExtension APIs can make packaged scripts or HTML documents executable
// without a manifest or module edge. Follow only literal resource properties
// on the statically named APIs; dynamic expressions remain unproven. The shared
// lexer keeps API-shaped text in comments, strings, and regular expressions inert.
function staticWebExtensionResourceSpecifiers(text: string): string[] {
  const tokens = tokenizeJs(text).filter(
    (token) => token.type !== "ws" && token.type !== "comment",
  );
  const specifiers: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
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
        specifiers.push(
          ...staticPropertyScriptPaths(tokens, text, start, end, call.property, call.valueShape),
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
      if (path !== null) specifiers.push(path);
    }
  }

  return specifiers;
}

function webExtensionScriptCall(
  tokens: JsToken[],
  text: string,
  start: number,
): WebExtensionResourceCall | null {
  if (start > 0 && isMemberSeparator(tokenText(tokens[start - 1], text))) return null;

  let index = start;
  let first = tokenText(tokens[index], text);
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
    };
  }
  if (namespace === "windows" && method === "create") {
    return {
      openIndex,
      source: "property",
      property: "url",
      valueShape: "string-or-string-array",
      argument: "first",
    };
  }
  if (namespace === "tabs" && method === "executeScript") {
    return {
      openIndex,
      source: "property",
      property: "file",
      valueShape: "string",
      argument: "first-object",
    };
  }
  if (namespace === "scripting" && method === "executeScript") {
    return {
      openIndex,
      source: "property",
      property: "files",
      valueShape: "string-array",
      argument: "first",
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
    };
  }
  if (namespace === "contentScripts" && method === "register") {
    return {
      openIndex,
      source: "property",
      property: "js",
      valueShape: "file-object-array",
      argument: "first",
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
    };
  }
  if (namespace === "offscreen" && method === "createDocument") {
    return {
      openIndex,
      source: "property",
      property: "url",
      valueShape: "string",
      argument: "first",
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
    };
  }
  if (namespace === "sidePanel" && method === "setOptions") {
    return {
      openIndex,
      source: "property",
      property: "path",
      valueShape: "string",
      argument: "first",
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
): string[] {
  const paths: string[] = [];
  const root = tokenText(tokens[start], text);
  const propertyDepth = root === "{" ? 1 : root === "[" ? 2 : null;
  if (propertyDepth === null) return paths;
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    const token = tokenText(tokens[index], text);
    if (token === "[" || token === "{" || token === "(") {
      depth += 1;
      continue;
    }
    if (token === "]" || token === "}" || token === ")") {
      depth -= 1;
      continue;
    }
    if (depth !== propertyDepth) continue;
    if (staticPropertyName(tokens[index], text) !== property) continue;
    if (tokenText(tokens[index + 1], text) !== ":") continue;

    const valueIndex = index + 2;
    if (valueShape === "string" || valueShape === "string-or-string-array") {
      const value = staticScriptPath(tokens[valueIndex], text);
      if (value !== null) {
        paths.push(value);
        continue;
      }
      if (valueShape === "string") continue;
    }
    if (tokenText(tokens[valueIndex], text) !== "[") continue;
    const closeIndex = matchingPunctuation(tokens, text, valueIndex, "[", "]");
    if (closeIndex === null || closeIndex > end) continue;
    if (valueShape === "file-object-array") {
      paths.push(...staticNamedPropertyPaths(tokens, text, valueIndex + 1, closeIndex, "file"));
      index = closeIndex;
      continue;
    }
    let nestedDepth = 0;
    for (let itemIndex = valueIndex + 1; itemIndex < closeIndex; itemIndex += 1) {
      const item = tokenText(tokens[itemIndex], text);
      if (item === "[" || item === "{" || item === "(") {
        nestedDepth += 1;
        continue;
      }
      if (item === "]" || item === "}" || item === ")") {
        nestedDepth -= 1;
        continue;
      }
      const value = nestedDepth === 0 ? staticScriptPath(tokens[itemIndex], text) : null;
      if (value !== null) paths.push(value);
    }
    index = closeIndex;
  }
  return paths;
}

function staticNamedPropertyPaths(
  tokens: JsToken[],
  text: string,
  start: number,
  end: number,
  property: string,
): string[] {
  const paths: string[] = [];
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    const token = tokenText(tokens[index], text);
    if (token === "[" || token === "{" || token === "(") {
      depth += 1;
      continue;
    }
    if (token === "]" || token === "}" || token === ")") {
      depth -= 1;
      continue;
    }
    if (depth !== 1) continue;
    if (staticPropertyName(tokens[index], text) !== property) continue;
    if (tokenText(tokens[index + 1], text) !== ":") continue;
    const value = staticScriptPath(tokens[index + 2], text);
    if (value !== null) paths.push(value);
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
  resolution: "document" | "module" | "root";
}

function staticWorkerScriptSpecifiers(text: string): WorkerScriptSpecifier[] {
  const tokens = tokenizeJs(text).filter(
    (token) => token.type !== "ws" && token.type !== "comment",
  );
  const specifiers: WorkerScriptSpecifier[] = [];
  for (let index = 0; index < tokens.length - 3; index += 1) {
    if (tokenText(tokens[index], text) !== "new") continue;
    let constructorIndex = index + 1;
    let constructor = tokenText(tokens[constructorIndex], text);
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
    const modulePath = staticImportMetaUrlPath(tokens, text, constructorIndex + 2);
    if (modulePath !== null) {
      specifiers.push({ path: modulePath, resolution: "module" });
      continue;
    }
    const rootPath = staticWebExtensionRuntimeUrlPath(tokens, text, constructorIndex + 2);
    if (rootPath !== null) specifiers.push({ path: rootPath, resolution: "root" });
  }
  return specifiers;
}

function staticWebExtensionRuntimeUrlPath(
  tokens: JsToken[],
  text: string,
  start: number,
): string | null {
  let index = start;
  let global = tokenText(tokens[index], text);
  if (STATIC_BROWSER_GLOBALS.has(global)) {
    const globalMember = staticMemberAccess(tokens, text, index + 1);
    if (!globalMember || (globalMember.name !== "chrome" && globalMember.name !== "browser")) {
      return null;
    }
    global = globalMember.name;
    index = globalMember.nextIndex - 1;
  }
  if (global !== "chrome" && global !== "browser") return null;
  const runtimeMember = staticMemberAccess(tokens, text, index + 1);
  if (runtimeMember?.name !== "runtime") return null;
  const getUrlMember = staticMemberAccess(tokens, text, runtimeMember.nextIndex);
  if (getUrlMember?.name !== "getURL") return null;
  const openIndex = staticCallOpenIndex(tokens, text, getUrlMember.nextIndex);
  if (openIndex === null) return null;
  const closeIndex = matchingPunctuation(tokens, text, openIndex, "(", ")");
  if (closeIndex === null) return null;
  const following = tokenText(tokens[closeIndex + 1], text);
  if (following !== ")" && following !== ",") return null;
  return staticLiteralCallArgument(tokens, text, openIndex + 1, closeIndex, 0);
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
    return resolveModulePath(path, byNormalizedPath);
  } catch {
    return null;
  }
}

const BROWSER_ARCHIVE_ROOT = new URL("drydock-extension://artifact/");

function resolveBrowserScriptModulePath(
  fromPath: string,
  specifier: string,
  byNormalizedPath: Map<string, FileRecord>,
): string | null {
  try {
    const encodedPath = encodeArchiveLookupPathForUrl(fromPath);
    const base = new URL(encodedPath, BROWSER_ARCHIVE_ROOT);
    return resolveBrowserDocumentModulePath(specifier, base.href, byNormalizedPath);
  } catch {
    return null;
  }
}

function staticImportMetaUrlPath(tokens: JsToken[], text: string, start: number): string | null {
  if (
    tokenText(tokens[start], text) !== "new" ||
    tokenText(tokens[start + 1], text) !== "URL" ||
    tokenText(tokens[start + 2], text) !== "("
  ) {
    return null;
  }
  const closeIndex = matchingPunctuation(tokens, text, start + 2, "(", ")");
  if (closeIndex !== start + 10) return null;
  const path = staticScriptPath(tokens[start + 3], text);
  if (
    path === null ||
    tokenText(tokens[start + 4], text) !== "," ||
    tokenText(tokens[start + 5], text) !== "import" ||
    tokenText(tokens[start + 6], text) !== "." ||
    tokenText(tokens[start + 7], text) !== "meta" ||
    tokenText(tokens[start + 8], text) !== "." ||
    tokenText(tokens[start + 9], text) !== "url"
  ) {
    return null;
  }
  return path;
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
    if (property?.type !== "string" || tokenText(tokens[bracketIndex + 2], text) !== "]") {
      return null;
    }
    return { name: property.value ?? "", nextIndex: bracketIndex + 3 };
  }
  if (separator !== "." && separator !== "?.") return null;
  const property = tokens[separatorIndex + 1];
  if (property?.type !== "ident") return null;
  return { name: tokenText(property, text), nextIndex: separatorIndex + 2 };
}

function staticCallOpenIndex(tokens: JsToken[], text: string, index: number): number | null {
  if (tokenText(tokens[index], text) === "(") return index;
  return tokenText(tokens[index], text) === "?." && tokenText(tokens[index + 1], text) === "("
    ? index + 1
    : null;
}

function staticLiteralCallArguments(
  tokens: JsToken[],
  text: string,
  start: number,
  end: number,
): string[] {
  const paths: string[] = [];
  let argumentStart = start;
  let depth = 0;
  for (let index = start; index <= end; index += 1) {
    const value = index === end ? "," : tokenText(tokens[index], text);
    if (value === "[" || value === "{" || value === "(") depth += 1;
    else if (value === "]" || value === "}" || value === ")") depth -= 1;
    if (value !== "," || depth !== 0) continue;
    if (index === argumentStart + 1) {
      const path = staticScriptPath(tokens[argumentStart], text);
      if (path !== null) paths.push(path);
    }
    argumentStart = index + 1;
  }
  return paths;
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
  if (token.type === "ident") return tokenText(token, text);
  return token.type === "string" ? (token.value ?? null) : null;
}

function staticScriptPath(token: JsToken | undefined, text: string): string | null {
  if (!token) return null;
  if (token.type === "string") return token.value ?? null;
  if (token.type !== "template") return null;
  const raw = tokenText(token, text);
  return raw.includes("${") ? null : raw.slice(1, -1);
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
