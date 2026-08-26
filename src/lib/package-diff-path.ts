import type { PackageJsonDiffEntry } from "../../server/types";
import {
  exactDependencyVersion,
  unusualDependencySpecKind,
} from "../../server/lib/review/dependency-specs";

export type DiffEcosystem = "npm" | "pypi" | "atpm";

export interface DiffSpec {
  ecosystem: DiffEcosystem;
  packageName: string;
  fromVersion: string;
  toVersion: string;
}

function encodePackageName(packageName: string): string {
  return packageName
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/^%40/, "@").replace(/%3A/g, ":"))
    .join("/");
}

const NAME_SEGMENTS: Partial<Record<DiffEcosystem, number>> = { pypi: 1, atpm: 2 };

export function packageDiffPath(
  ecosystem: DiffEcosystem,
  packageName: string,
  fromVersion: string,
  toVersion: string,
) {
  const prefix = ecosystem === "npm" ? "/diff" : `/diff/${ecosystem}`;
  return `${prefix}/${encodePackageName(packageName)}/${encodeURIComponent(fromVersion)}/${encodeURIComponent(toVersion)}`;
}

const CARD_PATH_PREFIX = "/og";
const CARD_PATH_SUFFIX = "/card.png";

export function packageDiffCardPath(
  ecosystem: DiffEcosystem,
  packageName: string,
  fromVersion: string,
  toVersion: string,
) {
  return `${CARD_PATH_PREFIX}${packageDiffPath(ecosystem, packageName, fromVersion, toVersion)}${CARD_PATH_SUFFIX}`;
}

export function parsePackageDiffCardPath(path: string): DiffSpec | null {
  if (!path.startsWith(`${CARD_PATH_PREFIX}/`) || !path.endsWith(CARD_PATH_SUFFIX)) return null;
  return parseDiffSpec(path.slice(CARD_PATH_PREFIX.length, -CARD_PATH_SUFFIX.length));
}

export function packageOnlyDiffPath(packageName: string) {
  return `/diff/${encodePackageName(packageName)}`;
}

function diffPathSegments(path: string): string[] | null {
  if (path !== "/diff" && !path.startsWith("/diff/")) return null;
  return path
    .slice("/diff".length)
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

export function parseDiffSpec(path: string): DiffSpec | null {
  const segments = diffPathSegments(path);
  if (!segments || !segments.length) return null;
  const prefixed = parsePrefixedDiffSpec(segments);
  if (prefixed) return prefixed;
  const nameSegmentCount = segments[0].startsWith("@") ? 2 : 1;
  if (segments.length !== nameSegmentCount + 2) return null;
  return {
    ecosystem: "npm",
    packageName: segments.slice(0, nameSegmentCount).join("/"),
    fromVersion: segments[nameSegmentCount],
    toVersion: segments[nameSegmentCount + 1],
  };
}

function parsePrefixedDiffSpec(segments: string[]): DiffSpec | null {
  for (const [ecosystem, nameSegments] of Object.entries(NAME_SEGMENTS)) {
    if (segments[0] !== ecosystem || !nameSegments) continue;
    if (segments.length !== nameSegments + 3) continue;
    return {
      ecosystem: ecosystem as DiffEcosystem,
      packageName: segments.slice(1, 1 + nameSegments).join("/"),
      fromVersion: segments[1 + nameSegments],
      toVersion: segments[2 + nameSegments],
    };
  }
  return null;
}

export function parseDiffPackage(path: string): string | null {
  const segments = diffPathSegments(path);
  if (!segments || !segments.length) return null;
  const nameSegmentCount = segments[0].startsWith("@") ? 2 : 1;
  if (segments.length !== nameSegmentCount) return null;
  return segments.join("/");
}

export type DependencyDiffRow = PackageJsonDiffEntry;

export function dependencyDiffHref(row: DependencyDiffRow): string | null {
  if (row.status === "removed") return null;
  if (row.staged !== undefined && unusualDependencySpecKind(row.staged)) return null;
  if (row.status === "modified") {
    const from = exactDependencyVersion(row.previous);
    const to = exactDependencyVersion(row.staged);
    return from && to && from !== to ? packageDiffPath("npm", row.key, from, to) : null;
  }
  return packageOnlyDiffPath(row.key);
}
