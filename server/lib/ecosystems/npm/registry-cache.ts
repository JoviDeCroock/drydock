import {
  computeCompareMetadataCacheKey,
  readCompareMetadataCache,
  writeCompareMetadataCache,
} from "../../compare-cache";
import { fetchPackageMetadata, type RegistryMetadata } from "./registry";

export interface CachedPackageMetadataInput {
  packageName: string;
  registryUrl: string;
  /**
   * Cache partition. MUST identify who the credential belongs to — every
   * credentialed read uses `org:<organizationId>` — because a packument for a
   * private package is only visible to tokens that may see it. A shared or
   * missing scope would serve one organization's private metadata to another.
   */
  cacheScope: string;
  npmToken?: string;
  /** Request npm's abbreviated packument. Keyed separately; see below. */
  abbreviated?: boolean;
}

/**
 * Short-TTL (5 minute) cached npm packument read, shared by the scan pipeline
 * and the compare/versions routes.
 *
 * Every scan of a staged publish fetches the package's full packument to pick
 * its diff baseline, and the same package is commonly scanned repeatedly (a
 * retried scan, a monorepo release, the same staged publish visible to more
 * than one organization). The registry document only changes when someone
 * publishes, so a few minutes of staleness costs at most a slightly older
 * baseline choice — which the report records explicitly in `BaselineInfo` —
 * while removing a multi-megabyte fetch + parse from the scan's critical path
 * and peak memory.
 *
 * The abbreviated flavor is part of the cache key: the full document carries
 * per-version `time` (the compare/versions UI renders publish dates) and the
 * abbreviated one does not, so the two must never satisfy each other's reads.
 */
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
  // Best-effort: a scan must not fail because a cache write did. The write is
  // already `.catch`-guarded inside the helper; this also covers an execution
  // context without `waitUntil` (direct pipeline invocation in tests/scripts).
  try {
    await writeCompareMetadataCache(env, ctx, key, metadata);
  } catch {
    // ignore
  }
  return metadata;
}
