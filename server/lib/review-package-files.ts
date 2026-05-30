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

function globLikePackageFilesEntryMatches(entry: string, path: string): boolean {
  const escaped = entry
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(path);
}
