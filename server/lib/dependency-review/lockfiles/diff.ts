import { compareSemver } from "../../ecosystems/semver";
import type { DependencyBump, DependencyEcosystem } from "../types";
import type { LockfileSource, LockfileSnapshot } from "./snapshot";

/** One bump, with the recorded source of each side it pairs. */
export interface LockfileChange {
  bump: DependencyBump;
  from: LockfileSource | null;
  to: LockfileSource;
  // The target should carry a strong pin: its format always writes one, or
  // either side has one (a requirements line that has or dropped a `--hash`).
  pinExpected: boolean;
}

// Pairs each version a lockfile gains with a version it had, per package.
//
// For one package, `added` are head identities the base lacked and `removed`
// the reverse; two spellings of one public release cancel out. Identities
// order by the release they name (a registry source's version, a public
// identity itself), then by their text. Lowest added version first, each
// takes the highest removed version below it (an upgrade). Added versions
// still unpaired then take the closest removed version left (a downgrade).
// Each removed version pairs once. An added version left over after that is
// an extra copy beside versions the base kept, and pairs with the closest base
// version; it is `fromVersion: null` only when the base had no version of the
// package at all. A removed version nothing pairs with is not a bump.
//
// A bump is private when either of its own two sides is not public: a package
// that moved off a private registry would otherwise be diffed against a public
// same-named release it never was. Another copy of the name elsewhere in the
// tree does not make it private. It is remote when either side is a remote
// source.
//
// A public release both sides keep (or spell equivalently) whose head pins a
// copy with a pin no base copy had is a re-pin: `fromVersion` null,
// `toVersion` the release, `repinned`, and as its hashes only those of the
// introduced pins (null when any of them is not usable). The installer
// accepts whatever bytes match the new pin, so it is reviewed like a new
// release of its own.
export function diffLockfileChanges(
  base: LockfileSnapshot | null,
  head: LockfileSnapshot,
  lockfilePath: string,
): LockfileChange[] {
  if (!head.complete || (base !== null && !base.complete)) return [];
  const changes: LockfileChange[] = [];
  for (const [key, pkg] of head.packages) {
    const basePkg = base?.packages.get(key);
    const baseSources = basePkg?.sources ?? new Map<string, LockfileSource>();
    const sourceOf = (id: string) => (pkg.sources.get(id) ?? baseSources.get(id))!;
    const release = (id: string) => {
      const source = sourceOf(id);
      return source.kind === "remote" ? id : (source.version ?? id);
    };
    const versionOrder = COMPARE[pkg.ecosystem];
    const compare: Compare = (a, b) => versionOrder(release(a), release(b)) || ordinal(a, b);
    // Equivalent spellings (PyPI `1.0` and `1.0.0`) are one release only when
    // both are public; a non-public identity changes with its source or pin.
    const equivalent = (a: string, b: string) =>
      sourceOf(a).kind === "public" && sourceOf(b).kind === "public" && versionOrder(a, b) === 0;
    const before = [...baseSources.keys()].sort(compare);
    let added = [...pkg.sources.keys()].filter((v) => !baseSources.has(v));
    let removed = before.filter((v) => !pkg.sources.has(v));
    const same = added.filter((v) => removed.some((r) => equivalent(v, r)));
    const kept: Array<[string, string]> = [...pkg.sources.keys()]
      .filter((v) => baseSources.has(v))
      .map((v) => [v, v]);
    for (const v of same) kept.push([removed.find((r) => equivalent(v, r))!, v]);
    added = added.filter((v) => !same.includes(v));
    removed = removed.filter((r) => !same.some((v) => equivalent(v, r)));
    for (const [fromId, toId] of kept) {
      const fromSource = baseSources.get(fromId)!;
      const to = pkg.sources.get(toId)!;
      if (fromSource.kind !== "public" || to.kind !== "public") continue;
      // What the PR must prove is what it changed: the pins no base copy
      // had. A copy kept as it was proves nothing and owes nothing; a copy
      // the PR only removed installs nothing new.
      const introduced = to.pins.filter((pin) => !fromSource.pins.includes(pin));
      if (introduced.length === 0) continue;
      const usable = introduced.every((pin) => to.usablePins.includes(pin));
      const hashes = usable
        ? [...new Set(introduced.flatMap((pin) => pin.split(" ")))].sort()
        : null;
      const pinExpected = head.strongPins || hadPin(fromSource) || hadPin(to);
      // A base release only bundled copies record was never fetched, so the
      // copy the head fetches is new to the lockfile, not a re-pin of it.
      const fetchedFirst = fromSource.bundledOnly === true && !to.bundledOnly;
      changes.push({
        bump: {
          ecosystem: pkg.ecosystem,
          name: pkg.name,
          fromVersion: null,
          toVersion: toId,
          direct: pkg.direct,
          lockfilePath,
          ...(fetchedFirst ? {} : { repinned: true as const }),
        },
        from: fetchedFirst ? null : fromSource,
        to: { ...to, hashes },
        pinExpected,
      });
    }
    added.sort(compare);
    // A base release only bundled copies record is a predecessor only of
    // another bundled-only release: a fetched copy never came from it.
    const eligible = (toVersion: string, ids: string[]) =>
      pkg.sources.get(toVersion)!.bundledOnly
        ? ids
        : ids.filter((id) => !baseSources.get(id)!.bundledOnly);
    const from = new Map<string, string | null>();
    for (const toVersion of added) {
      const below = closest(eligible(toVersion, removed), toVersion, compare, "below");
      if (below !== null) from.set(toVersion, take(removed, below));
    }
    for (const toVersion of added) {
      if (from.has(toVersion)) continue;
      const near = closest(eligible(toVersion, removed), toVersion, compare, "either");
      from.set(
        toVersion,
        near !== null
          ? take(removed, near)
          : closest(eligible(toVersion, before), toVersion, compare, "either"),
      );
    }
    for (const toVersion of added) {
      const fromVersion = from.get(toVersion) ?? null;
      const to = pkg.sources.get(toVersion)!;
      const fromSource = fromVersion === null ? null : baseSources.get(fromVersion)!;
      const kinds = [to.kind, fromSource?.kind];
      changes.push({
        bump: {
          ecosystem: pkg.ecosystem,
          name: pkg.name,
          fromVersion,
          toVersion,
          direct: pkg.direct,
          lockfilePath,
          ...(kinds.some((kind) => kind === "registry" || kind === "remote")
            ? { privateSource: true as const }
            : {}),
          ...(kinds.includes("remote") ? { remoteSource: true as const } : {}),
          ...(to.sourceBuild ? { buildsFromSource: true as const } : {}),
        },
        from: fromSource,
        to,
        // A target only unpinned copies record (see `LockfileSource.pins`)
        // has nothing its format would pin.
        pinExpected:
          to.pins.length > 0 &&
          (head.strongPins || hadPin(to) || (fromSource !== null && hadPin(fromSource))),
      });
    }
  }
  return changes.sort(
    (a, b) =>
      ordinal(a.bump.ecosystem, b.bump.ecosystem) ||
      ordinal(a.bump.name, b.bump.name) ||
      COMPARE[a.bump.ecosystem](a.bump.toVersion, b.bump.toVersion) ||
      ordinal(a.bump.toVersion, b.bump.toVersion),
  );
}

export function diffLockfileSnapshots(
  base: LockfileSnapshot | null,
  head: LockfileSnapshot,
  lockfilePath: string,
): DependencyBump[] {
  return diffLockfileChanges(base, head, lockfilePath).map((change) => change.bump);
}

/** Whether two versions name one release (PEP 440 spellings for PyPI). */
export function sameRelease(ecosystem: DependencyEcosystem, a: string, b: string): boolean {
  return a === b || COMPARE[ecosystem](a, b) === 0;
}

type Compare = (a: string, b: string) => number;

function hadPin(source: LockfileSource): boolean {
  return source.pins.some((pin) => pin !== "");
}

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
