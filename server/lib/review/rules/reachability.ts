import type { PackageJsonSummary } from "../serialize";
import type { CodePatternSet, FileRecord } from "../types";
import { tokenizeJsWithinBudget } from "../../platform/js-lexer";
import { isTestPath } from "./file-types";
import { normalizeCodeForScanning } from "./normalize";
import { CONSUMER_INSTALL_LIFECYCLE_SCRIPTS } from "./patterns";

// Static require/import edges between files inside the package. The walk is a
// conservative over-approximation built from relative specifiers only: bare
// (dependency) imports and dynamic expressions cannot pull a packaged file into
// the consumer graph, and any file we cannot prove reachable simply keeps full
// finding severity, so misses fail toward louder findings, never quieter ones.
const RELATIVE_SPECIFIER_PATTERNS = [
  /\brequire\s*\(\s*["'](\.\.?\/[^"'\n]+)["']\s*\)/g,
  /\bimport\s*\(\s*["'](\.\.?\/[^"'\n]+)["']\s*\)/g,
  /\b(?:import|export)\s+[^"'\n]*?from\s+["'](\.\.?\/[^"'\n]+)["']/g,
  /\b(?:import|export)\s+["'](\.\.?\/[^"'\n]+)["']/g,
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
): Set<string> {
  if (codePatternSet === "python") return pythonReachableFrom(files, pythonModuleSeeds(files));
  return javascriptReachableFrom(files, [...entrypointCandidates(packageJson), ...extraSeedPaths]);
}

// Files a consumer's install can execute *while installing*, as opposed to when
// the consumer later requires or runs the package. Deliberately narrower than
// `consumerReachablePaths`: declared entrypoints and bin targets run when
// somebody chooses to run them, whereas an install hook runs on everyone who
// takes the dependency, so rules that only make sense at install time (the
// propagation family) gate on this set instead.
export function installReachablePaths(
  files: FileRecord[],
  scripts: Record<string, string>,
  implicitScripts: Record<string, string>,
  codePatternSet: CodePatternSet | undefined = "javascript",
  executionEvidenceOnly = false,
): Set<string> {
  if (codePatternSet === "python") {
    // pip executes an sdist's setup.py to install it; there is no manifest-
    // declared hook to read, so the file itself is the install entrypoint.
    return pythonReachableFrom(files, pythonSetupSeeds(files));
  }
  const seeds = executionEvidenceOnly
    ? lifecycleExecutionSeedPaths(files, scripts, implicitScripts)
    : lifecycleScriptSeedPaths(files, scripts, implicitScripts);
  if (!seeds.length) return new Set();
  return javascriptReachableFrom(files, seeds, executionEvidenceOnly);
}

export function javascriptReachableFrom(
  files: FileRecord[],
  seedCandidates: string[],
  executionEvidenceOnly = false,
): Set<string> {
  const byNormalizedPath = new Map<string, FileRecord>();
  for (const file of files) {
    byNormalizedPath.set(stripPackagePrefix(file.path), file);
  }

  const queue: string[] = [];
  for (const candidate of seedCandidates) {
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
    // String-piece imports are statically resolvable just like the capability
    // patterns that scan their normalized source. Runtime expressions stay unknown.
    const specifiers = new Set([
      ...relativeSpecifiers(file.textSample, executionEvidenceOnly),
      ...relativeSpecifiers(normalizeCodeForScanning(file.textSample), executionEvidenceOnly),
    ]);
    for (const specifier of specifiers) {
      const resolved = resolveModulePath(joinRelative(path, specifier), byNormalizedPath);
      if (resolved && !reachable.has(resolved)) queue.push(resolved);
    }
  }
  return reachable;
}

// Python packages do not have a package.json-style entrypoint manifest. Treat
// every non-test Python module as consumer-reachable, then follow its static
// imports into test trees. This is deliberately conservative: an import edge
// can only keep a finding loud, never hide one.
function pythonModuleSeeds(files: FileRecord[]): string[] {
  return files
    .map((file) => stripPackagePrefix(file.path))
    .filter((path) => /\.py$/i.test(path) && !isTestPath(path));
}

function pythonSetupSeeds(files: FileRecord[]): string[] {
  return files
    .map((file) => stripPackagePrefix(file.path))
    .filter((path) => path === "setup.py" || path === "sdist/setup.py");
}

function pythonReachableFrom(files: FileRecord[], seedPaths: string[]): Set<string> {
  const byNormalizedPath = new Map<string, FileRecord>();
  for (const file of files) {
    byNormalizedPath.set(stripPackagePrefix(file.path), file);
  }
  const queue = seedPaths.filter((path) => byNormalizedPath.has(path));

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
  const baseValues = [normalized, withoutPackage];
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

function relativeSpecifiers(text: string, executionEvidenceOnly = false): string[] {
  const specifiers: string[] = [];
  // A source the lexer gives up on keeps every match.
  const tokens = executionEvidenceOnly ? tokenizeJsWithinBudget(text) : null;
  const codeStarts = tokens
    ? new Set(tokens.filter((token) => token.type === "ident").map((token) => token.start))
    : null;
  for (const pattern of RELATIVE_SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (!codeStarts || codeStarts.has(match.index)) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

// The broad token set is suitable for keeping findings loud, but an output
// filename is not proof of prior execution when comparing activation graphs.
function lifecycleExecutionSeedPaths(
  files: FileRecord[],
  scripts: Record<string, string>,
  implicitScripts: Record<string, string>,
): string[] {
  const candidates = new Set<string>();
  for (const hook of CONSUMER_INSTALL_LIFECYCLE_SCRIPTS) {
    const command = scripts[hook];
    if (!command || command === implicitScripts[hook]) continue;
    const words = [...command.matchAll(/"[^"\n]*"|'[^'\n]*'|[^\s;&|]+|[;&|]+/g)].map(
      (match) => match[0],
    );
    let start = 0;
    for (let end = 0; end <= words.length; end++) {
      if (end < words.length && !/^[;&|]+$/.test(words[end])) continue;
      const args = words.slice(start, end).map((word) => word.replace(/^(["'])(.*)\1$/, "$2"));
      start = end + 1;
      const executable = args.shift();
      if (!executable) continue;
      if (/^(?:node|nodejs|bun|deno|sh|bash)$/.test(executable)) {
        if ((executable === "bun" || executable === "deno") && args[0] === "run") args.shift();
        for (let i = 0; i < args.length; i++) {
          const arg = args[i];
          if (/^(?:-e|--eval|-p|--print|-c)$/.test(arg)) break;
          if (/^(?:-r|--require|--import|--loader|--experimental-loader)$/.test(arg)) {
            if (args[i + 1]) candidates.add(args[++i]);
          } else if (/^--(?:require|import|loader|experimental-loader)=/.test(arg)) {
            candidates.add(arg.slice(arg.indexOf("=") + 1));
          } else if (arg.startsWith("-")) continue;
          else {
            candidates.add(arg);
            break;
          }
        }
      } else if (/^(?:\.?\.?\/)/.test(executable)) candidates.add(executable);
    }
  }
  const normalizedCandidates = new Set(
    [...candidates]
      .filter((candidate) => !/[$`]/.test(candidate))
      .map((candidate) => candidate.replace(/^\.\//, "")),
  );
  return files
    .filter((file) =>
      [...scriptPathCandidates(file.path)].some((path) => normalizedCandidates.has(path)),
    )
    .map((file) => stripPackagePrefix(file.path));
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
