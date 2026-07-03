import type { DownloadResult } from "../../sandbox";
import type { AdapterBroker, AdapterConnectionRef, AdapterContext } from "../types";
import { isAllowedRubygemsArtifactUrl } from "./acquire";
import type { RubygemsVersionInfo } from "./types";

export interface RubygemsBrokerDownloadOptions {
  maxFiles?: number;
}

export interface RubygemsPublicArtifactRef {
  url: string;
}

export interface RubygemsBroker extends AdapterBroker {
  fetchGemVersions(gemName: string): Promise<RubygemsVersionInfo[] | null>;
  downloadPublicArtifact(
    artifact: RubygemsPublicArtifactRef,
    opts?: RubygemsBrokerDownloadOptions,
  ): Promise<DownloadResult>;
}

const RUBYGEMS_VERSIONS_API = "https://rubygems.org/api/v1/versions";

// RubyGems public artifacts carry no credentials, so like the PyPI broker this
// is a plain object rather than a WorkerEntrypoint. The sandbox download path
// is pulled in dynamically so node-env logic tests can import this module
// without loading `cloudflare:workers`. The publish credential never enters
// Drydock: publishing stays in GitHub Actions via RubyGems Trusted Publishing.
export function createRubygemsBroker(
  ctx: AdapterContext,
  _ref: AdapterConnectionRef,
): RubygemsBroker {
  return {
    async fetchGemVersions(gemName: string): Promise<RubygemsVersionInfo[] | null> {
      try {
        const res = await fetch(`${RUBYGEMS_VERSIONS_API}/${encodeURIComponent(gemName)}.json`, {
          headers: { accept: "application/json" },
        });
        if (!res.ok) return null;
        const parsed = (await res.json()) as unknown;
        return Array.isArray(parsed) ? (parsed as RubygemsVersionInfo[]) : null;
      } catch {
        return null;
      }
    },

    async downloadPublicArtifact(
      artifact: RubygemsPublicArtifactRef,
      opts?: RubygemsBrokerDownloadOptions,
    ): Promise<DownloadResult> {
      if (!isAllowedRubygemsArtifactUrl(artifact.url)) {
        throw new Error("RubyGems public artifact URL is not allowed");
      }
      const { downloadInSandbox } = await import("../../sandbox");
      // No token is passed: the gateway sees only this single pinned URL on
      // its public-artifact allowlist, so it forwards the request uncredentialed.
      return downloadInSandbox(ctx.env, ctx.executionCtx, {
        tarballUrl: artifact.url,
        archiveFormat: "gem",
        publicArtifactUrls: [artifact.url],
        maxFiles: opts?.maxFiles,
      });
    },

    dispose(): void {},
  };
}
