import type { DownloadResult } from "../../sandbox";
import type { AdapterBroker, AdapterConnectionRef, AdapterContext } from "../types";
import type { PyPiArtifactKind, PyPiProjectMetadata } from "./index";

export interface PyPiBrokerDownloadOptions {
  maxFiles?: number;
  maxBytesPerFile?: number;
}

export interface PyPiPublicArtifactRef {
  url: string;
  kind: PyPiArtifactKind;
}

export interface PyPiBroker extends AdapterBroker {
  fetchProjectMetadata(projectName: string): Promise<PyPiProjectMetadata | null>;
  downloadPublicArtifact(
    artifact: PyPiPublicArtifactRef,
    opts?: PyPiBrokerDownloadOptions,
  ): Promise<DownloadResult>;
}

const PYPI_METADATA_REGISTRY = "https://pypi.org/pypi";

// PyPI public artifacts carry no credentials, so unlike the npm broker this is a
// plain object rather than a WorkerEntrypoint. The sandbox download path is
// pulled in dynamically so node-env logic tests can import this module without
// loading `cloudflare:workers`.
export function createPyPiBroker(ctx: AdapterContext, _ref: AdapterConnectionRef): PyPiBroker {
  return {
    async fetchProjectMetadata(projectName: string): Promise<PyPiProjectMetadata | null> {
      try {
        const res = await fetch(
          `${PYPI_METADATA_REGISTRY}/${encodeURIComponent(projectName)}/json`,
          { headers: { accept: "application/json" } },
        );
        if (!res.ok) return null;
        return (await res.json()) as PyPiProjectMetadata;
      } catch {
        return null;
      }
    },

    async downloadPublicArtifact(
      artifact: PyPiPublicArtifactRef,
      opts?: PyPiBrokerDownloadOptions,
    ): Promise<DownloadResult> {
      const { downloadInSandbox } = await import("../../sandbox");
      // No npm token is passed: the gateway sees only this single pinned URL on
      // its public-artifact allowlist, so it forwards the request uncredentialed.
      return downloadInSandbox(ctx.env, ctx.executionCtx, {
        tarballUrl: artifact.url,
        archiveFormat: artifact.kind === "wheel" ? "zip" : "tgz",
        publicArtifactUrls: [artifact.url],
        maxFiles: opts?.maxFiles,
        maxBytesPerFile: opts?.maxBytesPerFile,
      });
    },

    dispose(): void {},
  };
}
