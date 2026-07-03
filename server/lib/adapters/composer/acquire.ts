import type { FileRecord, PackageJsonSummary } from "../../review";
import type { AcquiredArtifact, AdapterContext, BaselineInfo, StagedDetails } from "../types";
import { isAllowedComposerArtifactUrl, type ComposerBroker } from "./broker";
import { summarizeComposerArtifact } from "./findings";
import { inferComposerArtifactKind } from "./manifest";
import {
  type ComposerAdapterDetails,
  type ComposerAdapterInput,
  type ComposerArtifactInput,
  type ComposerArtifactKind,
  type ComposerBaselineSelection,
  type ComposerBaselineSelectionSource,
  type ComposerPackageMetadata,
  type ComposerPackageRelease,
  type ComposerPreparedArtifact,
  type ComposerReleaseManifest,
  type ComposerRemoteArtifact,
  COMPOSER_UNVERSIONED,
} from "./types";

export function prepareComposerArtifact(input: ComposerArtifactInput): ComposerPreparedArtifact {
  const kind = inferComposerArtifactKind(input.path);
  if (!kind) throw new Error("Composer artifact must be a .zip, .tar.gz, or .tgz archive");
  // `composer archive` output is rootless while git/GitHub archives wrap files
  // in a `<repo>-<ref>/` root; stripping the common root gives both shapes the
  // same paths so the staged-vs-baseline diff stays stable.
  const files = stripCommonArchiveRoot(input.files);
  return {
    path: input.path,
    kind,
    files,
    summary: summarizeComposerArtifact(input.path, files),
    ...(input.suspiciousEntries ? { suspiciousEntries: input.suspiciousEntries } : {}),
  };
}

export function acquireStagedComposer(input: ComposerAdapterInput): {
  artifact: AcquiredArtifact;
  details: StagedDetails;
} {
  assertManifestArtifactSet(input.manifest, input.artifacts);
  const preparedArtifacts = input.artifacts.map(prepareComposerArtifact);
  const files = flattenComposerArtifactFiles(preparedArtifacts);
  const manifest = packageJsonSummaryFor(input.manifest, preparedArtifacts);
  return {
    artifact: { files, manifest },
    details: {
      manifest: input.manifest,
      artifacts: preparedArtifacts.map((artifact) => artifact.summary),
      preparedArtifacts,
    } satisfies ComposerAdapterDetails,
  };
}

export async function acquireBaselineComposer(
  _ctx: AdapterContext,
  input: ComposerAdapterInput,
  broker: ComposerBroker,
): Promise<{ artifact: AcquiredArtifact | null; baseline: BaselineInfo }> {
  if (input.previousArtifacts?.length) {
    return baselineFromPreviousArtifacts(input);
  }

  const metadata = input.metadata ?? (await broker.fetchPackageMetadata(input.manifest.package));
  if (!metadata) return emptyComposerBaseline("metadata-unavailable");

  const selection = pickComposerBaselineRelease(metadata, input.manifest);
  if (!selection.version) {
    return emptyComposerBaseline(selection.reason, { source: selection.source });
  }

  const remote = selectComposerReleaseArtifact(metadata, input.manifest.package, selection.version);
  if (!remote || !isAllowedComposerArtifactUrl(remote.url)) {
    return emptyComposerBaseline(`${selection.reason}:no-comparable-artifacts`, {
      version: selection.version,
      source: selection.source,
    });
  }

  const result = await broker.downloadPublicArtifact({ url: remote.url, kind: remote.kind });
  const preparedArtifacts = [
    prepareComposerArtifact({
      path: `baseline-${safePathPart(selection.version)}.${remote.kind === "zip" ? "zip" : "tar.gz"}`,
      files: result.files,
    }),
  ];
  return {
    artifact: {
      files: flattenComposerArtifactFiles(preparedArtifacts),
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

export function baselineFromPreviousArtifacts(input: ComposerAdapterInput): {
  artifact: AcquiredArtifact | null;
  baseline: BaselineInfo;
} {
  if (!input.previousArtifacts?.length) return emptyComposerBaseline("no-previous-artifacts");
  const preparedArtifacts = input.previousArtifacts.map(prepareComposerArtifact);
  const manifest = packageJsonSummaryFor(input.manifest, preparedArtifacts);
  return {
    artifact: {
      files: flattenComposerArtifactFiles(preparedArtifacts),
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

function emptyComposerBaseline(
  reason: string,
  opts: { version?: string | null; source?: ComposerBaselineSelectionSource } = {},
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

// Packagist p2 metadata lists tagged releases newest-first with per-release
// `time`; the baseline is the newest published release that is not the
// candidate version itself and has a downloadable dist.
export function pickComposerBaselineRelease(
  metadata: ComposerPackageMetadata,
  manifest: ComposerReleaseManifest,
): ComposerBaselineSelection {
  const releases = usableReleases(metadata, manifest.package).filter(
    (release) =>
      manifest.version === COMPOSER_UNVERSIONED ||
      !versionMatchesCandidate(release, manifest.version),
  );
  if (!releases.length) {
    return { version: null, source: "none", reason: "no-published-baseline" };
  }

  const byTime = releases
    .map((release) => ({ release, publishedAt: Date.parse(release.time ?? "") }))
    .filter((entry) => Number.isFinite(entry.publishedAt))
    .sort((a, b) => a.publishedAt - b.publishedAt)
    .at(-1);
  if (byTime) {
    return {
      version: byTime.release.version ?? null,
      source: "upload-time",
      reason: "newest-published-release",
    };
  }

  // No usable timestamps: p2 metadata orders releases newest-first.
  return {
    version: releases[0].version ?? null,
    source: "latest-published",
    reason: "metadata-order-newest-release",
  };
}

export function selectComposerReleaseArtifact(
  metadata: ComposerPackageMetadata,
  packageName: string,
  version: string,
): ComposerRemoteArtifact | null {
  const release = usableReleases(metadata, packageName).find(
    (candidate) => candidate.version === version,
  );
  const dist = release?.dist;
  if (!release?.version || !dist?.url) return null;
  const kind = composerDistKind(dist.type);
  if (!kind) return null;
  return {
    version: release.version,
    url: dist.url,
    kind,
    sha1: typeof dist.shasum === "string" && dist.shasum ? dist.shasum : null,
  };
}

function usableReleases(
  metadata: ComposerPackageMetadata,
  packageName: string,
): ComposerPackageRelease[] {
  const releases = metadata.packages?.[packageName];
  if (!Array.isArray(releases)) return [];
  return releases.filter(
    (release) => typeof release?.version === "string" && Boolean(release.dist?.url),
  );
}

function composerDistKind(type: string | undefined): ComposerArtifactKind | null {
  if (type === "zip") return "zip";
  if (type === "tar") return "tar";
  return null;
}

function versionMatchesCandidate(release: ComposerPackageRelease, candidate: string): boolean {
  const normalizedCandidate = candidate.replace(/^v/i, "");
  return (
    release.version?.replace(/^v/i, "") === normalizedCandidate ||
    release.version_normalized === candidate
  );
}

// A Composer release is a single archive, so the staged and baseline file sets
// diff directly on the (root-stripped) archive paths without namespacing.
function flattenComposerArtifactFiles(artifacts: ComposerPreparedArtifact[]): FileRecord[] {
  return artifacts.flatMap((artifact) => artifact.files);
}

function assertManifestArtifactSet(
  manifest: ComposerReleaseManifest,
  artifacts: ComposerArtifactInput[],
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
  manifest: ComposerReleaseManifest,
  artifacts: ComposerPreparedArtifact[],
) {
  const summary = artifacts.find((artifact) => artifact.summary.name)?.summary;
  const version = summary?.version ?? manifest.version;
  return {
    name: summary?.name ?? manifest.package ?? null,
    version: version === COMPOSER_UNVERSIONED ? null : version,
  };
}

function packageJsonSummaryFor(
  manifest: ComposerReleaseManifest,
  artifacts: ComposerPreparedArtifact[],
): PackageJsonSummary {
  const identity = pickPackageIdentity(manifest, artifacts);
  return {
    name: identity.name ?? undefined,
    version: identity.version ?? undefined,
  };
}

function stripCommonArchiveRoot(files: FileRecord[]): FileRecord[] {
  const pathParts = files.map((file) => file.path.split("/"));
  if (!pathParts.length || pathParts.some((parts) => parts.length < 2)) return files;
  const root = pathParts[0][0];
  if (!root || pathParts.some((parts) => parts[0] !== root)) return files;
  return files.map((file) => ({
    ...file,
    path: file.path.split("/").slice(1).join("/"),
  }));
}

function safePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_") || "unknown";
}
