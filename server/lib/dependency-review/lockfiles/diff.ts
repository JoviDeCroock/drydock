import { compareSemver } from "../../ecosystems/semver";
import type { DependencyBump, DependencyEcosystem } from "../types";
import type { LockfileSnapshot } from "./snapshot";

// Pairs each version a lockfile gains with a version it had, per package.
//
// For one package, `added` are head versions the base lacked and `removed`
// the reverse; two spellings of one release cancel out. Lowest added version
// first, each takes the highest removed version below it (an upgrade). Added
// versions still unpaired then take the closest removed version left (a
// downgrade). Each removed version pairs once. An added version left over
// after that is an extra copy beside versions the base kept, and pairs with
// the closest base version; it is `fromVersion: null` only when the base had
// no version of the package at all. A removed version nothing pairs with is
// not a bump.
export function diffLockfileSnapshots(
  base: LockfileSnapshot | null,
  head: LockfileSnapshot,
  lockfilePath: string,
): DependencyBump[] {
  if (!head.complete || (base !== null && !base.complete)) return [];
  const bumps: DependencyBump[] = [];
  for (const [key, pkg] of head.packages) {
    const compare = COMPARE[pkg.ecosystem];
    const basePkg = base?.packages.get(key);
    const baseVersions = basePkg?.versions ?? new Set<string>();
    // Either side counts: a package that moved off a private registry would
    // otherwise be diffed against a public same-named release it never was.
    const privateSource = pkg.privateSource || basePkg?.privateSource === true;
    const before = [...baseVersions].sort(compare);
    let added = [...pkg.versions].filter((v) => !baseVersions.has(v));
    let removed = before.filter((v) => !pkg.versions.has(v));
    const equivalent = added.filter((v) => removed.some((r) => compare(v, r) === 0));
    added = added.filter((v) => !equivalent.includes(v));
    removed = removed.filter((r) => !equivalent.some((v) => compare(v, r) === 0));
    added.sort(compare);
    const from = new Map<string, string | null>();
    for (const toVersion of added) {
      const below = closest(removed, toVersion, compare, "below");
      if (below !== null) from.set(toVersion, take(removed, below));
    }
    for (const toVersion of added) {
      if (from.has(toVersion)) continue;
      const near = closest(removed, toVersion, compare, "either");
      from.set(
        toVersion,
        near !== null ? take(removed, near) : closest(before, toVersion, compare, "either"),
      );
    }
    for (const toVersion of added) {
      bumps.push({
        ecosystem: pkg.ecosystem,
        name: pkg.name,
        fromVersion: from.get(toVersion) ?? null,
        toVersion,
        direct: pkg.direct,
        lockfilePath,
        ...(privateSource ? { privateSource: true as const } : {}),
      });
    }
  }
  return bumps.sort(
    (a, b) =>
      ordinal(a.ecosystem, b.ecosystem) ||
      ordinal(a.name, b.name) ||
      COMPARE[a.ecosystem](a.toVersion, b.toVersion) ||
      ordinal(a.toVersion, b.toVersion),
  );
}

type Compare = (a: string, b: string) => number;

function take(pool: string[], version: string): string {
  pool.splice(pool.indexOf(version), 1);
  return version;
}

// `sorted` is ascending: the highest version below the target, else (for
// "either") the lowest above it.
function closest(
  sorted: string[],
  target: string,
  compare: Compare,
  side: "below" | "either",
): string | null {
  let below: string | null = null;
  for (const version of sorted) {
    const order = compare(version, target);
    if (order < 0) below = version;
    else if (order > 0) return below ?? (side === "either" ? version : null);
  }
  return below;
}

function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const COMPARE: Record<DependencyEcosystem, Compare> = {
  npm: compareSemver,
  pypi: comparePyPiOrder,
};

// Ordering only, for pairing: release segments numerically (trailing zeros
// ignored), then dev < a < b < rc < final < post, then the local label as text.
// Spellings PEP 440 calls equivalent but this does not parse (`1.0-1`, legacy
// non-PEP 440 strings) fall back to text order; a wrong pair there only picks a
// worse diff base, never drops a bump. The full PEP 440 implementation lives in
// the pypi ecosystem, which shared code may not import.
function comparePyPiOrder(a: string, b: string): number {
  const pa = parsePyPiOrder(a);
  const pb = parsePyPiOrder(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : ordinal(a, b);
  if (pa.epoch !== pb.epoch) return pa.epoch - pb.epoch;
  for (let i = 0; i < Math.max(pa.release.length, pb.release.length); i++) {
    const diff = (pa.release[i] ?? 0) - (pb.release[i] ?? 0);
    if (diff) return diff;
  }
  for (let i = 0; i < pa.phase.length; i++) {
    const diff = pa.phase[i] - pb.phase[i];
    if (diff) return diff;
  }
  return ordinal(pa.local, pb.local);
}

const PYPI_ORDER =
  /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\d*))?(?:[-_.]?(?:post|rev|r)[-_.]?(\d*))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+([a-z0-9.]+))?$/;
const PRE_RANK: Record<string, number> = { a: 1, alpha: 1, b: 2, beta: 2 };

function parsePyPiOrder(version: string) {
  // Validated versions are at most 128 characters, which bounds the pattern.
  const m = PYPI_ORDER.exec(version.toLowerCase());
  if (!m) return null;
  const [, epoch, release, pre, preN, post, dev, local] = m;
  // A bare dev release sorts below every pre-release of its release segment.
  const preRank = pre ? (PRE_RANK[pre] ?? 3) : dev !== undefined && post === undefined ? 0 : 4;
  return {
    epoch: Number(epoch ?? 0),
    release: release.split(".").map(Number),
    phase: [
      preRank,
      Number(preN || 0),
      post === undefined ? -1 : Number(post || 0),
      dev === undefined ? Number.POSITIVE_INFINITY : Number(dev || 0),
    ],
    local: local ?? "",
  };
}
