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
  consumerDocumentBaseUrls: string[] = [],
): Set<string> {
  if (codePatternSet === "python") return pythonConsumerReachablePaths(files);

  const byNormalizedPath = new Map<string, FileRecord>();
  for (const file of files) {
    byNormalizedPath.set(stripPackagePrefix(file.path), file);
  }

  const queue: string[] = [];
  for (const candidate of [...entrypointCandidates(packageJson), ...extraSeedPaths]) {
    // Entrypoints are already decoded, validated archive paths. URL semantics
    // apply to specifiers discovered inside those files, not to the seeds.
    const resolved = resolveModulePath(candidate, byNormalizedPath);
    if (resolved) queue.push(resolved);
  }

  const reachable = new Set<string>();
  while (queue.length) {
    const path = queue.pop();
    if (!path || reachable.has(path)) continue;
    reachable.add(path);
    const file = byNormalizedPath.get(path);
    if (!file?.textSample) continue;
    for (const specifier of relativeSpecifiers(file.textSample, rootRelativeModuleImports)) {
      const resolved = rootRelativeModuleImports
        ? resolveBrowserScriptModulePath(path, specifier, byNormalizedPath)
        : resolveModulePath(joinRelative(path, specifier), byNormalizedPath);
      if (resolved && !reachable.has(resolved)) queue.push(resolved);
    }
    if (rootRelativeModuleImports) {
      for (const injected of staticWebExtensionScriptSpecifiers(file.textSample)) {
        // Chrome resolves packaged injection and registration files from the
        // extension root, not from the JavaScript module that names them.
        const resolved = resolveBrowserDocumentModulePath(
          injected,
          BROWSER_ARCHIVE_ROOT.href,
          byNormalizedPath,
        );
        if (resolved && !reachable.has(resolved)) queue.push(resolved);
      }
      for (const worker of staticWorkerScriptSpecifiers(file.textSample)) {
        const scriptResolved = resolveBrowserScriptModulePath(path, worker.path, byNormalizedPath);
        if (scriptResolved && !reachable.has(scriptResolved)) queue.push(scriptResolved);
        if (worker.resolution === "document") {
          for (const documentBaseUrl of consumerDocumentBaseUrls) {
            const resolved = resolveBrowserDocumentModulePath(
              worker.path,
              documentBaseUrl,
              byNormalizedPath,
            );
            if (resolved && !reachable.has(resolved)) queue.push(resolved);
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
  specifiers.push(...staticImportScriptsSpecifiers(text));
  return specifiers;
}

type WebExtensionScriptProperty = "file" | "files" | "js";
type WebExtensionScriptValueShape = "string" | "string-array" | "file-object-array";

interface WebExtensionScriptCall {
  openIndex: number;
  property: WebExtensionScriptProperty;
  valueShape: WebExtensionScriptValueShape;
}

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

// WebExtension APIs can make packaged scripts executable without a manifest or
// module edge. Follow only literal `file`, `files`, and `js` properties on the
// statically named APIs; dynamic expressions remain unproven. The shared lexer
// keeps API-shaped text in comments, strings, and regular expressions inert.
function staticWebExtensionScriptSpecifiers(text: string): string[] {
  const tokens = tokenizeJs(text).filter(
    (token) => token.type !== "ws" && token.type !== "comment",
  );
  const specifiers: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const call = webExtensionScriptCall(tokens, text, index);
    if (!call) continue;
    const closeIndex = matchingPunctuation(tokens, text, call.openIndex, "(", ")");
    if (closeIndex === null) continue;
    specifiers.push(
      ...staticPropertyScriptPaths(
        tokens,
        text,
        call.openIndex + 1,
        closeIndex,
        call.property,
        call.valueShape,
      ),
    );
    index = closeIndex;
  }

  return specifiers;
}

function webExtensionScriptCall(
  tokens: JsToken[],
  text: string,
  start: number,
): WebExtensionScriptCall | null {
  if (start > 0 && isMemberSeparator(tokenText(tokens[start - 1], text))) return null;

  let index = start;
  const first = tokenText(tokens[index], text);
  let namespace: string;
  if (first === "chrome" || first === "browser") {
    const member = staticMemberAccess(tokens, text, index + 1);
    if (!member) return null;
    namespace = member.name;
    index = member.nextIndex;
  } else {
    namespace = first;
    index += 1;
  }

  if (
    namespace !== "tabs" &&
    namespace !== "scripting" &&
    namespace !== "contentScripts" &&
    namespace !== "userScripts"
  ) {
    return null;
  }
  const methodMember = staticMemberAccess(tokens, text, index);
  if (!methodMember) return null;
  const method = methodMember.name;
  const openIndex = staticCallOpenIndex(tokens, text, methodMember.nextIndex);
  if (openIndex === null) return null;
  if (namespace === "tabs" && method === "executeScript") {
    return { openIndex, property: "file", valueShape: "string" };
  }
  if (namespace === "scripting" && method === "executeScript") {
    return { openIndex, property: "files", valueShape: "string-array" };
  }
  if (
    namespace === "scripting" &&
    (method === "registerContentScripts" || method === "updateContentScripts")
  ) {
    return { openIndex, property: "js", valueShape: "string-array" };
  }
  if (namespace === "contentScripts" && method === "register") {
    return { openIndex, property: "js", valueShape: "file-object-array" };
  }
  if (
    namespace === "userScripts" &&
    (method === "register" || method === "update" || method === "execute")
  ) {
    return { openIndex, property: "js", valueShape: "file-object-array" };
  }
  return null;
}

function staticPropertyScriptPaths(
  tokens: JsToken[],
  text: string,
  start: number,
  end: number,
  property: WebExtensionScriptProperty,
  valueShape: WebExtensionScriptValueShape,
): string[] {
  const paths: string[] = [];
  for (let index = start; index < end; index += 1) {
    if (staticPropertyName(tokens[index], text) !== property) continue;
    if (tokenText(tokens[index + 1], text) !== ":") continue;

    const valueIndex = index + 2;
    if (valueShape === "string") {
      const value = staticScriptPath(tokens[valueIndex], text);
      if (value !== null) paths.push(value);
      continue;
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
  for (let index = start; index < end; index += 1) {
    if (staticPropertyName(tokens[index], text) !== property) continue;
    if (tokenText(tokens[index + 1], text) !== ":") continue;
    const value = staticScriptPath(tokens[index + 2], text);
    if (value !== null) paths.push(value);
  }
  return paths;
}

interface WorkerScriptSpecifier {
  path: string;
  resolution: "document" | "module";
}

function staticWorkerScriptSpecifiers(text: string): WorkerScriptSpecifier[] {
  const tokens = tokenizeJs(text).filter(
    (token) => token.type !== "ws" && token.type !== "comment",
  );
  const specifiers: WorkerScriptSpecifier[] = [];
  for (let index = 0; index < tokens.length - 3; index += 1) {
    if (tokenText(tokens[index], text) !== "new") continue;
    const constructor = tokenText(tokens[index + 1], text);
    if (constructor !== "Worker" && constructor !== "SharedWorker") continue;
    if (tokenText(tokens[index + 2], text) !== "(") continue;
    const documentPath = staticScriptPath(tokens[index + 3], text);
    if (documentPath !== null) {
      specifiers.push({ path: documentPath, resolution: "document" });
      continue;
    }
    const modulePath = staticImportMetaUrlPath(tokens, text, index + 3);
    if (modulePath !== null) specifiers.push({ path: modulePath, resolution: "module" });
  }
  return specifiers;
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
