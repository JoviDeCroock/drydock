import type { PackageJsonDiffEntry } from "../../server/types";
import {
  exactDependencyVersion,
  unusualDependencySpecKind,
} from "../../server/lib/review/dependency-specs";

export type DiffEcosystem = "npm" | "pypi";

export interface DiffSpec {
  ecosystem: DiffEcosystem;
  packageName: string;
  fromVersion: string;
  toVersion: string;
}

function encodePackageName(packageName: string): string {
  return packageName
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/^%40/, "@"))
    .join("/");
}

// npm keeps the historical un-prefixed form (/diff/<name>/<from>/<to>) so
// existing links and indexed pages keep resolving; PyPI diffs live under
// /diff/pypi/<project>/<from>/<to>. The forms cannot collide: an npm package
// literally named "pypi" still parses as npm because its path has one fewer
// segment than the prefixed PyPI form.
export function packageDiffPath(
  ecosystem: DiffEcosystem,
  packageName: string,
  fromVersion: string,
  toVersion: string,
) {
  const prefix = ecosystem === "pypi" ? "/diff/pypi" : "/diff";
  return `${prefix}/${encodePackageName(packageName)}/${encodeURIComponent(fromVersion)}/${encodeURIComponent(toVersion)}`;
}

// Package-only form: /diff/<name>. The page resolves the latest published
// version pair for the package and redirects to the full spec. npm-only:
// dependency diff links are the only producer of this form, and they are
// suppressed for ecosystems whose dependencies are not npm packages.
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

// /diff/<name>/<from>/<to> for npm, where a scoped <name> spans two path
// segments (/diff/@scope/pkg/1.0.0/1.1.0); /diff/pypi/<project>/<from>/<to>
// for PyPI. Anything else (including bare /diff) is the landing or
// package-only form.
export function parseDiffSpec(path: string): DiffSpec | null {
  const segments = diffPathSegments(path);
  if (!segments || !segments.length) return null;
  if (segments[0] === "pypi" && segments.length === 4) {
    return {
      ecosystem: "pypi",
      packageName: segments[1],
      fromVersion: segments[2],
      toVersion: segments[3],
    };
  }
  const nameSegmentCount = segments[0].startsWith("@") ? 2 : 1;
  if (segments.length !== nameSegmentCount + 2) return null;
  return {
    ecosystem: "npm",
    packageName: segments.slice(0, nameSegmentCount).join("/"),
    fromVersion: segments[nameSegmentCount],
    toVersion: segments[nameSegmentCount + 1],
  };
}

// /diff/<name> with no versions (two segments for a scoped name). Returns the
// npm package name, or null for the landing form and full specs. A PyPI
// project-only form does not exist: nothing links it (see packageOnlyDiffPath),
// so /diff/pypi/<project> is not package-only and falls through to the landing.
export function parseDiffPackage(path: string): string | null {
  const segments = diffPathSegments(path);
  if (!segments || !segments.length) return null;
  const nameSegmentCount = segments[0].startsWith("@") ? 2 : 1;
  if (segments.length !== nameSegmentCount) return null;
  return segments.join("/");
}

export type DependencyDiffRow = PackageJsonDiffEntry;

// Best-effort diff-view target for a changed dependency, so a reviewer can
// inspect the dependency's own releases (the node-ipc/peacenotwar shape) from
// the manifest diff. A bump whose specs are both exact published versions links
// that pair directly; an added dependency has no previous
// version to anchor, so it links the package-only form and lets the page
// resolve the latest published pair. No link is safer than a confidently
// wrong one, so nothing is linked for: removed dependencies (they pull no new
// code); aliased/git/URL/file specs (the installed code is not the npm
// package named by the row key — linking that name could present a same-named
// squatter's diff as the dependency under review); and modified rows whose
// specs are ranges or equal (a range boundary need not be a published version,
// and a package-level fallback would land on an unrelated latest pair).
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
