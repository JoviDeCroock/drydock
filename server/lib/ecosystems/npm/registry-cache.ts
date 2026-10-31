import {
  computeCompareMetadataCacheKey,
  readCompareMetadataCache,
  writeCompareMetadataCache,
} from "../../compare-cache";
import type { PackageVersionsLookup, PackageVersionsReadMode } from "./dependency-readiness";
import { fetchPackageMetadata, type RegistryMetadata } from "./registry";

export interface CachedPackageMetadataInput {
  packageName: string;
  registryUrl: string;
  // Credentialed reads must use an organization-specific partition.
  cacheScope: string;
  npmToken?: string;
  abbreviated?: boolean;
  /**
   * Skip the cached copy (still refreshing it). For a caller whose negative
   * answer ("no such version yet") is the one that goes stale within the TTL.
   */
  revalidate?: boolean;
  /** Body ceiling for the registry read; see `FetchPackageMetadataOptions.maxBytes`. */
  maxBytes?: number;
}

function cacheKey(input: CachedPackageMetadataInput) {
  return computeCompareMetadataCacheKey({
    registryUrl: input.registryUrl,
    packageName: input.packageName,
    cacheScope: input.abbreviated ? `${input.cacheScope}|abbrev` : input.cacheScope,
  });
}

export async function fetchPackageMetadataCached(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  input: CachedPackageMetadataInput,
): Promise<RegistryMetadata> {
  const key = await cacheKey(input);
  const cached = input.revalidate ? null : await readCompareMetadataCache(env, key);
  if (cached) return cached;

  const metadata = await fetchPackageMetadata(env, input.packageName, {
    npmToken: input.npmToken,
    npmRegistry: input.registryUrl,
    abbreviated: input.abbreviated,
    maxBytes: input.maxBytes,
  });
  try {
    await writeCompareMetadataCache(env, ctx, key, metadata);
  } catch {
    // ignore
  }
  return metadata;
}

// Dependency readiness reads only version keys and dist-tags from the
// abbreviated document; a packument past this is reported "could not check"
// rather than parsed. Popular packages' abbreviated packuments are a few MiB.
const PACKAGE_VERSIONS_MAX_BYTES = 8 * 1024 * 1024;

/**
 * One package's published versions for dependency readiness. `cache` mode
 * never reaches the registry and answers `null` on a miss. A registry 404 is
 * `not-found`: npm answers it both for a package that does not exist and for
 * one the credential cannot read, and both mean nothing installable is visible.
 */
export async function readPackageVersions(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  input: Pick<
    CachedPackageMetadataInput,
    "packageName" | "registryUrl" | "cacheScope" | "npmToken"
  >,
  mode: PackageVersionsReadMode,
): Promise<PackageVersionsLookup | null> {
  const read = { ...input, abbreviated: true };
  const toLookup = (metadata: RegistryMetadata): PackageVersionsLookup => ({
    status: "found",
    versions: Object.keys(metadata.versions ?? {}),
    distTags: metadata["dist-tags"] ?? {},
  });
  if (mode === "cache") {
    const cached = await readCompareMetadataCache(env, await cacheKey(read)).catch(() => null);
    return cached ? toLookup(cached) : null;
  }
  try {
    return toLookup(
      await fetchPackageMetadataCached(env, ctx, {
        ...read,
        // The cache pass already missed or is being revalidated.
        revalidate: true,
        maxBytes: PACKAGE_VERSIONS_MAX_BYTES,
      }),
    );
  } catch (err) {
    if (err instanceof Error && /\b404$/.test(err.message)) return { status: "not-found" };
    return { status: "error" };
  }
}
