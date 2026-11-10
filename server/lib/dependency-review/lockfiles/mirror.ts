import type { DependencyBump } from "../types";
import { sameRelease, type LockfileChange } from "./diff";
import { npmRegistryTarballPaths, type LockfileSource } from "./snapshot";

/**
 * Where the repository's committed registry config sends a name: the public
 * registry, these registry URLs, or somewhere this layer cannot read (a
 * flow-style or oversized config).
 */
export type NameRoute =
  | { kind: "public" }
  | { kind: "registries"; urls: readonly string[] }
  | { kind: "unknown" };

export const PUBLIC_ROUTE: NameRoute = { kind: "public" };

/**
 * The bump a lockfile change becomes under the repository's registry routing
 * and the organization's declared public mirrors (`policy.publicMirrors`,
 * normalized https prefixes ending in `/`).
 *
 * A name routed anywhere but the public registry is private. A private bump
 * is a mirror candidate when every side it pairs resolved under a declared
 * mirror (or from the public registry), is a registry copy of its own name and
 * version, and pins hashes a public-registry comparison can check; it then
 * names real versions and carries those hashes for `verifyMirrorBump`. A name
 * routed to any registry outside the declared mirrors is never a candidate:
 * verifying it would send that name to the public registry.
 */
export function routedBump(
  change: LockfileChange,
  route: NameRoute,
  mirrors: readonly string[],
): DependencyBump {
  const bump: DependencyBump =
    route.kind === "public" ? change.bump : { ...change.bump, privateSource: true };
  if (!bump.privateSource || bump.remoteSource || mirrors.length === 0) return bump;
  if (route.kind === "unknown") return bump;
  if (route.kind === "registries" && !route.urls.every((url) => indexUnderMirror(url, mirrors))) {
    return bump;
  }
  const side = (source: LockfileSource | null) =>
    source && mirrorSide(bump, source, route, mirrors) ? source : null;
  const to = side(change.to);
  if (!to) return bump;
  if (bump.fromVersion === null) {
    return {
      ...bump,
      toVersion: to.version!,
      mirror: { fromHashes: null, toHashes: to.hashes! },
    };
  }
  const from = side(change.from);
  // The same release on both sides (a re-pin or a move onto the mirror) has
  // no public pair to diff.
  if (!from || sameRelease(bump.ecosystem, from.version!, to.version!)) return bump;
  return {
    ...bump,
    fromVersion: from.version,
    toVersion: to.version!,
    mirror: { fromHashes: from.hashes!, toHashes: to.hashes! },
  };
}

function mirrorSide(
  bump: DependencyBump,
  source: LockfileSource,
  route: NameRoute,
  mirrors: readonly string[],
): boolean {
  if (source.mixed || !source.version || !source.hashes?.length) return false;
  if (source.kind === "public") return true;
  if (source.kind !== "registry") return false;
  // `pnpm-lock.yaml` and Berry's `yarn.lock` record no URL for a registry
  // copy; the repository's routing, already checked to point only at mirrors,
  // says where it came from.
  if (source.location === null) return route.kind === "registries";
  if (bump.ecosystem === "pypi") return indexUnderMirror(source.location, mirrors);
  const tails = npmRegistryTarballPaths(bump.name, source.version);
  return mirrors.some(
    (prefix) =>
      source.location!.startsWith(prefix) && tails.includes(source.location!.slice(prefix.length)),
  );
}

/**
 * A registry or index URL under a declared mirror prefix. The URL must be
 * already canonical and plain https with nothing percent-encoded after the
 * prefix, so the text compared is the path a server would serve.
 */
function indexUnderMirror(url: string, mirrors: readonly string[]): boolean {
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
    (parsed.href !== url && parsed.href !== `${url}/`)
  ) {
    return false;
  }
  const root = parsed.href.endsWith("/") ? parsed.href : `${parsed.href}/`;
  return mirrors.some(
    (prefix) => root.startsWith(prefix) && !root.slice(prefix.length).includes("%"),
  );
}

/**
 * Folds a bump into one already collected for the same change (another
 * lockfile, or another copy). Mirror hashes are unioned, since every one must
 * match the public registry; a change only one of them reads as a mirror copy
 * stays a plain private change.
 */
export function mergeBump(existing: DependencyBump, bump: DependencyBump): void {
  existing.direct ||= bump.direct;
  if (bump.remoteSource) existing.remoteSource = true;
  if (existing.mirror && bump.mirror && !existing.remoteSource) {
    const union = (a: readonly string[] | null, b: readonly string[] | null) =>
      a === null || b === null ? null : [...new Set([...a, ...b])].sort();
    existing.mirror = {
      fromHashes: union(existing.mirror.fromHashes, bump.mirror.fromHashes),
      toHashes: union(existing.mirror.toHashes, bump.mirror.toHashes)!,
    };
  } else {
    delete existing.mirror;
  }
}
