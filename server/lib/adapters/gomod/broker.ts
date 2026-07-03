import type { DownloadResult } from "../../sandbox";
import type { AdapterBroker, AdapterConnectionRef, AdapterContext } from "../types";

export interface GoBroker extends AdapterBroker {
  fetchVersionList(modulePath: string): Promise<string[] | null>;
  downloadPublicArtifact(url: string): Promise<DownloadResult>;
}

const GO_PROXY_HOST = "proxy.golang.org";

/**
 * Case-encode a module path for proxy URLs: uppercase letters become
 * `!lowercase` (module paths are case-sensitive but proxy paths are not).
 */
export function escapeGoModulePath(modulePath: string): string {
  return modulePath.replace(/[A-Z]/g, (char) => `!${char.toLowerCase()}`);
}

export function goProxyZipUrl(modulePath: string, version: string): string {
  return `https://${GO_PROXY_HOST}/${escapeGoModulePath(modulePath)}/@v/${encodeURIComponent(version)}.zip`;
}

export function isAllowedGoProxyArtifactUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === GO_PROXY_HOST;
  } catch {
    return false;
  }
}

// proxy.golang.org is a public, credential-free module proxy (checksums are
// independently verifiable via sum.golang.org). Like the PyPI broker this is a
// plain object; the sandbox only ever fetches a single pinned proxy URL.
export function createGoBroker(ctx: AdapterContext, _ref: AdapterConnectionRef): GoBroker {
  return {
    async fetchVersionList(modulePath: string): Promise<string[] | null> {
      try {
        const res = await fetch(
          `https://${GO_PROXY_HOST}/${escapeGoModulePath(modulePath)}/@v/list`,
          { headers: { accept: "text/plain" } },
        );
        if (!res.ok) return null;
        const body = await res.text();
        return body
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
      } catch {
        return null;
      }
    },

    async downloadPublicArtifact(url: string): Promise<DownloadResult> {
      if (!isAllowedGoProxyArtifactUrl(url)) {
        throw new Error("Go module proxy artifact URL is not allowed");
      }
      const { downloadInSandbox } = await import("../../sandbox");
      // No token is passed: the gateway sees only this single pinned URL on its
      // public-artifact allowlist, so it forwards the request uncredentialed.
      return downloadInSandbox(ctx.env, ctx.executionCtx, {
        tarballUrl: url,
        archiveFormat: "zip",
        publicArtifactUrls: [url],
      });
    },

    dispose(): void {},
  };
}
