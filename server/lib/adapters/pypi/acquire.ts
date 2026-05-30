import type { FileRecord, PackageJsonSummary } from "../../review";
import type { AcquiredArtifact, AdapterContext, BaselineInfo, StagedDetails } from "../types";
import type { PyPiBroker } from "./broker";
import { summarizePyPiArtifact, namespacedPath } from "./findings";
import { inferPyPiArtifactKind } from "./manifest";
import {
  type PyPiAdapterDetails,
  type PyPiAdapterInput,
  type PyPiArtifactInput,
  type PyPiArtifactKind,
  type PyPiBaselineSelection,
  type PyPiBaselineSelectionSource,
  type PyPiPreparedArtifact,
  type PyPiProjectMetadata,
  type PyPiReleaseFile,
  type PyPiReleaseManifest,
  type PyPiRemoteArtifact,
} from "./types";

export function preparePyPiArtifact(input: PyPiArtifactInput): PyPiPreparedArtifact {
  const kind = inferPyPiArtifactKind(input.path);
  if (!kind) throw new Error("PyPI artifact must be a wheel or sdist");
  const files = kind === "sdist" ? stripCommonArchiveRoot(input.files) : input.files;
  return {
    path: input.path,
    kind,
    files,
    summary: summarizePyPiArtifact(input.path, kind, files),
  };
}

export function acquireStagedPyPi(input: PyPiAdapterInput): {
  artifact: AcquiredArtifact;
  details: StagedDetails;
} {
  assertManifestArtifactSet(input.manifest, input.artifacts);
  const preparedArtifacts = input.artifacts.map(preparePyPiArtifact);
  const files = flattenPyPiArtifactFiles(preparedArtifacts);
  const manifest = packageJsonSummaryFor(input.manifest, preparedArtifacts);
  return {
    artifact: { files, manifest },
    details: {
      manifest: input.manifest,
      artifacts: preparedArtifacts.map((artifact) => artifact.summary),
      preparedArtifacts,
    } satisfies PyPiAdapterDetails,
  };
}

export async function acquireBaselinePyPi(
  ctx: AdapterContext,
  input: PyPiAdapterInput,
  broker: PyPiBroker,
  staged: { artifact: AcquiredArtifact; details: StagedDetails },
): Promise<{ artifact: AcquiredArtifact | null; baseline: BaselineInfo }> {
  if (input.previousArtifacts?.length) {
    return baselineFromPreviousArtifacts(input);
  }

  const metadata = input.metadata ?? (await broker.fetchProjectMetadata(input.manifest.package));
  if (!metadata) return emptyPyPiBaseline("metadata-unavailable");

  const selection = pickPyPiBaselineRelease(metadata, input.manifest.version);
  if (!selection.version) {
    return emptyPyPiBaseline(selection.reason, { source: selection.source });
  }

  const stagedNamespaces = stagedArtifactNamespaces(staged.details);
  const comparable = selectComparableBaselineArtifacts(
    selectPyPiReleaseArtifacts(metadata, selection.version).filter((artifact) =>
      isAllowedPyPiArtifactUrl(artifact.url),
    ),
    stagedNamespaces,
  );
  if (!comparable.length) {
    return emptyPyPiBaseline(`${selection.reason}:no-comparable-artifacts`, {
      version: selection.version,
      source: selection.source,
    });
  }

  const downloaded: PyPiArtifactInput[] = await Promise.all(
    comparable.map(async (artifact) => {
      const result = await broker.downloadPublicArtifact({
        url: artifact.url,
        kind: artifact.kind,
      });
      return { path: artifact.filename, files: result.files };
    }),
  );

  const preparedArtifacts = downloaded.map(preparePyPiArtifact);
  return {
    artifact: {
      files: flattenPyPiArtifactFiles(preparedArtifacts),
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

export function baselineFromPreviousArtifacts(input: PyPiAdapterInput): {
  artifact: AcquiredArtifact | null;
  baseline: BaselineInfo;
} {
  if (!input.previousArtifacts?.length) return emptyPyPiBaseline("no-previous-artifacts");
  const preparedArtifacts = input.previousArtifacts.map(preparePyPiArtifact);
  const manifest = packageJsonSummaryFor(input.manifest, preparedArtifacts);
  return {
    artifact: {
      files: flattenPyPiArtifactFiles(preparedArtifacts),
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

function emptyPyPiBaseline(
  reason: string,
  opts: { version?: string | null; source?: PyPiBaselineSelectionSource } = {},
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

// Download selection runs before any bytes are fetched, so it can only key off
// the public filename. Both the staged artifact paths and the candidate
// baseline filenames are reduced to the same filename-derived namespace, which
// bounds downloads to the wheel/sdist shapes that are actually staged. The diff
// itself re-derives namespaces from parsed WHEEL tags via artifactDiffNamespace.
function stagedArtifactNamespaces(details: StagedDetails): Set<string> {
  const d = details as PyPiAdapterDetails;
  return new Set(
    d.preparedArtifacts.map((artifact) => filenameArtifactNamespace(artifact.path, artifact.kind)),
  );
}

function selectComparableBaselineArtifacts(
  artifacts: PyPiRemoteArtifact[],
  stagedNamespaces: Set<string>,
): PyPiRemoteArtifact[] {
  const seen = new Set<string>();
  const selected: PyPiRemoteArtifact[] = [];
  for (const artifact of artifacts) {
    const namespace = filenameArtifactNamespace(artifact.filename, artifact.kind);
    if (!stagedNamespaces.has(namespace) || seen.has(namespace)) continue;
    seen.add(namespace);
    selected.push(artifact);
  }
  return selected;
}

export function pickPyPiBaselineRelease(
  metadata: PyPiProjectMetadata,
  candidateVersion: string,
): PyPiBaselineSelection {
  const releases = metadata.releases ?? {};
  const latest = metadata.info?.version ?? null;
  if (latest && latest !== candidateVersion && hasUsableReleaseFiles(releases[latest])) {
    return {
      version: latest,
      source: "latest-published",
      reason: "project-json-info-version",
    };
  }

  const byUploadTime = Object.entries(releases)
    .filter(([version, files]) => version !== candidateVersion && hasUsableReleaseFiles(files))
    .map(([version, files]) => ({
      version,
      uploadedAt: newestUploadTimestamp(files),
    }))
    .filter((entry) => entry.uploadedAt > 0)
    .sort((a, b) => a.uploadedAt - b.uploadedAt)
    .at(-1);

  if (byUploadTime) {
    return {
      version: byUploadTime.version,
      source: "upload-time",
      reason: "newest-uploaded-release",
    };
  }

  return {
    version: null,
    source: "none",
    reason: "no-published-baseline",
  };
}

export function selectPyPiReleaseArtifacts(
  metadata: PyPiProjectMetadata,
  version: string,
): PyPiRemoteArtifact[] {
  return (metadata.releases?.[version] ?? [])
    .filter((file) => !file.yanked)
    .map((file) => {
      const filename = file.filename ?? "";
      const kind = inferPyPiArtifactKind(filename);
      if (!filename || !kind || !file.url) return null;
      return {
        filename,
        url: file.url,
        sha256: file.digests?.sha256 ?? null,
        packagetype: file.packagetype ?? null,
        kind,
        size: typeof file.size === "number" ? file.size : null,
      };
    })
    .filter((artifact): artifact is PyPiRemoteArtifact => artifact !== null);
}

export function isAllowedPyPiArtifactUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "files.pythonhosted.org";
  } catch {
    return false;
  }
}

function flattenPyPiArtifactFiles(artifacts: PyPiPreparedArtifact[]): FileRecord[] {
  return artifacts.flatMap((artifact) =>
    artifact.files.map((file) => ({
      ...file,
      path: namespacedPath(artifactDiffNamespace(artifact), normalizePyPiDiffFilePath(file.path)),
    })),
  );
}

function assertManifestArtifactSet(
  manifest: PyPiReleaseManifest,
  artifacts: PyPiArtifactInput[],
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

function artifactDiffNamespace(artifact: PyPiPreparedArtifact): string {
  if (artifact.kind === "sdist") return "sdist";
  const tags = artifact.summary.wheel?.tags ?? [];
  if (tags.length) return `wheel/${tags.slice().sort().map(safeDiffPathPart).join("+")}`;
  return wheelFilenameNamespace(artifact.path);
}

function filenameArtifactNamespace(pathOrFilename: string, kind: PyPiArtifactKind): string {
  return kind === "sdist" ? "sdist" : wheelFilenameNamespace(pathOrFilename);
}

function wheelFilenameNamespace(pathOrFilename: string): string {
  const filename = pathOrFilename.split("/").at(-1) ?? "";
  const wheelTags = filename
    .replace(/\.whl$/i, "")
    .split("-")
    .slice(-3);
  if (wheelTags.length === 3) return `wheel/${wheelTags.map(safeDiffPathPart).join("-")}`;
  return "wheel/unknown";
}

function normalizePyPiDiffFilePath(path: string): string {
  return path
    .replace(/(^|\/)[^/]+\.dist-info\//gi, "$1.dist-info/")
    .replace(/(^|\/)[^/]+\.egg-info\//gi, "$1.egg-info/");
}

function safeDiffPathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_") || "unknown";
}

export function pickPackageIdentity(
  manifest: PyPiReleaseManifest,
  artifacts: PyPiPreparedArtifact[],
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
  manifest: PyPiReleaseManifest,
  artifacts: PyPiPreparedArtifact[],
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

function hasUsableReleaseFiles(files: PyPiReleaseFile[] | undefined): boolean {
  return Boolean(files?.some((file) => file.url && !file.yanked));
}

function newestUploadTimestamp(files: PyPiReleaseFile[]): number {
  return Math.max(
    0,
    ...files
      .filter((file) => !file.yanked)
      .map((file) => Date.parse(file.upload_time_iso_8601 ?? ""))
      .filter((time) => Number.isFinite(time)),
  );
}
