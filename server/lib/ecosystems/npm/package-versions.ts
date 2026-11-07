/**
 * Which versions of a dependency the registry publishes, for dependency
 * readiness.
 *
 * Abbreviated packuments of popular packages run to tens of megabytes
 * (`next` is ~25 MB), so the body is streamed through the packument extractor
 * in version-keys-only mode: memory stays flat and only version keys and
 * dist-tags survive. A body past `MAX_PACKUMENT_BYTES` of decompressed JSON, or
 * with more than `MAX_VERSIONS` versions (or `MAX_VERSION_KEY_CHARS` of version
 * keys), is `too-large`, an answer rather than
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
import { fetchWithinBaseUrl } from "../../platform/url-scope";
import type { PackageVersionsLookup } from "./dependency-readiness";
import { createPackumentExtractor } from "./packument-stream";
import {
  ABBREVIATED_PACKUMENT_ACCEPT,
  isValidLegacyNpmPackageName,
  mayRejectVendorMediaType,
} from "./registry";

const MAX_PACKUMENT_BYTES = 64 * 1024 * 1024;
const MAX_VERSIONS = 100_000;
// A JSON string token, quotes included: semver caps a version at 256 chars.
const MAX_CAPTURED_BYTES = 258;
// Kept version-key characters per document. With at most 1,000 dist-tags of
// 258 bytes each, and JSON's worst case of 6 bytes per escaped char, the
// cached answer stays under ~16 MiB, below KV's 25 MiB value limit.
const MAX_VERSION_KEY_CHARS = 2 * 1024 * 1024;

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
 * Reads each package from the registry, `concurrency` at a time, within
 * `budgetMs`: no read starts after it and every read (headers and body) is
 * abandoned at it, as `error`. A name missing from the result was not reached.
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
    if (Date.now() >= deadline) return;
    const lookup = await fetchPackageVersions(source, name, deadline);
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
  deadline: number,
): Promise<PackageVersionsLookup> {
  if (!isValidLegacyNpmPackageName(name)) return { status: "error" };
  const url = `${source.registryUrl.replace(/\/$/, "")}/${encodeURIComponent(name).replace(/^%40/, "@")}`;
  const request = (accept: string) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("budget spent");
    const headers = new Headers({ accept });
    if (source.npmToken) headers.set("authorization", `Bearer ${source.npmToken}`);
    // One attempt: a retry could not finish inside the check's budget, and a
    // failed read is offered again as "Check again".
    return fetchWithinBaseUrl(url, source.registryUrl, {
      headers,
      attempts: 1,
      timeoutMs: remaining,
    });
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
  return streamVersions(
    response.body,
    parseContentLength(response.headers.get("content-length")),
    deadline,
  );
}

async function streamVersions(
  body: ReadableStream<Uint8Array>,
  declaredBytes: number | null,
  deadline: number,
): Promise<PackageVersionsLookup> {
  // A declared length is the encoded size, never more than the decoded one.
  if (declaredBytes !== null && declaredBytes > MAX_PACKUMENT_BYTES) {
    await body.cancel().catch(() => undefined);
    return { status: "too-large" };
  }
  const extractor = createPackumentExtractor({
    maxVersions: MAX_VERSIONS,
    maxCapturedBytes: MAX_CAPTURED_BYTES,
    maxVersionKeyChars: MAX_VERSION_KEY_CHARS,
    versionKeysOnly: true,
  });
  const reader = body.getReader();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
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
    // No `versions` key is a package with nothing published; a non-object one
    // is a document this check cannot read.
    if (!extract.versionsIsObject && extract.versionsPresent) {
      return (outcome = { status: "error" });
    }
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
