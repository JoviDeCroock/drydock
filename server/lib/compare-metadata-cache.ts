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

/**
 * Why an anonymous metadata read last failed, cached briefly under the
 * metadata key so a repeat request for the same package answers from KV
 * instead of re-reading (and, for `too_large`, re-streaming) the document.
 */
export type MetadataUnavailableReason = "too_large" | "unavailable";

// A document over the ceiling stays over it; an upstream failure may clear.
const UNAVAILABLE_TTL_SECONDS: Record<MetadataUnavailableReason, number> = {
  too_large: 10 * 60,
  unavailable: 60,
};

function unavailableKey(key: string): string {
  return `${key}:unavailable`;
}

export async function readMetadataUnavailable(
  env: Cloudflare.Env,
  key: string,
): Promise<MetadataUnavailableReason | null> {
  const cached = await readKvJson<{ reason?: unknown }>(env.COMPARE_CACHE, unavailableKey(key), {
    cacheTtl: METADATA_CACHE_READ_COLO_TTL_SECONDS,
  });
  const reason = cached?.reason;
  return reason === "too_large" || reason === "unavailable" ? reason : null;
}

export function writeMetadataUnavailable(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  key: string,
  reason: MetadataUnavailableReason,
): void {
  writeKvJson(
    env.COMPARE_CACHE,
    ctx,
    unavailableKey(key),
    { reason },
    { expirationTtl: UNAVAILABLE_TTL_SECONDS[reason] },
  );
}
