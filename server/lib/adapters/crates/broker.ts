import type { DownloadResult } from "../../sandbox";
import type { AdapterBroker, AdapterConnectionRef, AdapterContext } from "../types";
import type { CratesIndexEntry } from "./types";

export interface CratesBroker extends AdapterBroker {
  fetchIndexEntries(crateName: string): Promise<CratesIndexEntry[] | null>;
  downloadPublicArtifact(url: string): Promise<DownloadResult>;
}

const CRATES_SPARSE_INDEX = "https://index.crates.io";
const CRATES_STATIC_HOST = "static.crates.io";

/** Sparse-index path for a crate: `1/a`, `2/ab`, `3/a/abc`, `ab/cd/abcd…`. */
export function cratesIndexPath(crateName: string): string {
  const name = crateName.toLowerCase();
  if (name.length === 1) return `1/${name}`;
  if (name.length === 2) return `2/${name}`;
  if (name.length === 3) return `3/${name[0]}/${name}`;
  return `${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`;
}

export function cratesStaticArtifactUrl(crateName: string, version: string): string {
  const name = crateName.toLowerCase();
  return `https://${CRATES_STATIC_HOST}/crates/${name}/${name}-${version}.crate`;
}

export function isAllowedCratesArtifactUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === CRATES_STATIC_HOST;
  } catch {
    return false;
  }
}

// crates.io index metadata and published `.crate` archives are public, so like
// the PyPI broker this holds no credential; it exists so the sandbox only ever
// fetches a single pinned static.crates.io URL per download.
export function createCratesBroker(ctx: AdapterContext, _ref: AdapterConnectionRef): CratesBroker {
  return {
    async fetchIndexEntries(crateName: string): Promise<CratesIndexEntry[] | null> {
      try {
        const res = await fetch(`${CRATES_SPARSE_INDEX}/${cratesIndexPath(crateName)}`, {
          headers: { accept: "text/plain" },
        });
        if (!res.ok) return null;
        const body = await res.text();
        const entries: CratesIndexEntry[] = [];
        for (const line of body.split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as CratesIndexEntry;
            if (parsed && typeof parsed === "object") entries.push(parsed);
          } catch {
            // Skip unparseable index lines rather than failing the baseline.
          }
        }
        return entries;
      } catch {
        return null;
      }
    },

    async downloadPublicArtifact(url: string): Promise<DownloadResult> {
      if (!isAllowedCratesArtifactUrl(url)) {
        throw new Error("crates.io public artifact URL is not allowed");
      }
      const { downloadInSandbox } = await import("../../sandbox");
      // No token is passed: the gateway sees only this single pinned URL on its
      // public-artifact allowlist, so it forwards the request uncredentialed.
      return downloadInSandbox(ctx.env, ctx.executionCtx, {
        tarballUrl: url,
        archiveFormat: "tgz",
        publicArtifactUrls: [url],
      });
    },

    dispose(): void {},
  };
}
