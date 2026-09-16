import { readBoundedJson } from "../../platform/bounded-body";
import { reliableFetch } from "../../platform/reliable-fetch";
import type { DownloadResult } from "../../sandbox";
import type { AdapterBroker, AdapterConnectionRef, AdapterContext } from "../package-adapter";
import type { PyPiArtifactKind, PyPiProjectMetadata } from "./types";

interface PyPiBrokerDownloadOptions {
  maxFiles?: number;
  /** See `DownloadOptions.maxTextSampleChars` in `lib/sandbox.ts`. */
  maxTextSampleChars?: number;
}

interface PyPiPublicArtifactRef {
  url: string;
  kind: PyPiArtifactKind;
}

// The only origin PyPI serves artifacts from; anything else is not PyPI.
export function isAllowedPyPiArtifactUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "files.pythonhosted.org";
  } catch {
    return false;
  }
}

export interface PyPiBroker extends AdapterBroker {
  fetchProjectMetadata(projectName: string): Promise<PyPiProjectMetadata | null>;
  downloadPublicArtifact(
    artifact: PyPiPublicArtifactRef,
    opts?: PyPiBrokerDownloadOptions,
  ): Promise<DownloadResult>;
}

const PYPI_METADATA_REGISTRY = "https://pypi.org/pypi";
const PYPI_METADATA_TIMEOUT_MS = 15_000;
// The JSON API lists every release with every file; large projects (numpy,
// tensorflow) run to a few MiB, so the cap is generous but still a cap.
const MAX_PYPI_METADATA_BYTES = 16 * 1024 * 1024;

// PyPI public artifacts carry no credentials, so unlike the npm broker this is a
// plain object rather than a WorkerEntrypoint. The sandbox download path is
// pulled in dynamically so node-env logic tests can import this module without
// loading `cloudflare:workers`.
export function createPyPiBroker(ctx: AdapterContext, _ref: AdapterConnectionRef): PyPiBroker {
  return {
    async fetchProjectMetadata(projectName: string): Promise<PyPiProjectMetadata | null> {
      try {
        const res = await reliableFetch(
          `${PYPI_METADATA_REGISTRY}/${encodeURIComponent(projectName)}/json`,
          { headers: { accept: "application/json" }, timeoutMs: PYPI_METADATA_TIMEOUT_MS },
        );
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          return null;
        }
        // Budget the body read from when headers arrived, not from before
        // reliableFetch started: a retried request must not inherit a deadline
        // the first attempt already spent.
        const deadlineMs = Date.now() + PYPI_METADATA_TIMEOUT_MS;
        return await readBoundedJson<PyPiProjectMetadata>(res, {
          maxBytes: MAX_PYPI_METADATA_BYTES,
          deadlineMs,
        });
      } catch {
        return null;
      }
    },

    async downloadPublicArtifact(
      artifact: PyPiPublicArtifactRef,
      opts?: PyPiBrokerDownloadOptions,
    ): Promise<DownloadResult> {
      if (!isAllowedPyPiArtifactUrl(artifact.url)) {
        throw new Error("PyPI public artifact URL is not allowed");
      }
      const { downloadInSandbox } = await import("../../sandbox");
      // No npm token is passed: the gateway sees only this single pinned URL on
      // its public-artifact allowlist, so it forwards the request uncredentialed.
      return downloadInSandbox(ctx.env, ctx.executionCtx, {
        tarballUrl: artifact.url,
        archiveFormat: artifact.kind === "wheel" ? "zip" : "tgz",
        publicArtifactUrls: [artifact.url],
        maxFiles: opts?.maxFiles,
        maxTextSampleChars: opts?.maxTextSampleChars,
        // pip keeps the sdist's `<name>-<version>/` root; `preparePyPiArtifact`
        // strips the common root afterwards and treats entries outside it as
        // evidence, so the parse must not strip anything itself.
        tarRootStrip: "keep",
      });
    },

    dispose(): void {},
  };
}
