import type { FileRecord, PackageJsonSummary } from "../../review";
import type { AcquiredArtifact, AdapterContext, BaselineInfo, StagedDetails } from "../types";
import type { RubygemsBroker } from "./broker";
import { rubygemsDiffNamespace, namespacedPath, summarizeRubygemsArtifact } from "./findings";
import { inferRubygemsArtifactKind } from "./manifest";
import {
  type RubygemsAdapterDetails,
  type RubygemsAdapterInput,
  type RubygemsArtifactInput,
  type RubygemsBaselineSelection,
  type RubygemsBaselineSelectionSource,
  type RubygemsPreparedArtifact,
  type RubygemsReleaseManifest,
  type RubygemsRemoteArtifact,
  type RubygemsVersionInfo,
  SHA256_RE,
} from "./types";

export function prepareRubygemsArtifact(input: RubygemsArtifactInput): RubygemsPreparedArtifact {
  const kind = inferRubygemsArtifactKind(input.path);
  if (!kind) throw new Error("RubyGems artifact must be a .gem archive");
  return {
    path: input.path,
    kind,
    files: input.files,
    summary: summarizeRubygemsArtifact(input.path, kind, input.files),
    ...(input.suspiciousEntries ? { suspiciousEntries: input.suspiciousEntries } : {}),
  };
}

export function acquireStagedRubygems(input: RubygemsAdapterInput): {
  artifact: AcquiredArtifact;
  details: StagedDetails;
} {
  assertManifestArtifactSet(input.manifest, input.artifacts);
  const preparedArtifacts = input.artifacts.map(prepareRubygemsArtifact);
  const files = flattenRubygemsArtifactFiles(preparedArtifacts);
  const manifest = packageJsonSummaryFor(input.manifest, preparedArtifacts);
  return {
    artifact: { files, manifest },
    details: {
      manifest: input.manifest,
      artifacts: preparedArtifacts.map((artifact) => artifact.summary),
      preparedArtifacts,
    } satisfies RubygemsAdapterDetails,
  };
}

export async function acquireBaselineRubygems(
  ctx: AdapterContext,
  input: RubygemsAdapterInput,
  broker: RubygemsBroker,
  staged: { artifact: AcquiredArtifact; details: StagedDetails },
): Promise<{ artifact: AcquiredArtifact | null; baseline: BaselineInfo }> {
  if (input.previousArtifacts?.length) {
    return baselineFromPreviousArtifacts(input);
  }

  const versions = input.metadata ?? (await broker.fetchGemVersions(input.manifest.package));
  if (!versions) return emptyRubygemsBaseline("metadata-unavailable");

  const selection = pickRubygemsBaselineRelease(versions, input.manifest.version);
  if (!selection.version) {
    return emptyRubygemsBaseline(selection.reason, { source: selection.source });
  }

  const stagedNamespaces = stagedArtifactNamespaces(staged.details);
  const comparable = selectRubygemsReleaseArtifacts(
    versions,
    input.manifest.package,
    selection.version,
  ).filter(
    (artifact) =>
      isAllowedRubygemsArtifactUrl(artifact.url) &&
      stagedNamespaces.has(rubygemsDiffNamespace(artifact.platform)),
  );
  if (!comparable.length) {
    return emptyRubygemsBaseline(`${selection.reason}:no-comparable-artifacts`, {
      version: selection.version,
      source: selection.source,
    });
  }

  const downloaded: RubygemsArtifactInput[] = await Promise.all(
    comparable.map(async (artifact) => {
      const result = await broker.downloadPublicArtifact({ url: artifact.url });
      return {
        path: artifact.filename,
        files: result.files,
        ...(result.suspiciousEntries ? { suspiciousEntries: result.suspiciousEntries } : {}),
      };
    }),
  );

  const preparedArtifacts = downloaded.map(prepareRubygemsArtifact);
  return {
    artifact: {
      files: flattenRubygemsArtifactFiles(preparedArtifacts),
      manifest: packageJsonSummaryFor(input.manifest, preparedArtifacts),
    },
    baseline: {
      version: selection.version,
      tag: null,
      source: selection.source,
      distTagVersion: null,
      reason: selection.reason,
    },
  };
}

export function baselineFromPreviousArtifacts(input: RubygemsAdapterInput): {
  artifact: AcquiredArtifact | null;
  baseline: BaselineInfo;
} {
  if (!input.previousArtifacts?.length) return emptyRubygemsBaseline("no-previous-artifacts");
  const preparedArtifacts = input.previousArtifacts.map(prepareRubygemsArtifact);
  const manifest = packageJsonSummaryFor(input.manifest, preparedArtifacts);
  return {
    artifact: {
      files: flattenRubygemsArtifactFiles(preparedArtifacts),
      manifest,
    },
    baseline: {
      version: manifest.version ?? null,
      tag: null,
      source: "latest-published",
      distTagVersion: null,
      reason: "provided-previous-artifacts",
    },
  };
}

function emptyRubygemsBaseline(
  reason: string,
  opts: { version?: string | null; source?: RubygemsBaselineSelectionSource } = {},
): { artifact: null; baseline: BaselineInfo } {
  return {
    artifact: null,
    baseline: {
      version: opts.version ?? null,
      tag: null,
      source: opts.source ?? "none",
      distTagVersion: null,
      reason,
    },
  };
}

// Download selection runs before any bytes are fetched, so it keys off the
// versions-listing platform. Both the staged artifact platforms (from parsed
// gemspecs) and candidate baseline platforms reduce to the same diff namespace,
// which bounds downloads to the platform shapes that are actually staged.
function stagedArtifactNamespaces(details: StagedDetails): Set<string> {
  const d = details as RubygemsAdapterDetails;
  return new Set(
    d.preparedArtifacts.map((artifact) => rubygemsDiffNamespace(artifact.summary.platform)),
  );
}

/**
 * Pick the baseline version from the RubyGems.org versions listing
 * (`/api/v1/versions/{gem}.json`, yanked versions excluded by the API).
 * Prefers the newest stable release that is not the candidate itself; falls
 * back to the newest prerelease when the gem has only prereleases.
 */
export function pickRubygemsBaselineRelease(
  versions: RubygemsVersionInfo[],
  candidateVersion: string,
): RubygemsBaselineSelection {
  const usable = versions
    .filter((entry) => entry.number && entry.number !== candidateVersion)
    .map((entry) => ({
      version: entry.number as string,
      prerelease: entry.prerelease === true,
      createdAt: Date.parse(entry.created_at ?? ""),
    }))
    .filter((entry) => Number.isFinite(entry.createdAt));

  const newest = (entries: typeof usable) =>
    entries
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .at(-1);

  const stable = newest(usable.filter((entry) => !entry.prerelease));
  if (stable) {
    return {
      version: stable.version,
      source: "latest-published",
      reason: "newest-stable-release",
    };
  }
  const prerelease = newest(usable);
  if (prerelease) {
    return {
      version: prerelease.version,
      source: "upload-time",
      reason: "newest-prerelease",
    };
  }
  return {
    version: null,
    source: "none",
    reason: "no-published-baseline",
  };
}

export function selectRubygemsReleaseArtifacts(
  versions: RubygemsVersionInfo[],
  gemName: string,
  version: string,
): RubygemsRemoteArtifact[] {
  return versions
    .filter((entry) => entry.number === version)
    .map((entry) => {
      const platform = entry.platform && entry.platform !== "ruby" ? entry.platform : "ruby";
      const filename =
        platform === "ruby" ? `${gemName}-${version}.gem` : `${gemName}-${version}-${platform}.gem`;
      const sha = typeof entry.sha === "string" && SHA256_RE.test(entry.sha) ? entry.sha : null;
      return {
        filename,
        url: `https://rubygems.org/gems/${filename}`,
        sha256: sha ? sha.toLowerCase() : null,
        platform,
        kind: "gem" as const,
      };
    });
}

export function isAllowedRubygemsArtifactUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "rubygems.org" &&
      parsed.pathname.startsWith("/gems/") &&
      parsed.pathname.endsWith(".gem")
    );
  } catch {
    return false;
  }
}

function flattenRubygemsArtifactFiles(artifacts: RubygemsPreparedArtifact[]): FileRecord[] {
  return artifacts.flatMap((artifact) =>
    artifact.files.map((file) => ({
      ...file,
      path: namespacedPath(rubygemsDiffNamespace(artifact.summary.platform), file.path),
    })),
  );
}

function assertManifestArtifactSet(
  manifest: RubygemsReleaseManifest,
  artifacts: RubygemsArtifactInput[],
): void {
  const manifestPaths = sortedUnique(manifest.artifacts.map((artifact) => artifact.path));
  const artifactPaths = sortedUnique(artifacts.map((artifact) => artifact.path));
  if (
    manifestPaths.length !== manifest.artifacts.length ||
    artifactPaths.length !== artifacts.length ||
    manifestPaths.length !== artifactPaths.length ||
    manifestPaths.some((path, index) => path !== artifactPaths[index])
  ) {
    throw new Error("review artifacts must exactly match manifest artifacts");
  }
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function pickPackageIdentity(
  manifest: RubygemsReleaseManifest,
  artifacts: RubygemsPreparedArtifact[],
) {
  const summary = artifacts.find(
    (artifact) => artifact.summary.name && artifact.summary.version,
  )?.summary;
  return {
    name: summary?.name ?? manifest.package ?? null,
    version: summary?.version ?? manifest.version ?? null,
  };
}

function packageJsonSummaryFor(
  manifest: RubygemsReleaseManifest,
  artifacts: RubygemsPreparedArtifact[],
): PackageJsonSummary {
  const identity = pickPackageIdentity(manifest, artifacts);
  return {
    name: identity.name ?? undefined,
    version: identity.version ?? undefined,
  };
}
