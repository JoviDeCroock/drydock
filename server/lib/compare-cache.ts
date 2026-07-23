import { downloadPublishedTarball } from "./published-tarball";
import type { RegistryMetadata } from "./registry";
import { redactFileRecords, redactJson, type FileRecord, type PackageJsonSummary } from "./review";

export interface CachedCompare {
  version: string;
  files: FileRecord[];
  packageJson: PackageJsonSummary | null;
  cachedAt: string;
}

const CACHE_PREFIX = "compare:v3:";
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
// Compare payloads are immutable once written (the key is content-addressed
// by scope + registry + tarball URL), so repeat reads — browsing a diff issues
// one read of the same key per file view — can be served from KV's colo cache
// instead of a round trip to its central stores. KV caches negative lookups
// for the same duration, which is safe here because the only writer runs in
// the request that observed the miss, and KV writes revalidate its caching
// tiers.
const CACHE_READ_COLO_TTL_SECONDS = 60 * 60;
const METADATA_CACHE_PREFIX = "compare-metadata:v1:";
const METADATA_CACHE_TTL_SECONDS = 5 * 60;

export async function computeCompareCacheKey(
  registryUrl: string,
  tarballUrl: string,
  cacheScope: string,
): Promise<string> {
  const data = new TextEncoder().encode(`${cacheScope}|${registryUrl}|${tarballUrl}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${CACHE_PREFIX}${hex}`;
}

export async function readCompareCache(
  env: Cloudflare.Env,
  key: string,
): Promise<CachedCompare | null> {
  if (!env.COMPARE_CACHE) return null;
  try {
    return await env.COMPARE_CACHE.get<CachedCompare>(key, {
      type: "json",
      cacheTtl: CACHE_READ_COLO_TTL_SECONDS,
    });
  } catch {
    return null;
  }
}

export async function computeCompareMetadataCacheKey(input: {
  registryUrl: string;
  packageName: string;
  cacheScope: string;
}): Promise<string> {
  const data = new TextEncoder().encode(
    `${input.cacheScope}|${input.registryUrl}|${input.packageName}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${METADATA_CACHE_PREFIX}${hex}`;
}

// Registry metadata is only minutes-fresh anyway (METADATA_CACHE_TTL_SECONDS),
// so repeat reads within a colo can serve KV's minimum colo-cached copy
// instead of round-tripping to central storage on every request.
const METADATA_CACHE_READ_COLO_TTL_SECONDS = 60;

export async function readCompareMetadataCache<T = RegistryMetadata>(
  env: Cloudflare.Env,
  key: string,
): Promise<T | null> {
  if (!env.COMPARE_CACHE) return null;
  try {
    return await env.COMPARE_CACHE.get<T>(key, {
      type: "json",
      cacheTtl: METADATA_CACHE_READ_COLO_TTL_SECONDS,
    });
  } catch {
    return null;
  }
}

export async function writeCompareMetadataCache<T = RegistryMetadata>(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  key: string,
  payload: T,
) {
  if (!env.COMPARE_CACHE) return;
  const write = env.COMPARE_CACHE.put(key, JSON.stringify(payload), {
    expirationTtl: METADATA_CACHE_TTL_SECONDS,
  }).catch(() => undefined);
  ctx.waitUntil(write);
}

async function writeCompareCache(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  key: string,
  payload: CachedCompare,
) {
  if (!env.COMPARE_CACHE) return;
  const write = env.COMPARE_CACHE.put(key, JSON.stringify(payload), {
    expirationTtl: CACHE_TTL_SECONDS,
  }).catch(() => undefined);
  ctx.waitUntil(write);
}

export async function loadCompare(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  version: string,
  options: {
    tarballUrl: string;
    registryUrl: string;
    npmToken?: string;
    cacheScope: string;
    allowInsecureLocalhost?: boolean;
  },
): Promise<CachedCompare> {
  const key = await computeCompareCacheKey(
    options.registryUrl,
    options.tarballUrl,
    options.cacheScope,
  );
  const cached = await readCompareCache(env, key);
  if (cached) return cached;

  const downloaded = await downloadPublishedTarball(env, ctx, options.tarballUrl, {
    registryUrl: options.registryUrl,
    npmToken: options.npmToken,
    allowInsecureLocalhost: options.allowInsecureLocalhost,
  });

  const payload: CachedCompare = {
    version,
    files: redactFileRecords(downloaded.files),
    packageJson: redactJson(downloaded.packageJson ?? null),
    cachedAt: new Date().toISOString(),
  };
  await writeCompareCache(env, ctx, key, payload);
  return payload;
}

export function stripTextSamples(files: FileRecord[]): FileRecord[] {
  return files.map(({ textSample: _omitted, ...rest }) => rest);
}
