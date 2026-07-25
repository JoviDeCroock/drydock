import {
  computeCompareMetadataCacheKey,
  readCompareMetadataCache,
  writeCompareMetadataCache,
} from "../compare-cache";
import { fetchPackageMetadata, type RegistryMetadata } from "../ecosystems/npm/registry";
import { PublicDiffError } from "./error";

const PUBLIC_CACHE_SCOPE = "public";

/**
 * Cached, credential-free npm registry metadata read. Lives outside
 * `public-diff/index.ts` so ecosystem adapters can use it without importing the
 * orchestrator that imports them.
 */
export async function fetchPublicPackageMetadata(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  packageName: string,
  registryUrl: string,
): Promise<RegistryMetadata> {
  const key = await computeCompareMetadataCacheKey({
    registryUrl,
    packageName,
    cacheScope: PUBLIC_CACHE_SCOPE,
  });
  const cached = await readCompareMetadataCache(env, key);
  if (cached) return cached;

  let metadata: RegistryMetadata;
  try {
    metadata = await fetchPackageMetadata(env, packageName, { npmRegistry: registryUrl });
  } catch (err) {
    if (err instanceof Error && err.message.includes("404")) {
      throw new PublicDiffError("package not found", 404);
    }
    throw new PublicDiffError("registry metadata fetch failed", 502);
  }
  await writeCompareMetadataCache(env, ctx, key, metadata);
  return metadata;
}
