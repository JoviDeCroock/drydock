/**
 * Which versions of a dependency the registry publishes, for dependency
 * readiness.
 *
 * Abbreviated packuments of popular packages run to tens of megabytes
 * (`next` is ~25 MB), so the body is streamed through the packument extractor
 * in version-keys-only mode: memory stays flat and only version keys and
 * dist-tags survive. A body past `MAX_PACKUMENT_BYTES` of decompressed JSON, or
 * with more than `MAX_VERSIONS` versions, is `too-large`, an answer rather than
 * a failure.
 *
 * Answers are cached in their own partition (`<scope>|versions`) next to the
 * pipeline's projected packuments (`<scope>|abbrev`): a versions-only document
 * must never stand in for the projection the pipeline reads (tarball URLs,
 * provenance). The scope is the caller's (`org:<id>` for credentialed reads,
 * `public` for anonymous ones), exactly as for the shared packument cache.
 */
import {
  computeCompareMetadataCacheKey,
  readCompareMetadataCache,
  writeCompareMetadataCache,
} from "../../compare-cache";
import { mapWithConcurrency } from "../../platform/concurrency";
import { parseContentLength } from "../../platform/bounded-body";
import { isRecord } from "../../platform/guards";
import { reliableFetch } from "../../platform/reliable-fetch";
import type { PackageVersionsLookup } from "./dependency-readiness";
import { createPackumentExtractor } from "./packument-stream";
import {
  ABBREVIATED_PACKUMENT_ACCEPT,
  isValidLegacyNpmPackageName,
  mayRejectVendorMediaType,
} from "./registry";

const MAX_PACKUMENT_BYTES = 64 * 1024 * 1024;
const MAX_VERSIONS = 100_000;
// Time allowed for a body once its headers have arrived.
const PACKUMENT_BODY_MS = 15_000;

export interface PackageVersionsSource {
  registryUrl: string;
  /** `org:<id>` with the organization's credential, `public` without one. */
  cacheScope: string;
}

async function cacheKey(source: PackageVersionsSource, name: string) {
  return computeCompareMetadataCacheKey({
    registryUrl: source.registryUrl,
    packageName: name,
    cacheScope: `${source.cacheScope}|versions`,
  });
}

function parseCached(value: unknown): PackageVersionsLookup | null {
  if (!isRecord(value)) return null;
  if (value.status === "not-found" || value.status === "too-large") return { status: value.status };
  if (value.status !== "found" || !Array.isArray(value.versions) || !isRecord(value.distTags)) {
    return null;
  }
  const distTags: Record<string, string> = Object.create(null);
  for (const [tag, version] of Object.entries(value.distTags)) {
    if (typeof version === "string") distTags[tag] = version;
  }
  return {
    status: "found",
    versions: value.versions.filter((v): v is string => typeof v === "string"),
    distTags,
  };
}

/** The cached answer, or `null` (miss, or the cache is unavailable). Never a registry request. */
export async function readCachedPackageVersions(
  env: Cloudflare.Env,
  source: PackageVersionsSource,
  name: string,
): Promise<PackageVersionsLookup | null> {
  try {
    return parseCached(await readCompareMetadataCache<unknown>(env, await cacheKey(source, name)));
  } catch {
    return null;
  }
}

/**
 * Reads each package from the registry, `concurrency` at a time, starting no
 * read after `budgetMs`; a name missing from the result was not reached.
 * `npmToken` is attached only by the npm broker. Every answer but `error` is
 * cached for the next check.
 */
export async function fetchPackageVersionsMany(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  source: PackageVersionsSource & { npmToken?: string },
  names: readonly string[],
  options: { concurrency: number; budgetMs: number },
): Promise<Array<{ name: string; lookup: PackageVersionsLookup }>> {
  const deadline = Date.now() + options.budgetMs;
  const results: Array<{ name: string; lookup: PackageVersionsLookup }> = [];
  await mapWithConcurrency(names, options.concurrency, async (name) => {
    if (Date.now() > deadline) return;
    const lookup = await fetchPackageVersions(source, name);
    results.push({ name, lookup });
    if (lookup.status === "error") return;
    try {
      await writeCompareMetadataCache(env, ctx, await cacheKey(source, name), lookup);
    } catch {
      // A failed cache write costs the next check a read, nothing more.
    }
  });
  return results;
}

async function fetchPackageVersions(
  source: PackageVersionsSource & { npmToken?: string },
  name: string,
): Promise<PackageVersionsLookup> {
  if (!isValidLegacyNpmPackageName(name)) return { status: "error" };
  const url = `${source.registryUrl.replace(/\/$/, "")}/${encodeURIComponent(name).replace(/^%40/, "@")}`;
  const request = (accept: string) => {
    const headers = new Headers({ accept });
    if (source.npmToken) headers.set("authorization", `Bearer ${source.npmToken}`);
    return reliableFetch(url, { headers });
  };
  let response: Response;
  try {
    response = await request(ABBREVIATED_PACKUMENT_ACCEPT);
    if (!response.ok && mayRejectVendorMediaType(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      response = await request("application/json");
    }
  } catch {
    return { status: "error" };
  }
  // npm answers 404 for a package that does not exist and for one the
  // credential cannot read; both mean nothing installable is visible.
  if (response.status === 404 || !response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    return response.status === 404 ? { status: "not-found" } : { status: "error" };
  }
  return streamVersions(response.body, parseContentLength(response.headers.get("content-length")));
}

async function streamVersions(
  body: ReadableStream<Uint8Array>,
  declaredBytes: number | null,
): Promise<PackageVersionsLookup> {
  // A declared length is the encoded size, never more than the decoded one.
  if (declaredBytes !== null && declaredBytes > MAX_PACKUMENT_BYTES) {
    await body.cancel().catch(() => undefined);
    return { status: "too-large" };
  }
  const extractor = createPackumentExtractor({
    maxVersions: MAX_VERSIONS,
    maxCapturedBytes: 512,
    versionKeysOnly: true,
  });
  const reader = body.getReader();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), PACKUMENT_BODY_MS);
  });
  let total = 0;
  let outcome: PackageVersionsLookup | null = null;
  try {
    for (;;) {
      const read = await Promise.race([reader.read(), timeout]);
      if (read === null) return (outcome = { status: "error" });
      if (read.done) break;
      // Counted after fetch's content decoding: the ceiling is decompressed JSON.
      total += read.value.byteLength;
      if (total > MAX_PACKUMENT_BYTES) return (outcome = { status: "too-large" });
      extractor.write(read.value);
    }
    const extract = extractor.end();
    if (extract.versionLimitExceeded) return (outcome = { status: "too-large" });
    if (!extract.versionsIsObject) return (outcome = { status: "error" });
    const distTags: Record<string, string> = Object.create(null);
    for (const [tag, version] of extract.distTags) distTags[tag] = version;
    return (outcome = { status: "found", versions: [...extract.versions.keys()], distTags });
  } catch {
    // A malformed document or a transport error.
    return (outcome = { status: "error" });
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (outcome?.status !== "found") await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
