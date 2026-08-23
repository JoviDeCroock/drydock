import { sha256Hex } from "./platform/crypto-utils";
import { downloadPublishedTarball } from "./ecosystems/npm/published-tarball";
import {
  applySampleRetention,
  redactFileRecords,
  redactJson,
  retainedSamplePaths,
  sampleCandidates,
  type FileRecord,
  type PackageJsonSummary,
} from "./review";
import { utf8ByteLength } from "./platform/json-size";
import { describeOperationalError, emitOperationalEvent } from "./platform/observability";

export interface CachedCompare {
  version: string;
  files: FileRecord[];
  packageJson: PackageJsonSummary | null;
  cachedAt: string;
  /**
   * True when the cached payload could not carry every file's display sample.
   * Retention is cheapest-first, so this being set does not mean no sample
   * survived; the per-file `sample-omitted` flag marks the records that lost
   * theirs. Mirrors PublicPackageDiff.textSamplesOmitted.
   */
  textSamplesOmitted?: boolean;
}

export interface LoadedCompare {
  /** The payload written to/read from KV and safe to return to file browsers. */
  cached: CachedCompare;
  /** Complete baseline files for semantic diff annotation. */
  comparisonFiles: FileRecord[];
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

// KV values cap at 25 MiB; leave headroom for metadata around the samples.
// Mirrors CACHE_MAX_PAYLOAD_BYTES in lib/public-diff.
const CACHE_MAX_PAYLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Serialize a compare payload so it fits inside `maxPayloadBytes`.
 *
 * Without this guard an oversized payload's `put` was rejected by KV inside a
 * swallowed `.catch()`, so the entry silently never existed and every
 * `/compare` + `/compare/file` request re-downloaded and re-parsed the whole
 * published tarball. Shedding the samples that buy the least review value keeps
 * the entry cacheable; the shed records carry `sample-omitted` so the workbench
 * says why a body is missing. There is no diff to prioritize by here (the
 * baseline side is the scan's own staged files, held elsewhere), so retention is
 * purely cheapest-sample-first.
 */
export function serializeCompareCachePayload(
  payload: CachedCompare,
  maxPayloadBytes = CACHE_MAX_PAYLOAD_BYTES,
): { serialized: string; samplesOmitted: boolean; cached: CachedCompare } {
  let serialized = JSON.stringify(payload);
  if (utf8ByteLength(serialized) <= maxPayloadBytes) {
    return { serialized, samplesOmitted: false, cached: payload };
  }
  // Drop the reference before building anything else: for the versions that
  // reach this branch the discarded string is ~20 MiB and the Worker still holds
  // the parsed archive.
  serialized = "";

  // Metadata-only floor. Doubles as the fallback below, so it is built once.
  const bare: CachedCompare = {
    ...payload,
    files: applySampleRetention(payload.files, new Set()),
    textSamplesOmitted: true,
  };
  const bareJson = JSON.stringify(bare);
  const budget = maxPayloadBytes - utf8ByteLength(bareJson);
  if (budget <= 0) return { serialized: bareJson, samplesOmitted: true, cached: bare };

  const retained = retainedSamplePaths(sampleCandidates([payload.files]), budget);
  if (!retained.size) return { serialized: bareJson, samplesOmitted: true, cached: bare };

  const reduced: CachedCompare = {
    ...payload,
    files: applySampleRetention(payload.files, retained),
    textSamplesOmitted: true,
  };
  const reducedJson = JSON.stringify(reduced);
  // Selection works from per-path cost arithmetic rather than a trial
  // serialization, so confirm the real payload fits before committing to it.
  return utf8ByteLength(reducedJson) <= maxPayloadBytes
    ? { serialized: reducedJson, samplesOmitted: true, cached: reduced }
    : { serialized: bareJson, samplesOmitted: true, cached: bare };
}

/**
 * Write the compare payload to KV and hand back exactly what a later reader will
 * get. Returning the cached (possibly shed) copy rather than the in-memory one
 * matters: otherwise the request that populates the cache renders every file body
 * with no `sample-omitted` flags, and the very next navigation — served from KV —
 * shows a different, sparser view of the same version.
 */
export async function writeCompareCache(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  key: string,
  payload: CachedCompare,
): Promise<CachedCompare> {
  if (!env.COMPARE_CACHE) return payload;
  const { serialized, samplesOmitted, cached } = serializeCompareCachePayload(payload);
  const cachedBytes = utf8ByteLength(serialized);
  if (cachedBytes > CACHE_MAX_PAYLOAD_BYTES) {
    // Even the metadata-only floor is over the cap — a release with an enormous
    // number of files. KV would reject the write; skip it and say so rather than
    // spend the request on a put that cannot land.
    emitOperationalEvent("warn", "compare_cache.write_skipped_oversize", {
      version: payload.version,
      fileCount: payload.files.length,
      cachedBytes,
      maxBytes: CACHE_MAX_PAYLOAD_BYTES,
    });
    // Nothing was cached, so nothing is shed for this request either.
    return payload;
  }
  if (samplesOmitted) {
    emitOperationalEvent("info", "compare_cache.samples_shed", {
      version: payload.version,
      fileCount: payload.files.length,
      cachedBytes,
      maxBytes: CACHE_MAX_PAYLOAD_BYTES,
    });
  }
  const write = env.COMPARE_CACHE.put(key, serialized, {
    expirationTtl: CACHE_TTL_SECONDS,
  }).catch((err: unknown) => {
    // Still fail-soft — a cache miss is correct-but-slow — but no longer silent:
    // a write that keeps failing is what turns every file view into a fresh
    // download, and that has to be visible in the logs.
    emitOperationalEvent("warn", "compare_cache.write_failed", {
      version: payload.version,
      cachedBytes,
      error: describeOperationalError(err),
    });
    return undefined;
  });
  ctx.waitUntil(write);
  return cached;
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
    /** Bypass shed entries when line-level diff semantics need full samples. */
    requireCompleteFiles?: boolean;
  },
): Promise<LoadedCompare> {
  const key = await computeCompareCacheKey(
    options.registryUrl,
    options.tarballUrl,
    options.cacheScope,
  );
  const cached = await readCompareCache(env, key);
  if (cached && (!options.requireCompleteFiles || !cached.textSamplesOmitted)) {
    return { cached, comparisonFiles: cached.files };
  }

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
  // The cached copy, so the populating request sees the same file bodies (and the
  // same `sample-omitted` flags) every later request will.
  return {
    cached: await writeCompareCache(env, ctx, key, payload),
    comparisonFiles: payload.files,
  };
}

export function stripTextSamples(files: FileRecord[]): FileRecord[] {
  return files.map(({ textSample: _omitted, ...rest }) => rest);
}
