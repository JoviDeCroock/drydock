import { parsePkgPrNewUrl } from "../../../../src/lib/pkg-pr-new";
import { coloCache } from "../../platform/http";
import { registryProtocolAllowed } from "./connection";
import { reliableFetch } from "../../platform/reliable-fetch";
import {
  downloadInSandboxStream,
  SandboxError,
  SANDBOX_MAX_STREAM_TAR_BYTES,
  type ArchiveDigestAlgorithm,
  type DownloadResult,
} from "../../sandbox";

export function isPublishedTarballUrlAllowed(
  tarballUrl: string,
  registryUrl: string,
  allowInsecureLocalhost: boolean,
): boolean {
  try {
    const tarball = new URL(tarballUrl);
    const registry = new URL(registryUrl);
    return (
      tarball.origin === registry.origin &&
      registryProtocolAllowed(tarball, { allowInsecureLocalhost }) &&
      tarball.pathname.endsWith(".tgz") &&
      tarball.pathname.includes("/-/")
    );
  } catch {
    return false;
  }
}

export interface PublishedTarballFetchOptions {
  registryUrl: string;
  npmToken?: string;
  allowInsecureLocalhost?: boolean;
  maxBytes?: number;
  waitUntil?: (promise: Promise<unknown>) => void;
  signal?: AbortSignal;
}

// Published tarball URLs are version-pinned and immutable, so the TTL bounds
// colo cache occupancy, not staleness.
const TARBALL_CACHE_CONTROL = "public, max-age=604800, immutable";

// Hosts where anonymous and authenticated fetches of the same tarball URL are
// guaranteed to return the same bytes, so a token-bearing request may consume
// the shared anonymous cache. Custom registries stay off this list: if one
// varied tarball bytes by auth, a cached anonymous copy would corrupt the
// scan evidence.
const PUBLIC_NPM_HOSTS = new Set(["registry.npmjs.org"]);

/**
 * Colo-level byte cache for published tarballs. Two invariants keep the
 * shared (cross-organization) cache safe:
 *
 * 1. Entries are only ever written by {@link warmPublishedTarballCache},
 *    which re-fetches WITHOUT credentials — the cache can only ever hold
 *    bytes any anonymous client could fetch. Private tarballs 404 the
 *    anonymous warm fetch and are never stored.
 * 2. Token-bearing requests may only read the cache for PUBLIC_NPM_HOSTS,
 *    where anonymous and authenticated bytes are identical.
 *
 * The warm fetch is a second download rather than a tee of the serving
 * stream: tee buffers whichever branch lags, which would break this module's
 * "never buffered in the parent" memory invariant.
 */
function publishedTarballCacheEligible(
  tarballUrl: string,
  options: PublishedTarballFetchOptions,
): boolean {
  if (options.allowInsecureLocalhost) return false;
  try {
    const url = new URL(tarballUrl);
    if (url.protocol !== "https:") return false;
    if (!options.npmToken) return true;
    return PUBLIC_NPM_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

async function matchPublishedTarballCache(
  tarballUrl: string,
  maxBytes: number,
): Promise<ReadableStream<Uint8Array> | null> {
  try {
    const cached = await coloCache().match(tarballUrl);
    if (!cached?.body) return null;
    const contentLength = Number(cached.headers.get("content-length") || "0");
    if (contentLength > maxBytes) {
      await cached.body.cancel();
      return null;
    }
    return cached.body;
  } catch {
    return null;
  }
}

async function warmPublishedTarballCache(tarballUrl: string): Promise<void> {
  try {
    const response = await reliableFetch(tarballUrl, {
      headers: tarballRequestHeaders(),
      timeoutMs: 60_000,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return;
    }
    const headers = new Headers({ "cache-control": TARBALL_CACHE_CONTROL });
    for (const name of ["content-type", "content-length"]) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    await coloCache().put(tarballUrl, new Response(response.body, { status: 200, headers }));
  } catch {
    // Warming is best-effort: the serving fetch already succeeded, and a cold
    // cache only costs the next request a registry round trip.
  }
}

function tarballRequestHeaders(): Headers {
  return new Headers({
    accept: "application/octet-stream",
    "user-agent": "staged-publish-review/0.3",
  });
}

/**
 * Opens a published npm tarball stream from inside the trusted parent worker.
 *
 * The npm token is attached only after the URL is proven to share the
 * configured registry origin, so the credential can never reach a
 * package-controlled host. The bytes are NOT buffered or decompressed here —
 * the body streams straight into the credentials-free sandbox via
 * {@link downloadPublishedTarball}, so the parent's memory footprint is
 * independent of tarball size. Size enforcement lives in the sandbox (its
 * compressed and decompressed stream caps map to a 413 that lets callers
 * degrade gracefully); here `maxBytes` only gates the advertised
 * content-length up front and anchors a 2× mid-stream backstop.
 */
export async function fetchPublishedTarballStream(
  tarballUrl: string,
  options: PublishedTarballFetchOptions,
): Promise<ReadableStream<Uint8Array>> {
  const maxBytes = options.maxBytes ?? SANDBOX_MAX_STREAM_TAR_BYTES;
  if (
    !isPublishedTarballUrlAllowed(
      tarballUrl,
      options.registryUrl,
      options.allowInsecureLocalhost ?? false,
    )
  ) {
    throw new SandboxError(
      JSON.stringify({
        error: "tarball URL is not allowed by the registry origin policy",
        status: 400,
      }),
    );
  }

  const cacheEligible = publishedTarballCacheEligible(tarballUrl, options);
  if (cacheEligible) {
    const cachedBody = await matchPublishedTarballCache(tarballUrl, maxBytes);
    if (cachedBody) return capByteStream(cachedBody, maxBytes, options.signal);
  }

  const headers = tarballRequestHeaders();
  if (options.npmToken) headers.set("authorization", `Bearer ${options.npmToken}`);

  let response: Response;
  try {
    response = await reliableFetch(tarballUrl, {
      headers,
      timeoutMs: 60_000,
      signal: options.signal,
    });
  } catch {
    throw new SandboxError(JSON.stringify({ error: "download failed", status: 502 }));
  }
  if (!response.ok) {
    throw new SandboxError(JSON.stringify({ error: "download failed", status: response.status }));
  }
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength > maxBytes) {
    throw new SandboxError(JSON.stringify({ error: "tarball too large", status: 413 }));
  }
  if (!response.body) {
    throw new SandboxError(JSON.stringify({ error: "archive download failed", status: 502 }));
  }
  if (cacheEligible) options.waitUntil?.(warmPublishedTarballCache(tarballUrl));
  return capByteStream(response.body, maxBytes, options.signal);
}

// Backstop, not enforcement. The sandbox bounds the compressed wire bytes
// itself (boundedByteStream at the same `maxBytes` default), and its overflow
// surfaces as a proper 413 through the response path, which lets
// acquireBaselineNpm degrade to a no-baseline scan. A mid-stream error THROWN
// HERE cannot carry a 413 across the sandbox boundary — it reaches the parser
// as an anonymous stream failure and would fail the whole scan — so this cap
// sits at double the sandbox's threshold: the sandbox always trips first and
// cancels the pipe, and this transform only fires if a (compromised,
// cap-ignoring) sandbox keeps pulling, where failing hard is correct.
function capByteStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const backstop = 2 * maxBytes;
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > backstop) {
          controller.error(new Error("tarball too large"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
    { signal },
  );
}

/**
 * Opens a pkg.pr.new preview tarball stream. Separate from
 * {@link fetchPublishedTarballStream} on purpose: this path is structurally
 * anonymous — it takes no token option and never attaches credentials — so
 * adding preview support cannot widen where npm auth can travel. The URL must
 * re-validate as a canonical pkg.pr.new package URL here, not just at the
 * route layer. Preview refs (pull-request numbers, re-run commit builds) are
 * mutable, so the bytes are never written to the shared colo tarball cache.
 */
export async function fetchPkgPrNewTarballStream(
  tarballUrl: string,
  options: { maxBytes?: number } = {},
): Promise<ReadableStream<Uint8Array>> {
  const maxBytes = options.maxBytes ?? SANDBOX_MAX_STREAM_TAR_BYTES;
  const spec = parsePkgPrNewUrl(tarballUrl);
  if (!spec || spec.url !== tarballUrl) {
    throw new SandboxError(
      JSON.stringify({
        error: "tarball URL is not an allowed pkg.pr.new package URL",
        status: 400,
      }),
    );
  }

  let response: Response;
  try {
    response = await reliableFetch(spec.url, {
      headers: tarballRequestHeaders(),
      timeoutMs: 60_000,
    });
  } catch {
    throw new SandboxError(JSON.stringify({ error: "download failed", status: 502 }));
  }
  if (!response.ok) {
    throw new SandboxError(JSON.stringify({ error: "download failed", status: response.status }));
  }
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength > maxBytes) {
    throw new SandboxError(JSON.stringify({ error: "tarball too large", status: 413 }));
  }
  if (!response.body) {
    throw new SandboxError(JSON.stringify({ error: "archive download failed", status: 502 }));
  }
  return capByteStream(response.body, maxBytes);
}

/**
 * Anonymous fetch + credentials-free streaming parse of a pkg.pr.new preview
 * tarball. Like {@link downloadPublishedTarball}, the archive is never
 * materialized in the parent worker.
 */
export async function downloadPkgPrNewTarball(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  tarballUrl: string,
  options: { maxBytes?: number; maxFiles?: number } = {},
): Promise<DownloadResult> {
  const body = await fetchPkgPrNewTarballStream(tarballUrl, { maxBytes: options.maxBytes });
  return downloadInSandboxStream(env, ctx, {
    body,
    format: "tgz",
    maxFiles: options.maxFiles,
    tarRootStrip: "strip1",
  });
}

export interface DownloadPublishedTarballOptions extends PublishedTarballFetchOptions {
  maxFiles?: number;
  /** See `DownloadOptions.maxTextSampleChars` in `lib/sandbox.ts`. */
  maxTextSampleChars?: number;
  /**
   * See `DownloadOptions.archiveDigestAlgorithms`. The dependency-artifact path
   * asks for SHA-512 so the digest it recomputes is comparable to the SRI npm
   * publishes as `dist.integrity`.
   */
  archiveDigestAlgorithms?: readonly ArchiveDigestAlgorithm[];
}

/**
 * Trusted-parent fetch + credentials-free streaming parse of a published npm
 * tarball used as the previous-version diff baseline. The archive is never
 * materialized in the parent worker.
 */
export async function downloadPublishedTarball(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  tarballUrl: string,
  options: DownloadPublishedTarballOptions,
): Promise<DownloadResult> {
  const body = await fetchPublishedTarballStream(tarballUrl, {
    ...options,
    waitUntil: (promise) => ctx.waitUntil(promise),
  });
  return downloadInSandboxStream(env, ctx, {
    body,
    format: "tgz",
    maxFiles: options.maxFiles,
    maxTextSampleChars: options.maxTextSampleChars,
    tarRootStrip: "strip1",
    archiveDigestAlgorithms: options.archiveDigestAlgorithms,
  });
}
