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
    .map((segment) =>
      encodeURIComponent(segment)
        .replace(/^%40/, "@")
        // Both are legal unencoded in a path segment (RFC 3986 pchar), and both
        // appear in ordinary names — `@scope` on npm, `did:plc:` on atpm — so
        // escaping them would only make every such URL unreadable.
        .replace(/%3A/g, ":"),
    )
    .join("/");
}

// How many path segments a package name occupies, per ecosystem. This is what
// makes the prefixed and un-prefixed forms unambiguous, so it is stated once
// here and read by both the builder and the parser.
//
// PyPI project names are always one segment. atpm names are always two — either
// `@handle/name` or `did:plc:.../name` — because every atpm package is published
// under a publisher identity. npm is the variable one: one segment unscoped, two
// when scoped, which the parser detects from the leading `@`.
//
// Every ecosystem except npm needs an entry: `packageDiffPath` prefixes anything
// that is not npm, and only the ecosystems listed here are parsed back. The
// round-trip test in `test/package-diff-path.test.mjs` covers each one.
const NAME_SEGMENTS: Partial<Record<DiffEcosystem, number>> = { pypi: 1, atpm: 2 };

// npm keeps the historical un-prefixed form (/diff/<name>/<from>/<to>) so
// existing links and indexed pages keep resolving; every other ecosystem is
// prefixed (/diff/pypi/<project>/..., /diff/atpm/@<handle>/<name>/...). The
// forms cannot collide: an npm package literally named "pypi" or "atpm" still
// parses as npm, because its path carries a different number of segments than
// the prefixed form of the same length.
export function packageDiffPath(
  ecosystem: DiffEcosystem,
  packageName: string,
  fromVersion: string,
  toVersion: string,
) {
  const prefix = ecosystem === "npm" ? "/diff" : `/diff/${ecosystem}`;
  return `${prefix}/${encodePackageName(packageName)}/${encodeURIComponent(fromVersion)}/${encodeURIComponent(toVersion)}`;
}

// Share-card image for a diff: the same path shape under /og, with a trailing
// /card.png. Built from packageDiffPath so the card and the page can never
// disagree about how a scoped name or a pkg.pr.new preview ref is encoded.
//
// Path segments rather than query parameters: an `&`-separated URL in an
// `og:image` attribute is an ambiguous ampersand that strict scrapers can
// mis-parse, and the card only unfurls correctly if every client agrees on it.
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

// Package-only form: /diff/<name>. The page resolves the latest published
// version pair for the package and redirects to the full spec. npm-only:
// its producers — dependency diff links and README badge markdown — emit it
// solely for npm packages, since the other ecosystems have no package-only
// diff form to resolve.
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
// segments (/diff/@scope/pkg/1.0.0/1.1.0); /diff/<ecosystem>/<name>/<from>/<to>
// for every other ecosystem, with <name> spanning that ecosystem's fixed
// segment count (see NAME_SEGMENTS). Anything else (including bare /diff) is
// the landing or package-only form.
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

// The /diff/<ecosystem>/... forms. Returns null — falling through to the npm
// reading — for anything that is not an exact match, so an npm package named
// after an ecosystem keeps resolving as itself.
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
