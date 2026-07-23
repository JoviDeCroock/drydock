import type { DownloadResult } from "../../sandbox";
import type { AdapterBroker, AdapterConnectionRef, AdapterContext } from "../types";

const MARKETPLACE_EXTENSION_QUERY =
  "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery?api-version=7.2-preview.1";
const MARKETPLACE_VSIX_ASSET_TYPE = "Microsoft.VisualStudio.Services.VSIXPackage";
const MARKETPLACE_QUERY_FLAGS = 1 | 2 | 128; // IncludeVersions | IncludeFiles | IncludeAssetUri

export interface VscodeMarketplaceVersion {
  version: string;
  lastUpdated: string | null;
  files: VscodeMarketplaceFile[];
}

interface VscodeMarketplaceFile {
  assetType: string | null;
  source: string | null;
}

interface VscodeBrokerDownloadOptions {
  maxFiles?: number;
}

interface VscodePublicArtifactRef {
  url: string;
}

export interface VscodeBroker extends AdapterBroker {
  fetchExtensionVersions(extensionId: string): Promise<VscodeMarketplaceVersion[] | null>;
  downloadPublicArtifact(
    artifact: VscodePublicArtifactRef,
    opts?: VscodeBrokerDownloadOptions,
  ): Promise<DownloadResult>;
}

export function createVscodeBroker(ctx: AdapterContext, _ref: AdapterConnectionRef): VscodeBroker {
  return {
    async fetchExtensionVersions(extensionId: string): Promise<VscodeMarketplaceVersion[] | null> {
      const [publisher, extensionName] = extensionId.split(".");
      if (!publisher || !extensionName) return null;
      try {
        const res = await fetch(MARKETPLACE_EXTENSION_QUERY, {
          method: "POST",
          headers: {
            accept: "application/json;api-version=7.2-preview.1",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            filters: [
              {
                criteria: [{ filterType: 7, value: extensionId }],
              },
            ],
            flags: MARKETPLACE_QUERY_FLAGS,
          }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as unknown;
        const extension = findMarketplaceExtension(data, publisher, extensionName);
        return extension?.versions ?? null;
      } catch {
        return null;
      }
    },

    async downloadPublicArtifact(
      artifact: VscodePublicArtifactRef,
      opts?: VscodeBrokerDownloadOptions,
    ): Promise<DownloadResult> {
      if (!isAllowedVscodeArtifactUrl(artifact.url)) {
        throw new Error("VS Code Marketplace artifact URL is not allowed");
      }
      const { downloadInSandbox } = await import("../../sandbox");
      return downloadInSandbox(ctx.env, ctx.executionCtx, {
        tarballUrl: artifact.url,
        archiveFormat: "vsix",
        publicArtifactUrls: [artifact.url],
        maxFiles: opts?.maxFiles,
      });
    },

    dispose(): void {},
  };
}

export function pickVscodeBaselineVersion(
  versions: VscodeMarketplaceVersion[] | null | undefined,
  candidateVersion: string,
): { version: string; url: string; reason: string } | null {
  const candidateLastUpdatedMs = parseTimestamp(
    (versions ?? []).find((version) => version.version === candidateVersion)?.lastUpdated ?? null,
  );
  const candidates = (versions ?? [])
    .filter((version) => version.version && version.version !== candidateVersion)
    .map((version, index) => ({
      version: version.version,
      url: vscodeVsixAssetUrl(version),
      lastUpdatedMs: parseTimestamp(version.lastUpdated),
      index,
    }))
    .filter((version) => {
      if (candidateLastUpdatedMs <= 0) return true;
      return version.lastUpdatedMs > 0 && version.lastUpdatedMs < candidateLastUpdatedMs;
    })
    .filter((version): version is typeof version & { url: string } => Boolean(version.url));
  if (!candidates.length) return null;

  const byTime = candidates
    .filter((version) => version.lastUpdatedMs > 0)
    .sort((a, b) => b.lastUpdatedMs - a.lastUpdatedMs)[0];
  if (byTime) {
    return {
      version: byTime.version,
      url: byTime.url,
      reason: "newest-marketplace-version",
    };
  }

  const first = candidates.sort((a, b) => a.index - b.index)[0];
  return {
    version: first.version,
    url: first.url,
    reason: "marketplace-version-order",
  };
}

function vscodeVsixAssetUrl(version: VscodeMarketplaceVersion): string | null {
  for (const file of version.files) {
    if (file.assetType !== MARKETPLACE_VSIX_ASSET_TYPE || !file.source) continue;
    return isAllowedVscodeArtifactUrl(file.source) ? file.source : null;
  }
  return null;
}

export function isAllowedVscodeArtifactUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:") return false;
    if (host === "marketplace.visualstudio.com") {
      return parsed.pathname.startsWith("/_apis/public/gallery/");
    }
    return host === "gallerycdn.vsassets.io" || host.endsWith(".gallerycdn.vsassets.io");
  } catch {
    return false;
  }
}

function findMarketplaceExtension(
  value: unknown,
  publisher: string,
  extensionName: string,
): { versions: VscodeMarketplaceVersion[] } | null {
  if (!isRecord(value) || !Array.isArray(value.results)) return null;
  for (const result of value.results) {
    if (!isRecord(result) || !Array.isArray(result.extensions)) continue;
    for (const extension of result.extensions) {
      const parsed = parseMarketplaceExtension(extension);
      if (!parsed) continue;
      if (
        parsed.publisher.toLowerCase() === publisher.toLowerCase() &&
        parsed.extensionName.toLowerCase() === extensionName.toLowerCase()
      ) {
        return { versions: parsed.versions };
      }
    }
  }
  return null;
}

function parseMarketplaceExtension(value: unknown): {
  publisher: string;
  extensionName: string;
  versions: VscodeMarketplaceVersion[];
} | null {
  if (!isRecord(value)) return null;
  const publisherRecord = isRecord(value.publisher) ? value.publisher : {};
  const publisher =
    typeof publisherRecord.publisherName === "string" ? publisherRecord.publisherName : "";
  const extensionName = typeof value.extensionName === "string" ? value.extensionName : "";
  if (!publisher || !extensionName || !Array.isArray(value.versions)) return null;
  return {
    publisher,
    extensionName,
    versions: value.versions.map(parseMarketplaceVersion).filter((version) => version !== null),
  };
}

function parseMarketplaceVersion(value: unknown): VscodeMarketplaceVersion | null {
  if (!isRecord(value)) return null;
  const version = typeof value.version === "string" ? value.version : "";
  if (!version) return null;
  return {
    version,
    lastUpdated: typeof value.lastUpdated === "string" ? value.lastUpdated : null,
    files: Array.isArray(value.files)
      ? value.files.map(parseMarketplaceFile).filter((file) => file !== null)
      : [],
  };
}

function parseMarketplaceFile(value: unknown): VscodeMarketplaceFile | null {
  if (!isRecord(value)) return null;
  return {
    assetType: typeof value.assetType === "string" ? value.assetType : null,
    source: typeof value.source === "string" ? value.source : null,
  };
}

function parseTimestamp(value: string | null): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
