import { getPublicDiffAdapter } from "../ecosystems";
import { publicDiffEgressAllowed } from "../public-diff";
import type { DependencyBump } from "./types";

// A release pins one sha512 (npm) or one sha256 per file (PyPI); NumPy-sized
// releases carry a few dozen files. Anything far past that is not a lockfile
// entry this layer wrote.
const MAX_PINNED_HASHES = 256;

/**
 * Whether a mirror-resolved bump (`bump.mirror`) pins the public registry's
 * own bytes on both sides, so it can be diffed as a public pair.
 *
 * Every pinned hash on each side must be one the public registry records for
 * that exact name and release (npm: the `sha512` component of `dist.integrity`;
 * PyPI: the sha256 of one of the release's files). The registry is read
 * through the adapter's anonymous, cached public-metadata path, so no
 * credential is attached and only the public hosts are asked. Any doubt (no
 * egress, an invalid name or version, a missing release or digest, a failed
 * read) is false, and the bump stays private.
 */
export async function verifyMirrorBump(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  bump: DependencyBump,
): Promise<boolean> {
  const mirror = bump.mirror;
  if (!mirror || bump.remoteSource) return false;
  if ((bump.fromVersion === null) !== (mirror.fromHashes === null)) return false;
  const sides: PinnedSide[] = [{ version: bump.toVersion, hashes: mirror.toHashes }];
  if (bump.fromVersion !== null) {
    sides.push({ version: bump.fromVersion, hashes: mirror.fromHashes! });
  }
  return publicDigestsMatch(env, ctx, bump, sides);
}

/**
 * Whether the hashes a lockfile pins for a public bump's target version
 * (`bump.pinnedHashes`) are the public registry's own for that release:
 * every one must be among the digests it records for exactly that name and
 * version, read the same anonymous, cached way as `verifyMirrorBump` and
 * false on the same doubts. A bump with no pinned hashes, or one that is not
 * public, is never looked up.
 */
export async function verifyPublicPin(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  bump: DependencyBump,
): Promise<boolean> {
  const hashes = bump.pinnedHashes;
  if (!hashes || bump.privateSource || bump.remoteSource || bump.mirror) return false;
  return publicDigestsMatch(env, ctx, bump, [{ version: bump.toVersion, hashes }]);
}

interface PinnedSide {
  version: string;
  hashes: readonly string[];
}

async function publicDigestsMatch(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  bump: DependencyBump,
  sides: readonly PinnedSide[],
): Promise<boolean> {
  if (!publicDiffEgressAllowed(env)) return false;
  const adapter = getPublicDiffAdapter(bump.ecosystem);
  if (!adapter?.publicReleaseDigests || !adapter.isValidPackageName(bump.name)) return false;
  for (const side of sides) {
    // npm's public diff also takes preview URLs as versions; a pin never is one.
    if (!adapter.isValidVersion(side.version) || side.version.includes(":")) return false;
    if (
      !Array.isArray(side.hashes) ||
      side.hashes.length === 0 ||
      side.hashes.length > MAX_PINNED_HASHES ||
      !side.hashes.every((hash) => typeof hash === "string")
    ) {
      return false;
    }
  }
  let digests: Array<ReadonlySet<string> | null>;
  try {
    digests = await adapter.publicReleaseDigests(
      env,
      ctx,
      adapter.normalizePackageName(bump.name),
      sides.map((side) => side.version),
    );
  } catch {
    return false;
  }
  return sides.every((side, i) => {
    const published = digests[i];
    return published != null && side.hashes.every((hash) => published.has(hash));
  });
}
