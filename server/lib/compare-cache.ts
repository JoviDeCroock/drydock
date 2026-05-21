import { downloadInSandbox } from "./sandbox";
import { redactFileRecords, redactJson, type FileRecord, type PackageJsonSummary } from "./review";

export interface CachedCompare {
  version: string;
  files: FileRecord[];
  packageJson: PackageJsonSummary | null;
  cachedAt: string;
}

const CACHE_PREFIX = "compare:v1:";
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

function cacheKey(packageName: string, version: string): string {
  return `${CACHE_PREFIX}${packageName}@${version}`;
}

export async function readCompareCache(
  env: Cloudflare.Env,
  packageName: string,
  version: string,
): Promise<CachedCompare | null> {
  if (!env.COMPARE_CACHE) return null;
  try {
    return await env.COMPARE_CACHE.get<CachedCompare>(cacheKey(packageName, version), "json");
  } catch {
    return null;
  }
}

async function writeCompareCache(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  packageName: string,
  payload: CachedCompare,
) {
  if (!env.COMPARE_CACHE) return;
  const write = env.COMPARE_CACHE.put(cacheKey(packageName, payload.version), JSON.stringify(payload), {
    expirationTtl: CACHE_TTL_SECONDS,
  }).catch(() => undefined);
  ctx.waitUntil(write);
}

export async function loadCompare(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  packageName: string,
  version: string,
  options: { tarballUrl: string; npmToken?: string; npmRegistry?: string },
): Promise<CachedCompare> {
  const cached = await readCompareCache(env, packageName, version);
  if (cached) return cached;

  const downloaded = await downloadInSandbox(env, ctx, {
    tarballUrl: options.tarballUrl,
    npmToken: options.npmToken,
    npmRegistry: options.npmRegistry,
  });

  const payload: CachedCompare = {
    version,
    files: redactFileRecords(downloaded.files),
    packageJson: redactJson(downloaded.packageJson ?? null),
    cachedAt: new Date().toISOString(),
  };
  await writeCompareCache(env, ctx, packageName, payload);
  return payload;
}

export function stripTextSamples(files: FileRecord[]): FileRecord[] {
  return files.map(({ textSample: _omitted, ...rest }) => rest);
}
