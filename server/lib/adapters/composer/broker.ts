import type { DownloadResult } from "../../sandbox";
import type { AdapterBroker, AdapterConnectionRef, AdapterContext } from "../types";
import type { ComposerArtifactKind, ComposerPackageMetadata } from "./types";

export interface ComposerBrokerDownloadOptions {
  maxFiles?: number;
}

export interface ComposerPublicArtifactRef {
  url: string;
  kind: ComposerArtifactKind;
}

export interface ComposerBroker extends AdapterBroker {
  fetchPackageMetadata(packageName: string): Promise<ComposerPackageMetadata | null>;
  downloadPublicArtifact(
    artifact: ComposerPublicArtifactRef,
    opts?: ComposerBrokerDownloadOptions,
  ): Promise<DownloadResult>;
}

const PACKAGIST_METADATA_BASE = "https://repo.packagist.org/p2";

// Packagist metadata points dist archives at the package's VCS host, not at a
// Packagist-owned CDN, so the credential-free download path is pinned to the
// hosts Packagist actually references for public packages.
const ALLOWED_COMPOSER_DIST_HOSTS = new Set([
  "api.github.com",
  "codeload.github.com",
  "gitlab.com",
  "bitbucket.org",
]);

export function isAllowedComposerArtifactUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ALLOWED_COMPOSER_DIST_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

// Packagist public artifacts carry no credentials, so like the PyPI broker this
// is a plain object rather than a WorkerEntrypoint. The sandbox download path is
// pulled in dynamically so node-env logic tests can import this module without
// loading `cloudflare:workers`.
export function createComposerBroker(
  ctx: AdapterContext,
  _ref: AdapterConnectionRef,
): ComposerBroker {
  return {
    async fetchPackageMetadata(packageName: string): Promise<ComposerPackageMetadata | null> {
      const [vendor, name] = packageName.split("/");
      if (!vendor || !name) return null;
      try {
        const res = await fetch(
          `${PACKAGIST_METADATA_BASE}/${encodeURIComponent(vendor)}/${encodeURIComponent(name)}.json`,
          { headers: { accept: "application/json" } },
        );
        if (!res.ok) return null;
        return (await res.json()) as ComposerPackageMetadata;
      } catch {
        return null;
      }
    },

    async downloadPublicArtifact(
      artifact: ComposerPublicArtifactRef,
      opts?: ComposerBrokerDownloadOptions,
    ): Promise<DownloadResult> {
      // GitHub's `zipball` API URLs 302 to codeload; the sandbox gateway pins a
      // single exact URL, so redirects are resolved here first (every hop is
      // validated against the same host allowlist) and the sandbox downloads
      // the final pinned URL directly.
      const url = await resolveComposerDistUrl(artifact.url);
      const { downloadInSandbox } = await import("../../sandbox");
      // No token is passed: the gateway sees only this single pinned URL on its
      // public-artifact allowlist, so it forwards the request uncredentialed.
      return downloadInSandbox(ctx.env, ctx.executionCtx, {
        tarballUrl: url,
        archiveFormat: artifact.kind === "zip" ? "zip" : "tgz",
        publicArtifactUrls: [url],
        maxFiles: opts?.maxFiles,
      });
    },

    dispose(): void {},
  };
}

const MAX_DIST_REDIRECTS = 4;

// Follow dist-URL redirects in the trusted parent (no credentials attach here),
// fail-closing on any hop that leaves the public dist host allowlist, and
// return the final URL for the sandbox's exact-match gateway pin.
async function resolveComposerDistUrl(url: string): Promise<string> {
  let current = url;
  for (let hop = 0; hop <= MAX_DIST_REDIRECTS; hop += 1) {
    if (!isAllowedComposerArtifactUrl(current)) {
      throw new Error("Composer public artifact URL is not allowed");
    }
    const res = await fetch(current, {
      method: "HEAD",
      redirect: "manual",
      headers: { accept: "application/octet-stream" },
    });
    await res.body?.cancel();
    if (res.status < 300 || res.status >= 400) return current;
    const location = res.headers.get("location");
    if (!location) return current;
    current = new URL(location, current).toString();
  }
  throw new Error("Composer public artifact URL has too many redirects");
}
