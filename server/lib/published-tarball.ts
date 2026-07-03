import { registryProtocolAllowed } from "./npm-connection";
import { reliableFetch } from "./reliable-fetch";
import {
  downloadInSandboxStream,
  SandboxError,
  SANDBOX_MAX_STREAM_TAR_BYTES,
  type DownloadResult,
} from "./sandbox";

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

  const headers = new Headers({
    accept: "application/octet-stream",
    "user-agent": "staged-publish-review/0.3",
  });
  if (options.npmToken) headers.set("authorization", `Bearer ${options.npmToken}`);

  let response: Response;
  try {
    response = await reliableFetch(tarballUrl, { headers, timeoutMs: 60_000 });
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
  );
}

export interface DownloadPublishedTarballOptions extends PublishedTarballFetchOptions {
  maxFiles?: number;
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
  const body = await fetchPublishedTarballStream(tarballUrl, options);
  return downloadInSandboxStream(env, ctx, {
    body,
    format: "tgz",
    maxFiles: options.maxFiles,
  });
}
