import type { PackageJsonSummary } from "./review";

export function isOutsidePackageFilesAllowlist(
  path: string,
  packageJson: PackageJsonSummary | null | undefined,
): boolean {
  const files = packageJson?.files?.filter((entry) => entry.trim()) ?? [];
  if (!files.length) return false;
  if (isAlwaysIncludedPackageFile(path, packageJson)) return false;
  return !files.some((entry) => packageFilesEntryMatches(entry, path));
}

function isAlwaysIncludedPackageFile(
  path: string,
  packageJson: PackageJsonSummary | null | undefined,
): boolean {
  const lower = path.toLowerCase();
  if (lower === "package.json") return true;
  if (/^(?:readme|licen[cs]e|copying|notice)(?:\.|$)/i.test(path)) return true;
  const entrypoints = [packageJson?.main, packageJson?.module, packageJson?.types];
  if (entrypoints.includes(path)) return true;
  const bin = packageJson?.bin;
  if (typeof bin === "string" && bin === path) return true;
  if (bin && typeof bin === "object" && Object.values(bin).includes(path)) return true;
  return false;
}

function packageFilesEntryMatches(entry: string, path: string): boolean {
  const normalized = entry.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized) return false;
  if (normalized.includes("*")) return globLikePackageFilesEntryMatches(normalized, path);
  return path === normalized || path.startsWith(`${normalized}/`);
}

const GLOB_PATTERN_CACHE_LIMIT = 128;
const globPatternCache = new Map<string, RegExp>();

function globLikePackageFilesEntryMatches(entry: string, path: string): boolean {
  let pattern = globPatternCache.get(entry);
  if (pattern) {
    globPatternCache.delete(entry);
    globPatternCache.set(entry, pattern);
    return pattern.test(path);
  }

  const escaped = entry
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  pattern = new RegExp(`^${escaped}$`);

  if (globPatternCache.size >= GLOB_PATTERN_CACHE_LIMIT) {
    const oldestEntry = globPatternCache.keys().next().value;
    if (oldestEntry) globPatternCache.delete(oldestEntry);
  }
  globPatternCache.set(entry, pattern);

  return pattern.test(path);
}
