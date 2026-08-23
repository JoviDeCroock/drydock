import type { CodePatternSet, FileRecord, PackageJsonSummary } from "..";
import { isTestPath } from "./file-types";
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
  if (codePatternSet === "python") return pythonConsumerReachablePaths(files);
  return reachableFromSeeds(files, [...entrypointCandidates(packageJson), ...extraSeedPaths]);
}

/**
 * Files an *automatic* install/build entrypoint can execute, and nothing else.
 *
 * Deliberately narrower than {@link consumerReachablePaths}: that set also
 * seeds from `main`/`bin`/`exports`, which is right for "can a consumer run
 * this at all" but wrong for "does installing this package run this". The
 * dependency-artifact review needs the second question — a newly introduced
 * dependency whose dropper only runs when you `require()` it is a different
 * (and lesser) claim than one that runs on `npm install`.
 *
 * Same conservative posture as the consumer walk: relative specifiers only, so
 * an unproven edge keeps a finding at full severity rather than escalating it.
 */
export function lifecycleReachablePaths(
  files: FileRecord[],
  scripts: Record<string, string>,
  implicitScripts: Record<string, string>,
): Set<string> {
  return reachableFromSeeds(files, lifecycleScriptSeedPaths(files, scripts, implicitScripts));
}

function reachableFromSeeds(files: FileRecord[], seeds: string[]): Set<string> {
  const byNormalizedPath = new Map<string, FileRecord>();
  for (const file of files) {
    byNormalizedPath.set(stripPackagePrefix(file.path), file);
  }

  const queue: string[] = [];
  for (const candidate of seeds) {
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
    for (const specifier of relativeSpecifiers(file.textSample)) {
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
  for (const { command } of consumerInstallScriptCommands(scripts, implicitScripts)) {
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

export interface ConsumerInstallScriptCommand {
  name: string;
  command: string;
}

// npm lifecycle hooks frequently delegate to named scripts. Those commands
// execute in the same install chain and must seed both file reachability and
// inline capability detection. The queue and visited set also make cycles such
// as `setup: npm run setup` finite.
export function consumerInstallScriptCommands(
  scripts: Record<string, string>,
  implicitScripts: Record<string, string>,
): ConsumerInstallScriptCommand[] {
  const queue = [...CONSUMER_INSTALL_LIFECYCLE_SCRIPTS].map((name) => ({ name, root: true }));
  const seen = new Set<string>();
  const commands: ConsumerInstallScriptCommand[] = [];
  while (queue.length) {
    const next = queue.shift();
    if (!next || seen.has(next.name)) continue;
    seen.add(next.name);
    const command = scripts[next.name];
    if (!command || (next.root && implicitScripts[next.name] === command)) continue;
    commands.push({ name: next.name, command });
    for (const name of npmRunScriptNames(command, scripts)) {
      // `npm run setup` also invokes `presetup` and `postsetup` when declared.
      // Queue all three explicitly; `seen` prevents cycles and repeated work.
      queue.push(
        { name: `pre${name}`, root: false },
        { name, root: false },
        { name: `post${name}`, root: false },
      );
    }
  }
  return commands;
}

function npmRunScriptNames(command: string, scripts: Record<string, string>): string[] {
  const names = new Set<string>();
  // npm accepts config flags before or after the subcommand (`npm --silent run
  // setup`, `npm run --silent setup`). Inspect every non-option word after the
  // run command that names a declared script. This is intentionally
  // conservative around config options with separate values: an extra
  // statically-reachable script is safer than letting flag placement hide the
  // install chain.
  const words = shellWords(command);
  for (let npmIndex = 0; npmIndex < words.length; npmIndex += 1) {
    if (words[npmIndex] !== "npm") continue;
    const invocationEnd = words.findIndex(
      (word, index) => index > npmIndex && SHELL_COMMAND_OPERATORS.has(word),
    );
    const end = invocationEnd === -1 ? words.length : invocationEnd;
    const runOffset = words
      .slice(npmIndex + 1, end)
      .findIndex((word) => word === "run" || word === "run-script");
    const runIndex = runOffset === -1 ? -1 : npmIndex + 1 + runOffset;
    if (runIndex === -1) continue;
    for (const word of words.slice(runIndex + 1, end)) {
      if (word === "--") break;
      if (word.startsWith("-") || !Object.hasOwn(scripts, word)) continue;
      names.add(word);
    }
  }
  return [...names];
}

const SHELL_COMMAND_OPERATORS = new Set([";", "&&", "||", "|"]);

function shellWords(value: string): string[] {
  return [...value.matchAll(/"([^"\n]*)"|'([^'\n]*)'|(&&|\|\||[;&|])|([^\s;&|]+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? match[4],
  );
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

function relativeSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of RELATIVE_SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
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
