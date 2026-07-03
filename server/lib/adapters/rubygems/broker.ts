import type { DownloadResult } from "../../sandbox";
import type { AdapterBroker, AdapterConnectionRef, AdapterContext } from "../types";
import type { RubyGemsVersion } from "./types";

export interface RubyGemsBrokerDownloadOptions {
  maxFiles?: number;
}

export interface RubyGemsBroker extends AdapterBroker {
  fetchGemVersions(gemName: string): Promise<RubyGemsVersion[] | null>;
  downloadPublicGem(url: string, opts?: RubyGemsBrokerDownloadOptions): Promise<DownloadResult>;
}

const RUBYGEMS_API = "https://rubygems.org/api/v1";

export function isAllowedRubyGemsArtifactUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "rubygems.org" &&
      parsed.pathname.startsWith("/downloads/")
    );
  } catch {
    return false;
  }
}

// rubygems.org gem downloads carry no credentials, so — like the PyPI broker —
// this is a plain object rather than a credentialed WorkerEntrypoint, and the
// sandbox download path is imported dynamically so node-env logic tests can load
// this module without pulling in `cloudflare:workers`.
export function createRubyGemsBroker(
  ctx: AdapterContext,
  _ref: AdapterConnectionRef,
): RubyGemsBroker {
  return {
    async fetchGemVersions(gemName: string): Promise<RubyGemsVersion[] | null> {
      try {
        const res = await fetch(`${RUBYGEMS_API}/versions/${encodeURIComponent(gemName)}.json`, {
          headers: { accept: "application/json" },
        });
        if (!res.ok) return null;
        const body = (await res.json()) as unknown;
        return Array.isArray(body) ? (body as RubyGemsVersion[]) : null;
      } catch {
        return null;
      }
    },

    async downloadPublicGem(
      url: string,
      opts?: RubyGemsBrokerDownloadOptions,
    ): Promise<DownloadResult> {
      if (!isAllowedRubyGemsArtifactUrl(url)) {
        throw new Error("rubygems public artifact URL is not allowed");
      }
      const { downloadInSandbox } = await import("../../sandbox");
      // No npm token is passed: the gateway sees only this single pinned URL on
      // its public-artifact allowlist, so it forwards the request uncredentialed.
      return downloadInSandbox(ctx.env, ctx.executionCtx, {
        tarballUrl: url,
        archiveFormat: "gem",
        publicArtifactUrls: [url],
        maxFiles: opts?.maxFiles,
      });
    },

    dispose(): void {},
  };
}
