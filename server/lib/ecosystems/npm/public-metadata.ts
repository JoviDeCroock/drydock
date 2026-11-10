import {
  computeCompareMetadataCacheKey,
  readCompareMetadataCache,
  readMetadataUnavailable,
  writeCompareMetadataCache,
  writeMetadataUnavailable,
} from "../../compare-metadata-cache";
import {
  fetchPackageMetadata,
  RegistryMetadataTooLargeError,
  type RegistryMetadata,
} from "./registry";
import { PublicDiffError } from "../../public-diff/error";

const PUBLIC_CACHE_SCOPE = "public";

const tooLarge = () =>
  new PublicDiffError("registry metadata exceeds the public diff size limit", 413);
const unavailable = () => new PublicDiffError("registry metadata fetch failed", 502);

/**
 * Cached, credential-free npm registry metadata read for the public diff path.
 * npm-specific (packument shape, npm registry URL), so it lives with the npm
 * adapter rather than under the ecosystem-generic `public-diff/`.
 *
 * Anyone can name any package here, so a failed read is cached briefly too:
 * otherwise repeating a request for an oversized packument would re-stream it
 * every time.
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
  const failed = await readMetadataUnavailable(env, key);
  if (failed) throw failed === "too_large" ? tooLarge() : unavailable();

  let metadata: RegistryMetadata;
  try {
    // Integrity is kept so dependency review can compare a mirror's lockfile
    // pin with the public release (`publicReleaseDigests`).
    metadata = await fetchPackageMetadata(env, packageName, {
      npmRegistry: registryUrl,
      integrity: true,
    });
  } catch (err) {
    // A missing package is cheap to re-ask and costs no cache write.
    if (err instanceof Error && err.message.includes("404")) {
      throw new PublicDiffError("package not found", 404);
    }
    const reason = err instanceof RegistryMetadataTooLargeError ? "too_large" : "unavailable";
    writeMetadataUnavailable(env, ctx, key, reason);
    throw reason === "too_large" ? tooLarge() : unavailable();
  }
  await writeCompareMetadataCache(env, ctx, key, metadata);
  return metadata;
}
