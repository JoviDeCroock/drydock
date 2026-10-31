import {
  computeCompareMetadataCacheKey,
  readCompareMetadataCache,
  writeCompareMetadataCache,
} from "../../compare-cache";
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
}

export async function fetchPackageMetadataCached(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  input: CachedPackageMetadataInput,
): Promise<RegistryMetadata> {
  return (await fetchPackageMetadataCachedWithSource(env, ctx, input)).metadata;
}

/** The same read, also saying whether the answer came from the cache. */
export async function fetchPackageMetadataCachedWithSource(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  input: CachedPackageMetadataInput,
): Promise<{ metadata: RegistryMetadata; fromCache: boolean }> {
  const key = await computeCompareMetadataCacheKey({
    registryUrl: input.registryUrl,
    packageName: input.packageName,
    cacheScope: input.abbreviated ? `${input.cacheScope}|abbrev` : input.cacheScope,
  });
  const cached = input.revalidate ? null : await readCompareMetadataCache(env, key);
  if (cached) return { metadata: cached, fromCache: true };

  const metadata = await fetchPackageMetadata(env, input.packageName, {
    npmToken: input.npmToken,
    npmRegistry: input.registryUrl,
    abbreviated: input.abbreviated,
  });
  try {
    await writeCompareMetadataCache(env, ctx, key, metadata);
  } catch {
    // ignore
  }
  return { metadata, fromCache: false };
}
