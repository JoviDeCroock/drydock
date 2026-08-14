const DISPLAY_METADATA_SUFFIX = ":display-metadata";
const DISPLAY_METADATA_READ_COLO_TTL_SECONDS = 60;

interface PublicDiffDisplayMetadata {
  displayName: string;
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
): void {
  if (!env.COMPARE_CACHE || !displayName) return;
  const write = env.COMPARE_CACHE.put(
    displayMetadataKey(publicDiffCacheKey),
    JSON.stringify({ displayName }),
    {
      expirationTtl: ttlSeconds,
    },
  ).catch(() => undefined);
  ctx.waitUntil(write);
}
