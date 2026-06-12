import type { FileRecord, PackageJsonSummary } from "../review";

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

// Files a consumer install can execute: declared entrypoints (main/module/
// browser/exports), bin targets, and everything statically importable from
// them. Lifecycle script files are handled separately by the script rules.
export function consumerReachablePaths(
  files: FileRecord[],
  packageJson: PackageJsonSummary | null,
): Set<string> {
  const byNormalizedPath = new Map<string, FileRecord>();
  for (const file of files) {
    byNormalizedPath.set(stripPackagePrefix(file.path), file);
  }

  const queue: string[] = [];
  for (const candidate of entrypointCandidates(packageJson)) {
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
  const browser = (packageJson as { browser?: unknown }).browser;
  if (typeof browser === "string") candidates.push(browser);
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
