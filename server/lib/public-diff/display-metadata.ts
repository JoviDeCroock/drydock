const DISPLAY_METADATA_SUFFIX = ":display-metadata";
const DISPLAY_METADATA_READ_COLO_TTL_SECONDS = 60;

interface PublicDiffDisplayMetadata {
  displayName: string;
  expiresAt?: string;
}

function displayMetadataKey(publicDiffCacheKey: string): string {
  return `${publicDiffCacheKey}${DISPLAY_METADATA_SUFFIX}`;
}

/** Read the tiny human-facing name used by server-rendered page metadata. */
export async function readPublicDiffDisplayName(
  env: Cloudflare.Env,
  publicDiffCacheKey: string,
): Promise<string | undefined> {
  if (!env.COMPARE_CACHE) return undefined;
  try {
    const cached = await env.COMPARE_CACHE.get<PublicDiffDisplayMetadata>(
      displayMetadataKey(publicDiffCacheKey),
      { type: "json", cacheTtl: DISPLAY_METADATA_READ_COLO_TTL_SECONDS },
    );
    if (cached?.expiresAt) {
      const expiresAtMs = Date.parse(cached.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return undefined;
    }
    return typeof cached?.displayName === "string" && cached.displayName
      ? cached.displayName
      : undefined;
  } catch {
    return undefined;
  }
}

/** Keep page metadata independent from the potentially multi-megabyte diff payload. */
export function writePublicDiffDisplayName(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  publicDiffCacheKey: string,
  displayName: string | undefined,
  ttlSeconds: number,
  expiresAt?: string,
): void {
  // KV requires at least a 60-second expiration TTL. Below that bound the
  // metadata simply falls back to the canonical DID spelling.
  if (!env.COMPARE_CACHE || !displayName || ttlSeconds < 60) return;
  const write = env.COMPARE_CACHE.put(
    displayMetadataKey(publicDiffCacheKey),
    JSON.stringify({ displayName, ...(expiresAt ? { expiresAt } : {}) }),
    {
      expirationTtl: ttlSeconds,
    },
  ).catch(() => undefined);
  ctx.waitUntil(write);
}
