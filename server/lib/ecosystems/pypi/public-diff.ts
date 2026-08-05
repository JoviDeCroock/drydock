import {
  filenameArtifactNamespace,
  flattenPyPiArtifactFiles,
  isAllowedPyPiArtifactUrl,
  newestUploadTimestamp,
  packageJsonSummaryFor,
  preparePyPiArtifact,
  pyPiArtifactDiffPath,
  selectPyPiReleaseArtifacts,
} from "./acquire";
import { pyPiReleaseFindings } from "./findings";
import {
  inferPyPiArtifactKind,
  isValidPyPiProjectName,
  normalizePyPiProjectName,
} from "./manifest";
import {
  PYPI_RELEASE_MANIFEST_SCHEMA,
  PYPI_RULES_VERSION,
  SAFE_VERSION_RE,
  type PyPiArtifactInput,
  type PyPiPreparedArtifact,
  type PyPiProjectMetadata,
  type PyPiReleaseFile,
  type PyPiReleaseManifest,
  type PyPiRemoteArtifact,
} from "./types";
import { compareParsedPyPiVersions, parsePyPiVersion } from "./version";
import {
  computeCompareMetadataCacheKey,
  readCompareMetadataCache,
  writeCompareMetadataCache,
} from "../../compare-cache";
import { publicDiffDownloadError } from "../../public-diff/download";
import { PublicDiffError } from "../../public-diff/error";
import type {
  PublicDiffAcquiredSide,
  PublicDiffAcquiredSources,
  PublicDiffAdapter,
} from "../../public-diff/types";
import { reliableFetch } from "../../platform/reliable-fetch";
import { DETERMINISTIC_RULES_VERSION, deterministicFindings, type Finding } from "../../review";
import { downloadInSandbox } from "../../sandbox";

// PyPI side of the anonymous public package diff. Like the npm path it only
// touches public-registry data: project metadata comes from the canonical
// pypi.org JSON API and artifact bytes only from files.pythonhosted.org, both
// fetched without credentials and parsed in the credentials-free sandbox.
const PYPI_PUBLIC_REGISTRY = "https://pypi.org/pypi";

const PUBLIC_CACHE_SCOPE = "public";

// The acquired-sources shape is the shared public-diff contract; PyPI fills in
// the same fields npm does. The orchestrator owns diffing, redaction, risk, and
// caching so every ecosystem shares one assembly path.
export type { PublicDiffAcquiredSources } from "../../public-diff/types";

/**
 * PyPI's public-diff capability.
 *
 * PyPI has no dist-tags and no preview form, and a single release can carry
 * dozens of platform wheels — hence the artifact selection and byte budget in
 * this module, which npm does not need.
 */
export const pypiPublicDiff: PublicDiffAdapter = {
  ecosystem: "pypi",
  registryUrl: PYPI_PUBLIC_REGISTRY,
  rulesVersionSegment: `${DETERMINISTIC_RULES_VERSION}+pypi-${PYPI_RULES_VERSION}`,
  // v5: pairs now have a request-wide selected-byte budget, which can omit one
  // artifact kind with a notice instead of exhausting the Worker.
  // v6: oversized pairs retain samples for changed files instead of dropping
  // every sample, and mark the records that lost one. Entries written by v5
  // carry no sample at all for a pair this large, so they must not be served
  // once the prioritized retention ships.
  payloadVersion: "v6",

  isValidPackageName: isValidPyPiProjectName,
  // PyPI names are case/separator-insensitive (PEP 503); canonicalize once at
  // the request boundary so the cache key, cache tag, and payload identity all
  // agree — "Django" and "django" must share one entry AND one purge tag.
  normalizePackageName: normalizePyPiProjectName,
  isValidVersion: (version) => SAFE_VERSION_RE.test(version),
  cacheTag: (packageName) => `public-diff:pypi:${packageName}`,

  async listVersions(env, ctx, packageName) {
    const metadata = await fetchPublicPyPiProjectMetadata(env, ctx, packageName);
    const { versions, suggested } = listPublicPyPiVersions(metadata);
    return { packageName: metadata.info?.name ?? packageName, versions, suggested };
  },

  acquire(env, ctx, input) {
    return acquirePublicPyPiDiff(env, ctx, input);
  },
};

async function fetchPublicPyPiProjectMetadata(
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
// A public diff may select one sdist and one wheel for each version. Each
// artifact is independently bounded by the sandbox, but starting four large
// parses at once can still exceed the parent Worker's aggregate memory/CPU
// envelope. Keep the request-wide advertised download set bounded before any
// bytes are fetched. When both artifact kinds do not fit, retain the cheaper
// comparable pair and disclose the omitted coverage.
const PUBLIC_PYPI_DIFF_MAX_SELECTED_BYTES = 50 * 1024 * 1024;

interface PublicPyPiDiffSelection {
  from: PyPiRemoteArtifact[];
  to: PyPiRemoteArtifact[];
}

interface PublicPyPiDiffPlan extends PublicPyPiDiffSelection {
  omittedKinds: Set<PyPiRemoteArtifact["kind"]>;
  notices: string[];
}

// A PyPI release can carry dozens of platform wheels; downloading them all for
// an anonymous endpoint would be unbounded work. Each side is capped at one
// sdist plus one wheel — preferring a wheel shape published by both versions
// (so the diff compares like with like), then the pure-Python wheel, then the
// lexicographically first filename for determinism.
export function selectPublicPyPiDiffArtifacts(
  metadata: PyPiProjectMetadata,
  fromVersion: string,
  toVersion: string,
): PublicPyPiDiffSelection {
  const fromAll = usablePublicArtifacts(metadata, fromVersion);
  const toAll = usablePublicArtifacts(metadata, toVersion);
  return {
    from: pickPublicSideArtifacts(fromAll, toAll),
    to: pickPublicSideArtifacts(toAll, fromAll),
  };
}

export function limitPublicPyPiDiffArtifacts(
  selection: PublicPyPiDiffSelection,
  maxSelectedBytes = PUBLIC_PYPI_DIFF_MAX_SELECTED_BYTES,
): PublicPyPiDiffPlan {
  const selected = [...selection.from, ...selection.to];
  const selectedBytes = sumArtifactSizes(selected);
  if (selectedBytes !== null && selectedBytes <= maxSelectedBytes) {
    return { ...selection, omittedKinds: new Set(), notices: [] };
  }

  const candidates = (["wheel", "sdist"] as const)
    .map((kind) => {
      const from = selection.from.filter((artifact) => artifact.kind === kind);
      const to = selection.to.filter((artifact) => artifact.kind === kind);
      const bytes = from.length && to.length ? sumArtifactSizes([...from, ...to]) : null;
      return { kind, from, to, bytes };
    })
    .filter(
      (
        candidate,
      ): candidate is {
        kind: PyPiRemoteArtifact["kind"];
        from: PyPiRemoteArtifact[];
        to: PyPiRemoteArtifact[];
        bytes: number;
      } => candidate.bytes !== null && candidate.bytes <= maxSelectedBytes,
    )
    .sort((a, b) => a.bytes - b.bytes || artifactKindRank(a.kind) - artifactKindRank(b.kind));

  const kept = candidates[0];
  if (!kept) {
    throw new PublicDiffError("selected PyPI artifacts exceed the public diff size limit", 413);
  }

  const omittedKinds = new Set(
    selected.map((artifact) => artifact.kind).filter((kind) => kind !== kept.kind),
  );
  const notices = [...omittedKinds]
    .sort()
    .map(
      (kind) =>
        `${kind === "sdist" ? "The source distribution (sdist)" : "The wheel"} was omitted from both sides to keep selected artifact downloads within the ${formatMiB(maxSelectedBytes)} public diff limit.`,
    );
  return { from: kept.from, to: kept.to, omittedKinds, notices };
}

function sumArtifactSizes(artifacts: PyPiRemoteArtifact[]): number | null {
  let total = 0;
  for (const artifact of artifacts) {
    if (artifact.size === null || !Number.isSafeInteger(artifact.size) || artifact.size < 0) {
      return null;
    }
    total += artifact.size;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function artifactKindRank(kind: PyPiRemoteArtifact["kind"]): number {
  // When costs tie, prefer the installable wheel over source-only evidence.
  return kind === "wheel" ? 0 : 1;
}

function formatMiB(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))} MiB`;
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

export interface PublicPyPiArtifactDownload {
  artifact: PyPiRemoteArtifact;
  input: PyPiArtifactInput | null;
  error: PublicDiffError | null;
}

async function downloadPublicPyPiArtifact(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  artifact: PyPiRemoteArtifact,
): Promise<PublicPyPiArtifactDownload> {
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
      artifact,
      input: {
        path: artifact.filename,
        files: result.files,
        ...(result.suspiciousEntries ? { suspiciousEntries: result.suspiciousEntries } : {}),
      },
      error: null,
    };
  } catch (err) {
    // Per-artifact capture instead of a throw: the caller decides whether
    // a capacity failure dooms the whole diff or just this artifact kind.
    return { artifact, input: null, error: publicDiffDownloadError(err) };
  }
}

async function downloadPublicPyPiArtifacts(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  selection: PublicPyPiDiffSelection,
): Promise<{ from: PublicPyPiArtifactDownload[]; to: PublicPyPiArtifactDownload[] }> {
  const from: PublicPyPiArtifactDownload[] = [];
  const to: PublicPyPiArtifactDownload[] = [];

  // Parse one comparable artifact pair at a time. This preserves from/to
  // latency overlap while ensuring a request never has four dynamic sandbox
  // Workers inflating large archives concurrently.
  for (const kind of ["sdist", "wheel"] as const) {
    const fromArtifact = selection.from.find((artifact) => artifact.kind === kind);
    const toArtifact = selection.to.find((artifact) => artifact.kind === kind);
    const [fromDownload, toDownload] = await Promise.all([
      fromArtifact ? downloadPublicPyPiArtifact(env, ctx, fromArtifact) : null,
      toArtifact ? downloadPublicPyPiArtifact(env, ctx, toArtifact) : null,
    ]);
    if (fromDownload) from.push(fromDownload);
    if (toDownload) to.push(toDownload);
  }
  return { from, to };
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
      ...remapPyPiFindingPaths(pyPiReleaseFindings(manifest, toPrepared, fileDiff), toPrepared),
    ],
  };
}

async function acquirePublicPyPiDiff(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  input: { packageName: string; fromVersion: string; toVersion: string },
): Promise<PublicDiffAcquiredSources> {
  const metadata = await fetchPublicPyPiProjectMetadata(env, ctx, input.packageName);
  const selection = limitPublicPyPiDiffArtifacts(
    selectPublicPyPiDiffArtifacts(metadata, input.fromVersion, input.toVersion),
  );
  const downloads = await downloadPublicPyPiArtifacts(env, ctx, selection);
  const resolved = resolvePublicPyPiDownloads(downloads.from, downloads.to);
  const omittedKinds = new Set([...selection.omittedKinds, ...resolved.omittedKinds]);
  const notices = [...selection.notices, ...resolved.notices];

  return {
    ...buildPublicPyPiDiffSources({
      packageName: metadata.info?.name ?? input.packageName,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      from: resolved.from,
      to: resolved.to,
      // The synthetic release manifest must describe only the artifacts the
      // diff actually contains, or the metadata-mismatch rules would flag the
      // omitted artifact as missing evidence.
      toRemoteArtifacts: selection.to.filter((artifact) => !omittedKinds.has(artifact.kind)),
    }),
    ...(notices.length ? { notices } : {}),
  };
}

// Pure resolution of per-artifact download outcomes into a servable pair,
// split from the network path so the fallback rules are directly testable.
export function resolvePublicPyPiDownloads(
  fromDownloads: PublicPyPiArtifactDownload[],
  toDownloads: PublicPyPiArtifactDownload[],
): {
  from: PyPiArtifactInput[];
  to: PyPiArtifactInput[];
  omittedKinds: Set<PyPiRemoteArtifact["kind"]>;
  notices: string[];
} {
  const downloads = [...fromDownloads, ...toDownloads];

  // Only capacity failures (413: file-count or byte caps) degrade to a
  // partial diff; a transient download failure must stay fatal or the diff
  // would silently render wheel-only and look complete.
  const fatal = downloads.find(
    (download) => download.error && download.error.status !== 413,
  )?.error;
  if (fatal) throw fatal;

  // An over-cap artifact is dropped from BOTH sides, not just its own: keeping
  // the other side's copy would diff sdist-vs-nothing and render the entire
  // sdist tree as added or removed.
  const omittedKinds = new Set(
    downloads.filter((download) => download.error).map((download) => download.artifact.kind),
  );
  const from = pickSurvivingInputs(fromDownloads, omittedKinds);
  const to = pickSurvivingInputs(toDownloads, omittedKinds);
  if (!from.length || !to.length) {
    // Nothing survived on a side — every scannable artifact tripped a cap, so
    // surface the capacity error rather than an empty diff.
    const firstError = downloads.find((download) => download.error)?.error;
    throw (
      firstError ?? new PublicDiffError("version has no diffable wheel or sdist artifacts", 404)
    );
  }

  const notices = [...omittedKinds].sort().map((kind) => {
    const failed = downloads.find((download) => download.error && download.artifact.kind === kind);
    const reason = failed?.error?.message ?? "artifact exceeds scan limits";
    return `${kind === "sdist" ? "The source distribution (sdist)" : "The wheel"} could not be scanned (${reason}), so ${kind} files are omitted from both sides of this diff.`;
  });

  return { from, to, omittedKinds, notices };
}

function pickSurvivingInputs(
  downloads: PublicPyPiArtifactDownload[],
  omittedKinds: Set<PyPiRemoteArtifact["kind"]>,
): PyPiArtifactInput[] {
  const inputs: PyPiArtifactInput[] = [];
  for (const download of downloads) {
    if (omittedKinds.has(download.artifact.kind)) continue;
    // A download with no error always carries its input; the guard is for the
    // type system, not a reachable state.
    if (download.input) inputs.push(download.input);
  }
  return inputs;
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
