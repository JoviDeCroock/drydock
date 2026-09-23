import { sha256Hex } from "./platform/crypto-utils";
import { readKvJson, writeKvJson } from "./platform/kv-json-cache";
import { downloadPublishedTarball } from "./ecosystems/npm/published-tarball";
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
// Compatibility re-export: the metadata cache has its own module, but four
// ecosystem callers still import it from here.
export {
  computeCompareMetadataCacheKey,
  readCompareMetadataCache,
  writeCompareMetadataCache,
} from "./compare-metadata-cache";

export async function computeCompareCacheKey(
  registryUrl: string,
  tarballUrl: string,
  cacheScope: string,
): Promise<string> {
  const hex = await sha256Hex(`${cacheScope}|${registryUrl}|${tarballUrl}`);
  return `${CACHE_PREFIX}${hex}`;
}

export function readCompareCache(env: Cloudflare.Env, key: string): Promise<CachedCompare | null> {
  return readKvJson<CachedCompare>(env.COMPARE_CACHE, key, {
    cacheTtl: CACHE_READ_COLO_TTL_SECONDS,
  });
}

async function writeCompareCache(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  key: string,
  payload: CachedCompare,
): Promise<void> {
  writeKvJson(env.COMPARE_CACHE, ctx, key, payload, { expirationTtl: CACHE_TTL_SECONDS });
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
