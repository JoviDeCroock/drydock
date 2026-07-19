import {
  filenameArtifactNamespace,
  flattenPyPiArtifactFiles,
  isAllowedPyPiArtifactUrl,
  newestUploadTimestamp,
  packageJsonSummaryFor,
  preparePyPiArtifact,
  pyPiArtifactDiffPath,
  selectPyPiReleaseArtifacts,
} from "./adapters/pypi/acquire";
import { pyPiReleaseFindings } from "./adapters/pypi/findings";
import { inferPyPiArtifactKind, normalizePyPiProjectName } from "./adapters/pypi/manifest";
import {
  PYPI_RELEASE_MANIFEST_SCHEMA,
  type PyPiArtifactInput,
  type PyPiPreparedArtifact,
  type PyPiProjectMetadata,
  type PyPiReleaseFile,
  type PyPiReleaseManifest,
  type PyPiRemoteArtifact,
} from "./adapters/pypi/types";
import { compareParsedPyPiVersions, parsePyPiVersion } from "./adapters/pypi/version";
import {
  computeCompareMetadataCacheKey,
  readCompareMetadataCache,
  writeCompareMetadataCache,
} from "./compare-cache";
import { publicDiffDownloadError } from "./public-diff-download";
import { PublicDiffError } from "./public-diff-error";
import { reliableFetch } from "./reliable-fetch";
import {
  deterministicFindings,
  type CodePatternSet,
  type DiffEntry,
  type Finding,
  type FileRecord,
  type PackageJsonDiff,
  type PackageJsonSummary,
} from "./review";
import { downloadInSandbox } from "./sandbox";

// PyPI side of the anonymous public package diff. Like the npm path it only
// touches public-registry data: project metadata comes from the canonical
// pypi.org JSON API and artifact bytes only from files.pythonhosted.org, both
// fetched without credentials and parsed in the credentials-free sandbox.
export const PYPI_PUBLIC_REGISTRY = "https://pypi.org/pypi";

const PUBLIC_CACHE_SCOPE = "public";

// One raw (unredacted) side of a public diff, plus the ecosystem's findings
// builder. The orchestrator in public-diff.ts owns diffing, redaction, risk,
// and caching so both ecosystems share one assembly path.
export interface PublicDiffAcquiredSide {
  files: FileRecord[];
  packageJson: PackageJsonSummary | null;
}

export interface PublicDiffAcquiredSources {
  from: PublicDiffAcquiredSide;
  to: PublicDiffAcquiredSide;
  // Pattern family for diff-status annotation; the baseline fingerprint pass
  // re-runs the deterministic rules and must use the same set the findings
  // were built with, or unchanged capabilities get marked as release deltas.
  codePatternSet?: CodePatternSet;
  buildFindings(fileDiff: DiffEntry[], manifestDiff: PackageJsonDiff): Finding[];
}

export async function fetchPublicPyPiProjectMetadata(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  projectName: string,
): Promise<PyPiProjectMetadata> {
  const normalized = normalizePyPiProjectName(projectName);
  const key = await computeCompareMetadataCacheKey({
    registryUrl: PYPI_PUBLIC_REGISTRY,
    packageName: normalized,
    cacheScope: PUBLIC_CACHE_SCOPE,
  });
  const cached = await readCompareMetadataCache<PyPiProjectMetadata>(env, key);
  if (cached) return cached;

  let response: Response;
  try {
    response = await reliableFetch(
      `${PYPI_PUBLIC_REGISTRY}/${encodeURIComponent(normalized)}/json`,
      {
        headers: new Headers({ accept: "application/json" }),
      },
    );
  } catch {
    throw new PublicDiffError("registry metadata fetch failed", 502);
  }
  if (response.status === 404) throw new PublicDiffError("package not found", 404);
  if (!response.ok) throw new PublicDiffError("registry metadata fetch failed", 502);

  let metadata: PyPiProjectMetadata;
  try {
    metadata = prunePyPiProjectMetadata((await response.json()) as PyPiProjectMetadata);
  } catch {
    throw new PublicDiffError("registry metadata fetch failed", 502);
  }
  await writeCompareMetadataCache(env, ctx, key, metadata);
  return metadata;
}

// The raw project JSON carries the full description and unused per-file
// fields; multi-MB blobs for release-heavy projects would blow KV's value cap
// (a silently swallowed put) and make every repeat read expensive. Prune to
// the fields this module consumes before caching or returning.
function prunePyPiProjectMetadata(metadata: PyPiProjectMetadata): PyPiProjectMetadata {
  const releases: Record<string, PyPiReleaseFile[]> = {};
  for (const [version, files] of Object.entries(metadata.releases ?? {})) {
    if (!version || !Array.isArray(files)) continue;
    releases[version] = files.map((file) => ({
      ...(file.filename !== undefined ? { filename: file.filename } : {}),
      ...(file.packagetype !== undefined ? { packagetype: file.packagetype } : {}),
      ...(file.url !== undefined ? { url: file.url } : {}),
      ...(typeof file.size === "number" ? { size: file.size } : {}),
      ...(file.upload_time_iso_8601 !== undefined
        ? { upload_time_iso_8601: file.upload_time_iso_8601 }
        : {}),
      ...(file.digests?.sha256 ? { digests: { sha256: file.digests.sha256 } } : {}),
      ...(file.yanked !== undefined ? { yanked: file.yanked } : {}),
    }));
  }
  return {
    info: {
      ...(metadata.info?.name !== undefined ? { name: metadata.info.name } : {}),
      ...(metadata.info?.version !== undefined ? { version: metadata.info.version } : {}),
    },
    releases,
  };
}

export interface PublicPyPiVersionEntry {
  version: string;
  distTags: string[];
  publishedAt?: string;
}

// PyPI has no dist-tags, so `info.version` is surfaced as a synthetic
// "latest" tag. Versions are ordered newest-first by PEP 440 (mirroring the
// npm route's semver ordering) so a backport upload on an old branch — e.g. a
// 1.26.x patch shipped after 2.x — neither scrambles the picker nor becomes
// the suggested baseline; unparseable legacy versions sort below parseable
// ones by upload time. Only versions the diff can actually serve (at least
// one non-yanked wheel/sdist hosted on files.pythonhosted.org) appear, and
// the suggested pair is `latest` against its immediate version predecessor.
export function listPublicPyPiVersions(metadata: PyPiProjectMetadata): {
  versions: PublicPyPiVersionEntry[];
  suggested: { from: string; to: string } | null;
} {
  const latest = metadata.info?.version ?? null;
  const versions = Object.entries(metadata.releases ?? {})
    .filter(
      ([version, files]) => version && Array.isArray(files) && hasDiffablePublicArtifact(files),
    )
    .map(([version, files]) => ({
      version,
      uploadedAt: newestUploadTimestamp(files),
      parsed: parsePyPiVersion(version),
    }))
    .sort((a, b) => {
      if (a.parsed && b.parsed) {
        return (
          compareParsedPyPiVersions(b.parsed, a.parsed) ||
          b.uploadedAt - a.uploadedAt ||
          b.version.localeCompare(a.version)
        );
      }
      if (a.parsed) return -1;
      if (b.parsed) return 1;
      return b.uploadedAt - a.uploadedAt || b.version.localeCompare(a.version);
    })
    .map(({ version, uploadedAt }) => ({
      version,
      distTags: version === latest ? ["latest"] : [],
      ...(uploadedAt > 0 ? { publishedAt: new Date(uploadedAt).toISOString() } : {}),
    }));

  const toIndex = Math.max(
    versions.findIndex((entry) => entry.version === latest),
    0,
  );
  const to = versions[toIndex]?.version;
  const from = versions[toIndex + 1]?.version;
  return { versions, suggested: to && from ? { from, to } : null };
}

// Cheap per-release predicate: no artifact-object allocation, and short-
// circuits on the first servable file. Must stay in sync with what
// usablePublicArtifacts accepts (kind inferable + allowed host).
function hasDiffablePublicArtifact(files: PyPiReleaseFile[]): boolean {
  return files.some(
    (file) =>
      !file.yanked &&
      !!file.filename &&
      !!file.url &&
      inferPyPiArtifactKind(file.filename) !== null &&
      isAllowedPyPiArtifactUrl(file.url),
  );
}

const PREFERRED_WHEEL_NAMESPACE = "wheel/py3-none-any";

// A PyPI release can carry dozens of platform wheels; downloading them all for
// an anonymous endpoint would be unbounded work. Each side is capped at one
// sdist plus one wheel — preferring a wheel shape published by both versions
// (so the diff compares like with like), then the pure-Python wheel, then the
// lexicographically first filename for determinism.
export function selectPublicPyPiDiffArtifacts(
  metadata: PyPiProjectMetadata,
  fromVersion: string,
  toVersion: string,
): { from: PyPiRemoteArtifact[]; to: PyPiRemoteArtifact[] } {
  const fromAll = usablePublicArtifacts(metadata, fromVersion);
  const toAll = usablePublicArtifacts(metadata, toVersion);
  return {
    from: pickPublicSideArtifacts(fromAll, toAll),
    to: pickPublicSideArtifacts(toAll, fromAll),
  };
}

function usablePublicArtifacts(
  metadata: PyPiProjectMetadata,
  version: string,
): PyPiRemoteArtifact[] {
  // Object.hasOwn, not `in`: releases is JSON.parse'd, and `in` would accept
  // prototype-named versions ("constructor", "toString"), turning the 404
  // below into a TypeError-driven 500 further down.
  if (!metadata.releases || !Object.hasOwn(metadata.releases, version)) {
    throw new PublicDiffError("unknown version", 404);
  }
  const artifacts = selectPyPiReleaseArtifacts(metadata, version).filter((artifact) =>
    isAllowedPyPiArtifactUrl(artifact.url),
  );
  if (!artifacts.length) {
    throw new PublicDiffError("version has no diffable wheel or sdist artifacts", 404);
  }
  return artifacts;
}

function pickPublicSideArtifacts(
  side: PyPiRemoteArtifact[],
  other: PyPiRemoteArtifact[],
): PyPiRemoteArtifact[] {
  const chosen: PyPiRemoteArtifact[] = [];
  const sdist = side
    .filter((artifact) => artifact.kind === "sdist")
    .sort((a, b) => a.filename.localeCompare(b.filename))[0];
  if (sdist) chosen.push(sdist);

  const wheels = side.filter((artifact) => artifact.kind === "wheel");
  if (wheels.length) {
    const otherNamespaces = new Set(
      other
        .filter((artifact) => artifact.kind === "wheel")
        .map((artifact) => filenameArtifactNamespace(artifact.filename, "wheel")),
    );
    const wheel = wheels
      .slice()
      .sort(
        (a, b) =>
          wheelRank(a, otherNamespaces) - wheelRank(b, otherNamespaces) ||
          a.filename.localeCompare(b.filename),
      )[0];
    chosen.push(wheel);
  }
  return chosen;
}

function wheelRank(artifact: PyPiRemoteArtifact, otherNamespaces: Set<string>): number {
  const namespace = filenameArtifactNamespace(artifact.filename, "wheel");
  const shared = otherNamespaces.has(namespace);
  const pure = namespace === PREFERRED_WHEEL_NAMESPACE;
  if (shared && pure) return 0;
  if (shared) return 1;
  if (pure) return 2;
  return 3;
}

export async function downloadPublicPyPiArtifacts(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  artifacts: PyPiRemoteArtifact[],
): Promise<PyPiArtifactInput[]> {
  return Promise.all(
    artifacts.map(async (artifact) => {
      if (!isAllowedPyPiArtifactUrl(artifact.url)) {
        throw new PublicDiffError("registry returned an unexpected artifact URL", 502);
      }
      try {
        // No credentials exist on this path: the gateway sees only this single
        // pinned public-artifact URL and forwards the request uncredentialed.
        // Mirrors createPyPiBroker.downloadPublicArtifact (adapters/pypi/
        // broker.ts) — keep the sandbox options in lockstep with it; the
        // broker cannot be reused directly because its AdapterContext requires
        // an authenticated db/session this anonymous path never has.
        const result = await downloadInSandbox(env, ctx, {
          tarballUrl: artifact.url,
          archiveFormat: artifact.kind === "wheel" ? "zip" : "tgz",
          publicArtifactUrls: [artifact.url],
        });
        return {
          path: artifact.filename,
          files: result.files,
          ...(result.suspiciousEntries ? { suspiciousEntries: result.suspiciousEntries } : {}),
        };
      } catch (err) {
        throw publicDiffDownloadError(err);
      }
    }),
  );
}

// Pure assembly over already-downloaded artifact contents, split from the
// network path so it can be exercised directly in tests.
export function buildPublicPyPiDiffSources(input: {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  from: PyPiArtifactInput[];
  to: PyPiArtifactInput[];
  toRemoteArtifacts: PyPiRemoteArtifact[];
}): PublicDiffAcquiredSources {
  const fromPrepared = input.from.map(preparePyPiArtifact);
  const toPrepared = input.to.map(preparePyPiArtifact);

  // Synthetic release manifest describing what the registry says the `to`
  // version is. The metadata-mismatch rules then flag artifacts whose embedded
  // metadata disagrees with the registry, which is exactly the anomaly they
  // exist to catch.
  const manifest: PyPiReleaseManifest = {
    schema: PYPI_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "pypi",
    package: input.packageName,
    version: input.toVersion,
    artifacts: input.toRemoteArtifacts.map((artifact) => ({
      path: artifact.filename,
      sha256: (artifact.sha256 ?? "").toLowerCase(),
      kind: artifact.kind,
      ...(artifact.url ? { url: artifact.url } : {}),
    })),
  };

  const toFiles = flattenPyPiArtifactFiles(toPrepared);
  return {
    from: pyPiDiffSide(fromPrepared, input.packageName, input.fromVersion),
    to: {
      files: toFiles,
      packageJson: packageJsonSummaryFor(
        { package: input.packageName, version: input.toVersion },
        toPrepared,
      ),
    },
    codePatternSet: "python",
    // Same recipe as pypiAdapter.runFindings (deterministic python rules +
    // release findings) — keep the two in lockstep; delegating would require
    // fabricating a full AdapterRunFindingsArgs this path doesn't have.
    buildFindings: (fileDiff) => [
      ...deterministicFindings(toFiles, fileDiff, null, { codePatternSet: "python" }),
      ...remapPyPiFindingPaths(pyPiReleaseFindings(manifest, toPrepared), toPrepared),
    ],
  };
}

export async function acquirePublicPyPiDiff(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  input: { packageName: string; fromVersion: string; toVersion: string },
): Promise<PublicDiffAcquiredSources> {
  const metadata = await fetchPublicPyPiProjectMetadata(env, ctx, input.packageName);
  const selection = selectPublicPyPiDiffArtifacts(metadata, input.fromVersion, input.toVersion);
  const [from, to] = await Promise.all([
    downloadPublicPyPiArtifacts(env, ctx, selection.from),
    downloadPublicPyPiArtifacts(env, ctx, selection.to),
  ]);
  return buildPublicPyPiDiffSources({
    packageName: metadata.info?.name ?? input.packageName,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    from,
    to,
    toRemoteArtifacts: selection.to,
  });
}

function pyPiDiffSide(
  prepared: PyPiPreparedArtifact[],
  packageName: string,
  version: string,
): PublicDiffAcquiredSide {
  return {
    files: flattenPyPiArtifactFiles(prepared),
    packageJson: packageJsonSummaryFor({ package: packageName, version }, prepared),
  };
}

// PyPI release findings pin evidence to `<artifact filename>/<path>` while the
// flattened diff tree namespaces files as `sdist/...` or `wheel/<tags>/...`.
// Re-pin the findings onto the diff tree so the UI can attach them to files.
function remapPyPiFindingPaths(findings: Finding[], prepared: PyPiPreparedArtifact[]): Finding[] {
  return findings.map((finding) => {
    const artifact = prepared.find((candidate) => finding.file.startsWith(`${candidate.path}/`));
    if (!artifact) return finding;
    return {
      ...finding,
      file: pyPiArtifactDiffPath(artifact, finding.file.slice(artifact.path.length + 1)),
    };
  });
}
