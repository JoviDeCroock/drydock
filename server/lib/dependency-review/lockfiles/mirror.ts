import type { DependencyBump, DependencyEcosystem } from "../types";
import { sameRelease, type LockfileChange } from "./diff";
import {
  isPublicPyPiFileUrl,
  isPyPiSimpleIndex,
  npmRegistryTarballPaths,
  type LockfileSource,
} from "./snapshot";

/**
 * Where the repository's committed registry config sends a name: the public
 * registry, these registry URLs, or somewhere this layer cannot read (a
 * config outside the canonical shape, an environment-dependent value).
 */
export type NameRoute =
  | { kind: "public" }
  | { kind: "registries"; urls: readonly string[] }
  | { kind: "unknown" };

export const PUBLIC_ROUTE: NameRoute = { kind: "public" };

/**
 * The organization's declarations that place non-public sources: normalized
 * https prefixes ending in `/`, and lowercase `@scope`s.
 */
interface SourcePolicy {
  publicMirrors: readonly string[];
  privateRegistries: readonly string[];
  privateScopes: readonly string[];
}

// Worst last. A mirror copy is only as good as its proof; a private registry
// is the organization's own and never diffed; anything else is remote.
type Place = "public" | "mirror" | "private" | "remote";
const PLACE_RANK: Record<Place, number> = { public: 0, mirror: 1, private: 2, remote: 3 };

function worse(a: Place, b: Place): Place {
  return PLACE_RANK[b] > PLACE_RANK[a] ? b : a;
}

/**
 * The bump a lockfile change becomes under the repository's registry routing
 * and the organization's declarations. Authoritative for `privateSource`,
 * `remoteSource`, `mirror`, and `pinnedHashes`.
 *
 * Each side is placed by what fetches it: a public entry by the name's route
 * (pnpm, Berry, and npm all fetch from the configured registry, npm rewriting
 * public `resolved` URLs to it), a registry or remote entry by the URLs the
 * lockfile records. A URL or route is private only under a declared private
 * registry and a mirror copy only under a declared mirror; any other
 * non-public host is remote, since the PR chooses that URL and so cannot also
 * choose an exemption. An unreadable route is remote.
 *
 * - Every side public: a public bump. It carries the target's strong pins as
 *   `pinnedHashes` when the format records them, for `verifyPublicPin`.
 * - Some side under a mirror and the rest public or mirror: a mirror
 *   candidate when every side pins hashes a public comparison can check, with
 *   real versions and those hashes in `mirror` for `verifyMirrorBump`; the
 *   same release on both sides is a candidate re-pin (`fromVersion` null).
 *   Otherwise the mirror copy proves nothing and the bump is remote.
 * - Some side private and none remote: private.
 * - Otherwise remote.
 * - Except: a public or mirror head over a private or remote base is a
 *   package new to the lockfile (`replacesPrivate`), placed by its head.
 *
 * A name in a declared private scope is never public and never a mirror
 * candidate, so it is never sent to a public registry, whatever routing
 * outside the repository it relies on.
 */
export function routedBump(
  change: LockfileChange,
  route: NameRoute,
  policy: SourcePolicy,
): DependencyBump {
  const {
    privateSource: _private,
    remoteSource: _remote,
    mirror: _mirror,
    pinnedHashes: _pinned,
    ...rest
  } = change.bump;
  const bump: DependencyBump = rest;
  const sides = change.from ? [change.from, change.to] : [change.to];
  const places = sides.map((source) => placeOf(bump, source, route, policy));
  const secret = privateScope(bump, policy);
  const head = places[places.length - 1];
  const nonPublicBase = places.length === 2 && PLACE_RANK[places[0]] >= PLACE_RANK.private;
  // A private-scope name this change moves off a non-public source (a private
  // registry, another host, git, a URL) onto the public registry or a mirror:
  // what the install now fetches is a public package under the
  // organization's name, which is dependency confusion's signal. The move is
  // the signal, not the location: an organization may host its scope on the
  // public registry itself, so a scope name public on both sides, or new to
  // the lockfile, stays the organization's own.
  if (secret && (head === "public" || head === "mirror") && nonPublicBase) {
    return { ...bump, privateSource: true, remoteSource: true, privateScopePublic: true };
  }
  // A head that resolves publicly (or through a mirror) where the base was a
  // private registry or another non-public source: the base version is no
  // predecessor of the public release, which is what the install now fetches.
  // It is a package new to the lockfile, never exempt as the organization's
  // own; dependency confusion takes this shape.
  // The same holds for a base copy from a mirror whose bytes are not the ones
  // the head pins: nothing proves that copy was the public release.
  if (
    !secret &&
    PLACE_RANK[head] <= PLACE_RANK.mirror &&
    (nonPublicBase ||
      (places.length === 2 && places[0] === "mirror" && unprovenMirrorBase(bump, change)))
  ) {
    const { repinned: _repinned, ...rest } = change.bump;
    return routedBump(
      { ...change, bump: { ...rest, fromVersion: null, replacesPrivate: true }, from: null },
      route,
      policy,
    );
  }
  // The PR writes the head's URL, so a release it moves off the public
  // registry (or a mirror) onto a declared private registry is not the
  // organization's own package: the exemption needs the base on it already,
  // or a package new to the lockfile.
  if (
    places.length === 2 &&
    places[1] === "private" &&
    PLACE_RANK[places[0]] < PLACE_RANK.private
  ) {
    places[1] = "remote";
  }
  let place = places.reduce(worse);
  if (secret && (place === "public" || place === "mirror")) place = "private";
  if (place === "public") {
    const hashes = change.to.hashes;
    if (hashes && !change.to.mixed) return { ...bump, pinnedHashes: hashes };
    // Expected and unusable (missing, weak, beside an unknown algorithm,
    // malformed): an empty list, which no proof satisfies.
    return change.pinExpected ? { ...bump, pinnedHashes: [] } : bump;
  }
  if (place === "mirror") {
    const candidate = mirrorCandidate(bump, change, route, policy);
    if (candidate) return candidate;
    place = "remote";
  }
  if (place === "private") return { ...bump, privateSource: true };
  return { ...bump, privateSource: true, remoteSource: true };
}

// A base copy from a mirror of the release the head also installs, pinned to
// bytes other than the head's: a re-pin would prove only the head's pin, never
// that the base copy was the public release.
function unprovenMirrorBase(bump: DependencyBump, change: LockfileChange): boolean {
  const { from, to } = change;
  if (!from?.version || !to.version || !sameRelease(bump.ecosystem, from.version, to.version)) {
    return false;
  }
  const same = (a: readonly string[] | null, b: readonly string[] | null) =>
    a !== null && b !== null && a.length > 0 && a.join(" ") === b.join(" ");
  return from.mixed || to.mixed || !same(from.hashes, to.hashes);
}

function privateScope(bump: DependencyBump, policy: SourcePolicy): boolean {
  if (bump.ecosystem !== "npm" || !bump.name.startsWith("@")) return false;
  const scope = bump.name.slice(0, bump.name.indexOf("/")).toLowerCase();
  return policy.privateScopes.includes(scope);
}

function placeOf(
  bump: DependencyBump,
  source: LockfileSource,
  route: NameRoute,
  policy: SourcePolicy,
): Place {
  if (source.kind === "public") return routePlace(route, policy);
  if (source.kind === "remote") {
    // A remote tarball under a declared private registry is that registry's.
    return source.location !== null &&
      underPrefix(source.location, policy.privateRegistries, "file")
      ? "private"
      : "remote";
  }
  if (source.location === null) return "remote";
  let place = urlPlace(bump.ecosystem, source.location, policy, "location");
  for (const url of source.urls)
    place = worse(place, urlPlace(bump.ecosystem, url, policy, "file"));
  return place;
}

function routePlace(route: NameRoute, policy: SourcePolicy): Place {
  if (route.kind === "public") return "public";
  if (route.kind === "unknown" || route.urls.length === 0) return "remote";
  return route.urls.map((url) => indexPlace(url, policy)).reduce(worse);
}

function indexPlace(url: string, policy: SourcePolicy): Place {
  if (underPrefix(url, policy.privateRegistries, "index")) return "private";
  if (underPrefix(url, policy.publicMirrors, "index")) return "mirror";
  return "remote";
}

// A registry entry's recorded URL. npm: a registry-shaped tarball URL; uv: the
// index (`location`) and each file URL. PyPI's own index and file host are
// public.
function urlPlace(
  ecosystem: DependencyEcosystem,
  url: string,
  policy: SourcePolicy,
  role: "location" | "file",
): Place {
  if (ecosystem === "pypi") {
    if (role === "location" ? isPyPiSimpleIndex(url) : isPublicPyPiFileUrl(url)) return "public";
    if (role === "location") return indexPlace(url, policy);
  }
  if (underPrefix(url, policy.privateRegistries, "file")) return "private";
  if (underPrefix(url, policy.publicMirrors, "file")) return "mirror";
  return "remote";
}

function mirrorCandidate(
  bump: DependencyBump,
  change: LockfileChange,
  route: NameRoute,
  policy: SourcePolicy,
): DependencyBump | null {
  // Checking a copy sends the name to the public registry, so a route to any
  // registry but a declared mirror rules it out.
  if (route.kind === "unknown") return null;
  if (
    route.kind === "registries" &&
    route.urls.some((url) => indexPlace(url, policy) !== "mirror")
  ) {
    return null;
  }
  const side = (source: LockfileSource) => mirrorSide(bump, source, policy);
  const to = change.to;
  if (!side(to)) return null;
  const from = change.from;
  const toVersion = to.version!;
  const repin =
    bump.fromVersion === null ||
    (from !== null &&
      from.version !== null &&
      sameRelease(bump.ecosystem, from.version, toVersion));
  if (from !== null && !repin && !side(from)) return null;
  if (repin) {
    // A new package, a copy moved onto the mirror, or a re-pin: there is no
    // earlier release to diff, and the target's pins are what is proven.
    const moved = from !== null || bump.repinned === true;
    return {
      ...bump,
      fromVersion: null,
      toVersion,
      privateSource: true,
      ...(moved ? { repinned: true as const } : {}),
      mirror: { fromHashes: null, toHashes: to.hashes! },
    };
  }
  return {
    ...bump,
    fromVersion: from!.version,
    toVersion,
    privateSource: true,
    mirror: { fromHashes: from!.hashes!, toHashes: to.hashes! },
  };
}

// A side a public comparison can check: one place, a real version, usable
// hashes, and (for a recorded URL) the mirror's copy of exactly this release.
function mirrorSide(bump: DependencyBump, source: LockfileSource, policy: SourcePolicy): boolean {
  if (source.mixed || !source.version || !source.hashes?.length) return false;
  if (source.kind === "public") return true;
  if (source.kind !== "registry" || source.location === null) return false;
  if (bump.ecosystem === "pypi") return true;
  const tails = npmRegistryTarballPaths(bump.name, source.version);
  const location = source.location;
  return policy.publicMirrors.some(
    (prefix) => location.startsWith(prefix) && tails.includes(location.slice(prefix.length)),
  );
}

/**
 * A URL under one of `prefixes`. It must be plain https, already canonical
 * (what a server would be asked for), with no credentials, query, or
 * fragment, and nothing after the prefix that could climb out of it: for an
 * index no percent-encoding at all; for a file no `..`, and no encoding but
 * the `%2f` of a scoped tarball name.
 */
function underPrefix(url: string, prefixes: readonly string[], role: "index" | "file"): boolean {
  if (prefixes.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    url.includes("?") ||
    url.includes("#") ||
    (parsed.href !== url && !(role === "index" && parsed.href === `${url}/`))
  ) {
    return false;
  }
  const target = role === "index" && !parsed.href.endsWith("/") ? `${parsed.href}/` : parsed.href;
  return prefixes.some((prefix) => {
    if (!target.startsWith(prefix)) return false;
    const rest = target.slice(prefix.length);
    if (role === "index") return !rest.includes("%");
    return !rest.includes("..") && !rest.replace(/%2f/gi, "").includes("%");
  });
}

/**
 * Folds a bump into one already collected for the same change (another
 * lockfile, or another copy). Mirror hashes are unioned, since every one must
 * match the public registry; a change only one of them pins comparably keeps
 * no mirror proof and stays unproven. Pinned hashes are unioned too; one copy
 * that expected a pin and has none (`[]`) leaves nothing provable, and a copy
 * whose format has no comparable pin adds nothing to prove.
 */
export function mergeBump(existing: DependencyBump, bump: DependencyBump): void {
  existing.direct ||= bump.direct;
  if (bump.remoteSource) existing.remoteSource = true;
  // New in any lockfile is new: a re-pin elsewhere must not hide it.
  if (!bump.repinned) delete existing.repinned;
  if (bump.replacesPrivate) existing.replacesPrivate = true;
  if (bump.buildsFromSource) existing.buildsFromSource = true;
  if (bump.privateScopePublic) existing.privateScopePublic = true;
  // Fail closed: the change counts as pinning the whole tree only when every
  // lockfile it came from does.
  if (!bump.lockfilePinsTree) delete existing.lockfilePinsTree;
  const union = (a: readonly string[] | null, b: readonly string[] | null) =>
    a === null || b === null ? null : [...new Set([...a, ...b])].sort();
  if (existing.mirror && bump.mirror && !existing.remoteSource) {
    existing.mirror = {
      fromHashes: union(existing.mirror.fromHashes, bump.mirror.fromHashes),
      toHashes: union(existing.mirror.toHashes, bump.mirror.toHashes)!,
    };
  } else {
    delete existing.mirror;
  }
  const pinned = [existing.pinnedHashes, bump.pinnedHashes].filter((list) => list !== undefined);
  if (existing.privateSource || pinned.length === 0) {
    delete existing.pinnedHashes;
  } else if (pinned.some((list) => list.length === 0)) {
    existing.pinnedHashes = [];
  } else {
    existing.pinnedHashes = pinned.reduce((a, b) => union(a, b)!);
  }
}
