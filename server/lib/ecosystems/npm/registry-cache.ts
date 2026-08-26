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
}

export async function fetchPackageMetadataCached(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  input: CachedPackageMetadataInput,
): Promise<RegistryMetadata> {
  const key = await computeCompareMetadataCacheKey({
    registryUrl: input.registryUrl,
    packageName: input.packageName,
    cacheScope: input.abbreviated ? `${input.cacheScope}|abbrev` : input.cacheScope,
  });
  const cached = await readCompareMetadataCache(env, key);
  if (cached) return cached;

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
  return metadata;
}
