import type { FileRecord, PackageJsonSummary } from "../../review";
import type { AcquiredArtifact, AdapterContext, BaselineInfo, StagedDetails } from "../types";
import type { PyPiBroker } from "./broker";
import { summarizePyPiArtifact, namespacedPath } from "./findings";
import { inferPyPiArtifactKind, normalizePyPiProjectName } from "./manifest";
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

const MAX_PYPI_BASELINE_ARTIFACTS = 128;
const MAX_PYPI_BASELINE_ADVERTISED_BYTES = 768 * 1024 * 1024;

/**
 * Diff namespaces that still carry the body of a repeated logical file, keyed by
 * `${kind}\0${normalized diff path}`. The staged pass decides; the baseline pass
 * mirrors it (see `compactBaselineArtifactSamples`).
 */
export type PyPiSampleRetention = Map<string, Set<string>>;

export function preparePyPiArtifact(input: PyPiArtifactInput): PyPiPreparedArtifact {
  const kind = inferPyPiArtifactKind(input.path);
  if (!kind) throw new Error("PyPI artifact must be a wheel or sdist");
  const root = kind === "sdist" ? commonArchiveRoot(input.files) : null;
  const files = root ? stripArchiveRoot(input.files, root) : input.files;
  // Tar-parser evidence records raw archive paths; strip the same sdist root
  // so findings built from these entries line up with the stripped file list
  // (entries outside the root — themselves suspicious — stay untouched).
  const suspiciousEntries =
    root && input.suspiciousEntries
      ? input.suspiciousEntries.map((entry) =>
          entry.path.startsWith(`${root}/`)
            ? { ...entry, path: entry.path.slice(root.length + 1) }
            : entry,
        )
      : input.suspiciousEntries;
  return {
    path: input.path,
    kind,
    files,
    summary: summarizePyPiArtifact(input.path, kind, files),
    ...(suspiciousEntries ? { suspiciousEntries } : {}),
  };
}

export function acquireStagedPyPi(input: PyPiAdapterInput): {
  artifact: AcquiredArtifact;
  details: StagedDetails;
} {
  assertManifestArtifactSet(input.manifest, input.artifacts);
  const preparedArtifacts = input.artifacts.map(preparePyPiArtifact);
  compactStagedArtifactSamples(preparedArtifacts);
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
  const stagedRetention = stagedSampleRetention(staged.details);
  if (input.previousArtifacts?.length) {
    return baselineFromPreviousArtifacts(input, stagedRetention);
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

  const advertisedBytes = comparable.reduce((total, artifact) => total + (artifact.size ?? 0), 0);
  if (
    comparable.length > MAX_PYPI_BASELINE_ARTIFACTS ||
    advertisedBytes > MAX_PYPI_BASELINE_ADVERTISED_BYTES
  ) {
    return emptyPyPiBaseline(`${selection.reason}:baseline-resource-budget`, {
      version: selection.version,
      source: selection.source,
    });
  }

  // A release can have dozens of platform wheels. Download + sandbox-parse each
  // comparable baseline in sequence so only one archive's bytes/text samples
  // are live at a time; the public `/diff` path has its own two-artifact planner.
  const preparedArtifacts: PyPiPreparedArtifact[] = [];
  const retainedDigests = new Map<string, Set<string>>();
  for (const artifact of [...comparable].sort(
    (a, b) =>
      filenameArtifactNamespace(a.filename, a.kind).localeCompare(
        filenameArtifactNamespace(b.filename, b.kind),
      ) || a.filename.localeCompare(b.filename),
  )) {
    const result = await broker.downloadPublicArtifact({
      url: artifact.url,
      kind: artifact.kind,
    });
    const prepared = preparePyPiArtifact({ path: artifact.filename, files: result.files });
    compactBaselineArtifactSamples([prepared], stagedRetention, retainedDigests);
    preparedArtifacts.push(prepared);
  }
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

export function baselineFromPreviousArtifacts(
  input: PyPiAdapterInput,
  stagedRetention: PyPiSampleRetention = new Map(),
): {
  artifact: AcquiredArtifact | null;
  baseline: BaselineInfo;
} {
  if (!input.previousArtifacts?.length) return emptyPyPiBaseline("no-previous-artifacts");
  const preparedArtifacts = input.previousArtifacts.map(preparePyPiArtifact);
  compactBaselineArtifactSamples(preparedArtifacts, stagedRetention, new Map());
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
// bounds downloads to the wheel/sdist shapes that are actually staged. The
// diff tree uses the same filename-derived namespace (artifactDiffNamespace),
// so selection and diff pairing can never disagree.
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
  // Own-property check: `releases` is JSON.parse'd, so a bare index would
  // resolve prototype-named versions ("constructor", "toString") to
  // Object.prototype members instead of release arrays.
  const files =
    metadata.releases && Object.hasOwn(metadata.releases, version)
      ? metadata.releases[version]
      : undefined;
  return (Array.isArray(files) ? files : [])
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

export function flattenPyPiArtifactFiles(artifacts: PyPiPreparedArtifact[]): FileRecord[] {
  return artifacts.flatMap((artifact) =>
    artifact.files.map((file) => ({
      ...file,
      path: namespacedPath(artifactDiffNamespace(artifact), normalizePyPiDiffFilePath(file.path)),
    })),
  );
}

/**
 * Keep one text body for identical logical files repeated across platform wheels.
 *
 * Every artifact retains path, size, hash, and flags. A wheel whose copy differs
 * has a different digest and keeps its own sample, so platform-specific payloads
 * remain fully reviewable while honest repeated Python sources do not multiply
 * the parent Worker's heap by the wheel count.
 */
function compactStagedArtifactSamples(artifacts: PyPiPreparedArtifact[]): void {
  const retainedDigests = new Map<string, Set<string>>();
  for (const artifact of sortedForSampleRetention(artifacts)) {
    for (const file of artifact.files) {
      if (!file.textSample || mustRetainPerArtifact(file.path)) continue;
      const key = sampleRetentionKey(artifact, file.path);
      if (!retainFirstDigest(retainedDigests, key, file.sha256)) delete file.textSample;
    }
  }
}

/**
 * Compact a baseline artifact set against the staged side's retention decisions.
 *
 * Staged and baseline are different artifact sets — a release that adds a
 * platform wheel has no baseline counterpart for it — so letting each side pick
 * its own "first" copy can leave a shared file's body under different diff
 * namespaces. The namespace that kept only the baseline body then renders as a
 * whole-file deletion (and its mirror as a phantom addition) for a file that
 * merely changed. Following the staged decision keeps both sides of every
 * namespace either both sampled or both bare.
 */
function compactBaselineArtifactSamples(
  artifacts: PyPiPreparedArtifact[],
  stagedRetention: PyPiSampleRetention,
  retainedDigests: Map<string, Set<string>>,
): void {
  for (const artifact of sortedForSampleRetention(artifacts)) {
    const namespace = filenameArtifactNamespace(artifact.path, artifact.kind);
    for (const file of artifact.files) {
      if (!file.textSample || mustRetainPerArtifact(file.path)) continue;
      const key = sampleRetentionKey(artifact, file.path);
      const stagedNamespaces = stagedRetention.get(key);
      if (stagedNamespaces) {
        if (!stagedNamespaces.has(namespace)) delete file.textSample;
        continue;
      }
      // The candidate dropped this file entirely, so there is no staged copy to
      // align with; keep the first baseline copy of each distinct digest so the
      // removal still shows its content once.
      if (!retainFirstDigest(retainedDigests, key, file.sha256)) delete file.textSample;
    }
  }
}

/** The diff namespaces a compacted staged artifact set still carries a body in. */
export function stagedSampleRetention(details: StagedDetails): PyPiSampleRetention {
  const retention: PyPiSampleRetention = new Map();
  for (const artifact of (details as PyPiAdapterDetails).preparedArtifacts) {
    const namespace = filenameArtifactNamespace(artifact.path, artifact.kind);
    for (const file of artifact.files) {
      if (!file.textSample || mustRetainPerArtifact(file.path)) continue;
      const key = sampleRetentionKey(artifact, file.path);
      const namespaces = retention.get(key);
      if (namespaces) namespaces.add(namespace);
      else retention.set(key, new Set([namespace]));
    }
  }
  return retention;
}

function retainFirstDigest(
  retainedDigests: Map<string, Set<string>>,
  key: string,
  sha256: string,
): boolean {
  const digests = retainedDigests.get(key);
  if (!digests) {
    retainedDigests.set(key, new Set([sha256]));
    return true;
  }
  if (digests.has(sha256)) return false;
  digests.add(sha256);
  return true;
}

// Ordered by diff namespace rather than bundle path: shard uploads can place the
// same wheel at `dist/x.whl` or `x.whl`, and the baseline only ever sees the
// bare PyPI filename, so a path-ordered pass would disagree across sides.
function sortedForSampleRetention(artifacts: PyPiPreparedArtifact[]): PyPiPreparedArtifact[] {
  return [...artifacts].sort(
    (a, b) =>
      filenameArtifactNamespace(a.path, a.kind).localeCompare(
        filenameArtifactNamespace(b.path, b.kind),
      ) || a.path.localeCompare(b.path),
  );
}

// The diff pairs files by their normalized path (`*.dist-info/` collapsed), so
// retention keys on the same normalized path — otherwise a version-stamped
// `.dist-info` entry could never align between staged and baseline.
function sampleRetentionKey(artifact: PyPiPreparedArtifact, path: string): string {
  return `${artifact.kind}\0${normalizePyPiDiffFilePath(path)}`;
}

function mustRetainPerArtifact(path: string): boolean {
  const basename = path.split("/").at(-1)?.toUpperCase();
  return (
    basename === "METADATA" ||
    basename === "PKG-INFO" ||
    basename === "WHEEL" ||
    basename === "RECORD"
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

// Maps an artifact-relative file path to the namespaced path used by
// flattenPyPiArtifactFiles, so findings that reference files by artifact path
// can be re-pinned onto the flattened diff tree.
export function pyPiArtifactDiffPath(artifact: PyPiPreparedArtifact, filePath: string): string {
  return namespacedPath(artifactDiffNamespace(artifact), normalizePyPiDiffFilePath(filePath));
}

// Derived from the artifact FILENAME, never from the parsed WHEEL `Tag:`
// headers: the filename is validated by the registry/manifest while the WHEEL
// file is hostile package bytes — tag headers that lie (or merely differ in
// spelling, e.g. "py2.py3" expanding to two Tag lines) would put the two
// versions of the same wheel shape under different tree namespaces and
// degrade the whole diff to removed+added noise.
function artifactDiffNamespace(artifact: PyPiPreparedArtifact): string {
  if (artifact.kind === "sdist") return "sdist";
  return wheelFilenameNamespace(artifact.path);
}

export function filenameArtifactNamespace(pathOrFilename: string, kind: PyPiArtifactKind): string {
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
  manifest: Pick<PyPiReleaseManifest, "package" | "version">,
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

// Ecosystem-neutral manifest summary for a set of prepared artifacts. Mapping
// Requires-Dist into `dependencies` lets summarizePackageJsonDiff surface a
// new Python dependency between versions — the headline supply-chain signal —
// instead of always reporting an empty dependency diff for PyPI.
export function packageJsonSummaryFor(
  manifest: Pick<PyPiReleaseManifest, "package" | "version">,
  artifacts: PyPiPreparedArtifact[],
): PackageJsonSummary {
  const identity = pickPackageIdentity(manifest, artifacts);
  const dependencies = pyPiDependenciesFromArtifacts(artifacts);
  return {
    name: identity.name ?? undefined,
    version: identity.version ?? undefined,
    ...(dependencies ? { dependencies } : {}),
  };
}

// PEP 508 requirement strings ("requests[socks] (>=2.0) ; extra == 'x'")
// keyed by PEP 503-normalized project name; the remainder of the requirement
// string stands in for the version-range value.
function pyPiDependenciesFromArtifacts(
  artifacts: PyPiPreparedArtifact[],
): Record<string, string> | undefined {
  const dependencies: Record<string, string> = {};
  for (const artifact of artifacts) {
    for (const requirement of artifact.summary.requiresDist) {
      const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(.*)$/.exec(requirement);
      if (!match) continue;
      const name = normalizePyPiProjectName(match[1]);
      if (!Object.hasOwn(dependencies, name)) {
        dependencies[name] = match[2].trim() || "*";
      }
    }
  }
  return Object.keys(dependencies).length ? dependencies : undefined;
}

function commonArchiveRoot(files: FileRecord[]): string | null {
  const pathParts = files.map((file) => file.path.split("/"));
  if (!pathParts.length || pathParts.some((parts) => parts.length < 2)) return null;
  const root = pathParts[0][0];
  if (!root || pathParts.some((parts) => parts[0] !== root)) return null;
  return root;
}

function stripArchiveRoot(files: FileRecord[], root: string): FileRecord[] {
  return files.map((file) => ({
    ...file,
    path: file.path.startsWith(`${root}/`) ? file.path.slice(root.length + 1) : file.path,
  }));
}

function hasUsableReleaseFiles(files: PyPiReleaseFile[] | undefined): boolean {
  return Array.isArray(files) && files.some((file) => file.url && !file.yanked);
}

export function newestUploadTimestamp(files: PyPiReleaseFile[]): number {
  return Math.max(
    0,
    ...files
      .filter((file) => !file.yanked)
      .map((file) => Date.parse(file.upload_time_iso_8601 ?? ""))
      .filter((time) => Number.isFinite(time)),
  );
}
