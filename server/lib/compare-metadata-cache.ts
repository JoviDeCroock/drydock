import { sha256Hex } from "./platform/crypto-utils";
import { readKvJson, writeKvJson } from "./platform/kv-json-cache";
import type { RegistryMetadata } from "./ecosystems/npm/registry";

const METADATA_CACHE_PREFIX = "compare-metadata:v1:";
const METADATA_CACHE_TTL_SECONDS = 5 * 60;
// Registry metadata is minutes-fresh, so repeat reads within a colo can use
// KV's minimum cached copy instead of round-tripping to central storage.
const METADATA_CACHE_READ_COLO_TTL_SECONDS = 60;

export async function computeCompareMetadataCacheKey(input: {
  registryUrl: string;
  packageName: string;
  cacheScope: string;
}): Promise<string> {
  const hex = await sha256Hex(`${input.cacheScope}|${input.registryUrl}|${input.packageName}`);
  return `${METADATA_CACHE_PREFIX}${hex}`;
}

export function readCompareMetadataCache<T = RegistryMetadata>(
  env: Cloudflare.Env,
  key: string,
): Promise<T | null> {
  return readKvJson<T>(env.COMPARE_CACHE, key, {
    cacheTtl: METADATA_CACHE_READ_COLO_TTL_SECONDS,
  });
}

export async function writeCompareMetadataCache<T = RegistryMetadata>(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  key: string,
  payload: T,
): Promise<void> {
  writeKvJson(env.COMPARE_CACHE, ctx, key, payload, {
    expirationTtl: METADATA_CACHE_TTL_SECONDS,
  });
}
