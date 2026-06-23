import { registryProtocolAllowed } from "./npm-connection";
import { reliableFetch } from "./reliable-fetch";
import {
  downloadInSandboxInline,
  SandboxError,
  SANDBOX_MAX_TAR_BYTES,
  type DownloadResult,
} from "./sandbox";
import { readStreamBounded } from "./tar-parser.js";

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
 * Fetches a published npm tarball from inside the trusted parent worker.
 *
 * The npm token is attached only after the URL is proven to share the
 * configured registry origin, so the credential can never reach a
 * package-controlled host. Bytes are read with a hard size cap but are NOT
 * decompressed here — gunzip/untar of this hostile archive stays inside the
 * credentials-free inline sandbox via {@link downloadPublishedTarball}.
 */
export async function fetchPublishedTarballBytes(
  tarballUrl: string,
  options: PublishedTarballFetchOptions,
): Promise<Uint8Array> {
  const maxBytes = options.maxBytes ?? SANDBOX_MAX_TAR_BYTES;
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
  try {
    return await readStreamBounded(response.body, maxBytes);
  } catch (err) {
    const tooLarge = err instanceof Error && err.message === "archive too large";
    throw new SandboxError(
      JSON.stringify({
        error: tooLarge ? "tarball too large" : "archive download failed",
        status: tooLarge ? 413 : 502,
      }),
    );
  }
}

export interface DownloadPublishedTarballOptions extends PublishedTarballFetchOptions {
  maxFiles?: number;
}

/**
 * Trusted-parent fetch + credentials-free inline parse of a published npm
 * tarball used as the previous-version diff baseline.
 */
export async function downloadPublishedTarball(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  tarballUrl: string,
  options: DownloadPublishedTarballOptions,
): Promise<DownloadResult> {
  const bytes = await fetchPublishedTarballBytes(tarballUrl, options);
  return downloadInSandboxInline(env, ctx, {
    bytes,
    format: "tgz",
    maxFiles: options.maxFiles,
  });
}
