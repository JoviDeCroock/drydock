import type { FileRecord, PackageJsonSummary } from "../../review";
import type { TarSuspiciousEntry } from "../../tar-parser.js";
import type { AcquiredArtifact, AdapterContext, BaselineInfo, StagedDetails } from "../types";
import type { RubyGemsBroker } from "./broker";
import { emptyGemspecSummary, parseGemspecMetadata } from "./gemspec";
import { namespacedPath } from "./findings";
import {
  type GemArtifactSummary,
  type RubyGemsAdapterDetails,
  type RubyGemsAdapterInput,
  type RubyGemsArtifactInput,
  type RubyGemsBaselineSelection,
  type RubyGemsBaselineSelectionSource,
  type RubyGemsPreparedArtifact,
  type RubyGemsReleaseManifest,
  type RubyGemsRemoteArtifact,
  type RubyGemsVersion,
} from "./types";

const RUBYGEMS_DOWNLOAD_BASE = "https://rubygems.org/downloads";

export function prepareRubyGemsArtifact(input: RubyGemsArtifactInput): RubyGemsPreparedArtifact {
  const spec = input.gemMetadata ? parseGemspecMetadata(input.gemMetadata) : emptyGemspecSummary();
  const platform = spec.platform || "ruby";
  const summary: GemArtifactSummary = {
    path: input.path,
    platform,
    name: spec.name,
    version: spec.version,
    bindir: spec.bindir,
    executables: spec.executables,
    extensions: spec.extensions,
    requirePaths: spec.requirePaths,
    licenses: spec.licenses,
    requirements: spec.requirements,
    requiredRubyVersion: spec.requiredRubyVersion,
    dependencies: spec.dependencies,
    metadata: spec.metadata,
    hasGemspec: Boolean(input.gemMetadata),
  };
  return { ...input, platform, summary };
}

export function acquireStagedRubyGems(input: RubyGemsAdapterInput): {
  artifact: AcquiredArtifact;
  details: StagedDetails;
} {
  assertManifestArtifactSet(input.manifest, input.artifacts);
  const preparedArtifacts = input.artifacts.map(prepareRubyGemsArtifact);
  const files = flattenRubyGemsArtifactFiles(preparedArtifacts);
  const suspiciousTarEntries = flattenRubyGemsSuspiciousEntries(preparedArtifacts);
  const manifest = packageJsonSummaryFor(input.manifest, preparedArtifacts);
  return {
    artifact: {
      files,
      manifest,
      ...(suspiciousTarEntries.length ? { suspiciousTarEntries } : {}),
    },
    details: {
      manifest: input.manifest,
      artifacts: preparedArtifacts.map((artifact) => artifact.summary),
      preparedArtifacts,
    } satisfies RubyGemsAdapterDetails,
  };
}

export async function acquireBaselineRubyGems(
  ctx: AdapterContext,
  input: RubyGemsAdapterInput,
  broker: RubyGemsBroker,
  staged: { artifact: AcquiredArtifact; details: StagedDetails },
): Promise<{ artifact: AcquiredArtifact | null; baseline: BaselineInfo }> {
  if (input.previousArtifacts?.length) {
    return baselineFromPreviousArtifacts(input);
  }

  const versions = input.versions ?? (await broker.fetchGemVersions(input.manifest.package));
  if (!versions?.length) return emptyRubyGemsBaseline("metadata-unavailable");

  const selection = pickRubyGemsBaselineVersion(versions, input.manifest.version);
  if (!selection.version) {
    return emptyRubyGemsBaseline(selection.reason, { source: selection.source });
  }

  const stagedPlatforms = stagedArtifactPlatforms(staged.details);
  const comparable = selectRubyGemsBaselineArtifacts(
    versions,
    selection.version,
    input.manifest.package,
    stagedPlatforms,
  );
  if (!comparable.length) {
    return emptyRubyGemsBaseline(`${selection.reason}:no-comparable-artifacts`, {
      version: selection.version,
      source: selection.source,
    });
  }

  // Baseline is a best-effort diff aid, not a security control: a rubygems.org
  // outage, a removed gem, or a download/parse error degrades to a full-tree
  // review (every file reads as added — the more conservative outcome) instead
  // of failing the gate, mirroring the npm gate adapter's baseline handling.
  let downloaded: RubyGemsArtifactInput[];
  try {
    downloaded = await Promise.all(
      comparable.map(async (artifact) => {
        const result = await broker.downloadPublicGem(artifact.url);
        return {
          path: artifact.filename,
          files: result.files,
          gemMetadata: result.gemMetadata ?? null,
        };
      }),
    );
  } catch {
    return emptyRubyGemsBaseline(`${selection.reason}:download-failed`, {
      version: selection.version,
      source: selection.source,
    });
  }

  const preparedArtifacts = downloaded.map(prepareRubyGemsArtifact);
  return {
    artifact: {
      files: flattenRubyGemsArtifactFiles(preparedArtifacts),
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

export function baselineFromPreviousArtifacts(input: RubyGemsAdapterInput): {
  artifact: AcquiredArtifact | null;
  baseline: BaselineInfo;
} {
  if (!input.previousArtifacts?.length) return emptyRubyGemsBaseline("no-previous-artifacts");
  const preparedArtifacts = input.previousArtifacts.map(prepareRubyGemsArtifact);
  const manifest = packageJsonSummaryFor(input.manifest, preparedArtifacts);
  return {
    artifact: {
      files: flattenRubyGemsArtifactFiles(preparedArtifacts),
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

function emptyRubyGemsBaseline(
  reason: string,
  opts: { version?: string | null; source?: RubyGemsBaselineSelectionSource } = {},
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

function stagedArtifactPlatforms(details: StagedDetails): Set<string> {
  const d = details as RubyGemsAdapterDetails;
  return new Set(d.preparedArtifacts.map((artifact) => artifact.platform));
}

// Baseline selection runs before any bytes are fetched, so we bound downloads to
// the platforms actually staged (one gem per staged platform); a project with
// many native-platform gems then triggers at most a handful of downloads.
function selectRubyGemsBaselineArtifacts(
  versions: RubyGemsVersion[],
  version: string,
  name: string,
  stagedPlatforms: Set<string>,
): RubyGemsRemoteArtifact[] {
  const seen = new Set<string>();
  const selected: RubyGemsRemoteArtifact[] = [];
  for (const entry of versions) {
    if (entry.number !== version) continue;
    const platform = entry.platform || "ruby";
    if (!stagedPlatforms.has(platform) || seen.has(platform)) continue;
    seen.add(platform);
    const suffix = platform === "ruby" ? "" : `-${platform}`;
    selected.push({
      filename: `${name}-${version}${suffix}.gem`,
      url: `${RUBYGEMS_DOWNLOAD_BASE}/${name}-${version}${suffix}.gem`,
      platform,
      version,
    });
  }
  return selected;
}

export function pickRubyGemsBaselineVersion(
  versions: RubyGemsVersion[],
  candidateVersion: string,
): RubyGemsBaselineSelection {
  // Newest published release that is neither the candidate nor a pre-release.
  const stable = versions.filter(
    (entry) => entry.number && entry.number !== candidateVersion && entry.prerelease !== true,
  );
  const newest = newestByBuildTime(stable);
  if (newest) {
    return { version: newest, source: "latest-published", reason: "newest-stable-release" };
  }

  // Fall back to any other published version (including pre-releases) by build time.
  const others = versions.filter((entry) => entry.number && entry.number !== candidateVersion);
  const fallback = newestByBuildTime(others);
  if (fallback) {
    return { version: fallback, source: "upload-time", reason: "newest-published-release" };
  }

  return { version: null, source: "none", reason: "no-published-baseline" };
}

function newestByBuildTime(entries: RubyGemsVersion[]): string | null {
  let best: { version: string; time: number } | null = null;
  for (const entry of entries) {
    if (!entry.number) continue;
    const time = Date.parse(entry.built_at ?? entry.created_at ?? "");
    const score = Number.isFinite(time) ? time : 0;
    // Prefer the latest timestamp; with no timestamps the first-seen wins, which
    // matches the registry returning newest-first.
    if (!best || score > best.time) best = { version: entry.number, time: score };
  }
  return best?.version ?? null;
}

function flattenRubyGemsArtifactFiles(artifacts: RubyGemsPreparedArtifact[]): FileRecord[] {
  return artifacts.flatMap((artifact) =>
    artifact.files.map((file) => ({
      ...file,
      path: namespacedPath(safeDiffPathPart(artifact.platform), file.path),
    })),
  );
}

function flattenRubyGemsSuspiciousEntries(
  artifacts: RubyGemsPreparedArtifact[],
): TarSuspiciousEntry[] {
  return artifacts.flatMap((artifact) =>
    (artifact.suspiciousEntries ?? []).map((entry) => ({
      ...entry,
      path: namespacedPath(safeDiffPathPart(artifact.platform), entry.path),
    })),
  );
}

function assertManifestArtifactSet(
  manifest: RubyGemsReleaseManifest,
  artifacts: RubyGemsArtifactInput[],
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

function safeDiffPathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_") || "ruby";
}

export function pickPackageIdentity(
  manifest: RubyGemsReleaseManifest,
  artifacts: RubyGemsPreparedArtifact[],
): { name: string | null; version: string | null } {
  const summary = artifacts.find(
    (artifact) => artifact.summary.name && artifact.summary.version,
  )?.summary;
  return {
    name: summary?.name ?? manifest.package ?? null,
    version: summary?.version ?? manifest.version ?? null,
  };
}

function packageJsonSummaryFor(
  manifest: RubyGemsReleaseManifest,
  artifacts: RubyGemsPreparedArtifact[],
): PackageJsonSummary {
  const identity = pickPackageIdentity(manifest, artifacts);
  return {
    name: identity.name ?? undefined,
    version: identity.version ?? undefined,
  };
}
