import type { AiReview } from "./ai-review-types";
import { buildNpmFindings } from "./adapters/npm/findings";
import { normalizePyPiProjectName } from "./adapters/pypi/manifest";
import { PYPI_RULES_VERSION } from "./adapters/pypi/types";
import {
  computeCompareMetadataCacheKey,
  readCompareMetadataCache,
  writeCompareMetadataCache,
} from "./compare-cache";
import { parsePkgPrNewUrl, type PkgPrNewSpec } from "../../src/lib/pkg-pr-new";
import { publicDiffDownloadError } from "./public-diff-download";
import { PublicDiffError } from "./public-diff-error";
import { acquirePublicPyPiDiff, type PublicDiffAcquiredSources } from "./public-diff-pypi";
import {
  downloadPkgPrNewTarball,
  downloadPublishedTarball,
  isPublishedTarballUrlAllowed,
} from "./published-tarball";
import { fetchPackageMetadata, type RegistryMetadata } from "./registry";
import {
  annotateFindingsWithDiffStatus,
  createPackageDiff,
  redactFileRecords,
  redactFindings,
  redactJson,
  summarizePackageJsonDiff,
  DETERMINISTIC_RULES_VERSION,
  type DiffEntry,
  type FileRecord,
  type Finding,
  type FindingDiffAnnotation,
  type PackageJsonDiff,
  type PackageJsonSummary,
} from "./review";
import { computeScanRiskBreakdown, type ScanRiskBreakdown } from "./risk";
import { parseSandboxErrorDetail } from "./sandbox";

export { PublicDiffError } from "./public-diff-error";

export type PublicDiffEcosystem = "npm" | "pypi";

// Anonymous, credential-free diff of two published versions of an npm package
// or PyPI project — or, on npm, of a pkg.pr.new preview tarball against a
// published version (fromVersion / toVersion may each be a validated
// pkg.pr.new URL). Reuses the scan pipeline's pure phases (package diff,
// deterministic rules, diff-status annotation, risk breakdown) over published
// artifacts instead of staged-vs-published. Findings run on raw text samples
// before redaction, like the scan pipeline, so secret detection keeps working;
// only redacted evidence is cached or returned.
export interface PublicPackageDiff {
  ecosystem: PublicDiffEcosystem;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  fromPackageJson: PackageJsonSummary | null;
  toPackageJson: PackageJsonSummary | null;
  // Redacted records with bounded text samples. Internal to the cache payload;
  // route handlers strip samples from list responses and serve them per file.
  fromFiles: FileRecord[];
  toFiles: FileRecord[];
  diff: DiffEntry[];
  packageJsonDiff: PackageJsonDiff;
  findings: Array<Finding & FindingDiffAnnotation>;
  risk: ScanRiskBreakdown;
  // True when the cached payload could not carry every file's display sample.
  // Retention is prioritized (see retainedSamplePaths), so this being set does
  // not mean no sample survived; the per-file `sample-omitted` flag marks the
  // records that lost theirs.
  textSamplesOmitted?: boolean;
  // Coverage caveats from acquisition (e.g. a PyPI artifact kind omitted from
  // both sides because it exceeded a sandbox cap). Rendered as a banner.
  notices?: string[];
  cachedAt: string;
}

export interface PublicDiffInput {
  ecosystem: PublicDiffEcosystem;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  registryUrl: string;
  allowInsecureLocalhost?: boolean;
}

// Bump this when risk aggregation changes without a deterministic-rules bump.
const PUBLIC_DIFF_RISK_VERSION = "1";
// v3: ecosystem-aware payloads. Each ecosystem carries its own rules-version
// segment so a PyPI rules bump does not invalidate cached npm pairs.
// v4: two-tier sandbox entry cap — big archives now parse with hash-only
// tails, and payloads carry acquisition notices; cached v3 pairs would
// misrepresent both.
// PyPI v5: pairs now have a request-wide selected-byte budget, which can omit
// one artifact kind with a notice instead of exhausting the Worker. npm stays
// on v4 so this PyPI-only change does not invalidate its computed cache.
// npm v5 / PyPI v6: oversized pairs retain samples for changed files instead of
// dropping every sample, and mark the records that lost one. Entries written by
// the previous versions carry no sample at all for a pair this large, so they
// must not be served once the prioritized retention ships.
function publicDiffCachePrefix(ecosystem: PublicDiffEcosystem): string {
  const rules =
    ecosystem === "pypi"
      ? `${DETERMINISTIC_RULES_VERSION}+pypi-${PYPI_RULES_VERSION}`
      : DETERMINISTIC_RULES_VERSION;
  const payloadVersion = ecosystem === "pypi" ? "v6" : "v5";
  return `public-diff:${payloadVersion}:${ecosystem}:rules=${rules}:risk=${PUBLIC_DIFF_RISK_VERSION}:`;
}
// Package bytes are immutable, while the analysis version is encoded above.
// The TTL therefore bounds storage rather than correctness.
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
// pkg.pr.new preview refs are mutable (a pull-request ref advances with every
// commit, and a re-run workflow can rebuild the same sha), so pairs that
// involve a preview keep a short TTL: repeat views stay cheap while staleness
// is bounded.
const PREVIEW_CACHE_TTL_SECONDS = 60 * 15;
const CACHE_READ_COLO_TTL_SECONDS = 60;
// KV values cap at 25 MiB; leave headroom for metadata around the samples.
const CACHE_MAX_PAYLOAD_BYTES = 20 * 1024 * 1024;
const PUBLIC_CACHE_SCOPE = "public";
const COLO_CACHE_ORIGIN = "https://drydock.org/__cache/public-diff/";

// The public path never evaluates AI review; this mirrors the pipeline's
// disabled value (model: null keeps risk scoring neutral).
const AI_REVIEW_DISABLED: AiReview = {
  status: "unavailable",
  risk: "low",
  releaseAssessment: "not_assessed",
  summary: "AI review is disabled.",
  findings: [],
  requiresManualReview: false,
  model: null,
};

export async function fetchPublicPackageMetadata(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  packageName: string,
  registryUrl: string,
): Promise<RegistryMetadata> {
  const key = await computeCompareMetadataCacheKey({
    registryUrl,
    packageName,
    cacheScope: PUBLIC_CACHE_SCOPE,
  });
  const cached = await readCompareMetadataCache(env, key);
  if (cached) return cached;

  let metadata: RegistryMetadata;
  try {
    metadata = await fetchPackageMetadata(env, packageName, { npmRegistry: registryUrl });
  } catch (err) {
    if (err instanceof Error && err.message.includes("404")) {
      throw new PublicDiffError("package not found", 404);
    }
    throw new PublicDiffError("registry metadata fetch failed", 502);
  }
  await writeCompareMetadataCache(env, ctx, key, metadata);
  return metadata;
}

export async function loadPublicPackageDiff(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  input: PublicDiffInput,
): Promise<PublicPackageDiff> {
  // Preview-side validation is fetch-free and runs before any cache or
  // registry work: a preview URL must name the same package as the request.
  const fromPreview = parsePkgPrNewUrl(input.fromVersion);
  const toPreview = parsePkgPrNewUrl(input.toVersion);
  for (const preview of [fromPreview, toPreview]) {
    if (preview && preview.packageName !== input.packageName) {
      throw new PublicDiffError("preview URL is for a different package", 400);
    }
  }

  const cacheKey = await computePublicDiffCacheKey(input);
  const cached = await readPublicDiffCache(env, cacheKey);
  if (cached) return cached;

  const sources =
    input.ecosystem === "pypi"
      ? await acquirePublicPyPiDiff(env, ctx, input)
      : await acquirePublicNpmDiff(env, ctx, input, { fromPreview, toPreview });

  const fileDiff = createPackageDiff(sources.from.files, sources.to.files);
  const manifestDiff = redactJson(
    summarizePackageJsonDiff(sources.from.packageJson, sources.to.packageJson),
  );
  const ruleFindings = redactFindings(sources.buildFindings(fileDiff, manifestDiff));

  const redactedFromFiles = redactFileRecords(sources.from.files);
  const redactedToFiles = redactFileRecords(sources.to.files);
  const findings = annotateFindingsWithDiffStatus(ruleFindings, fileDiff, {
    previousFiles: redactedFromFiles,
    stagedFiles: redactedToFiles,
    // Baseline fingerprints re-run the deterministic rules over the previous
    // files; they must use the ecosystem's pattern set (python for PyPI) or
    // unchanged capabilities read as release deltas.
    codePatternSet: sources.codePatternSet,
  });
  const risk = computeScanRiskBreakdown(findings, AI_REVIEW_DISABLED);

  const payload: PublicPackageDiff = {
    ecosystem: input.ecosystem,
    packageName: input.packageName,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    fromPackageJson: redactJson(sources.from.packageJson),
    toPackageJson: redactJson(sources.to.packageJson),
    fromFiles: redactedFromFiles,
    toFiles: redactedToFiles,
    diff: fileDiff,
    packageJsonDiff: manifestDiff,
    findings,
    risk,
    ...(sources.notices?.length ? { notices: sources.notices } : {}),
    cachedAt: new Date().toISOString(),
  };
  await writePublicDiffCache(env, cacheKey, payload, {
    ttlSeconds: fromPreview || toPreview ? PREVIEW_CACHE_TTL_SECONDS : CACHE_TTL_SECONDS,
  });
  return payload;
}

async function acquirePublicNpmDiff(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  input: PublicDiffInput,
  previews: { fromPreview: PkgPrNewSpec | null; toPreview: PkgPrNewSpec | null },
): Promise<PublicDiffAcquiredSources> {
  const { fromPreview, toPreview } = previews;
  // Registry metadata is only needed for registry-version sides; a
  // preview-vs-preview pair may not be published on npm at all yet.
  let fromTarballUrl = fromPreview?.url;
  let toTarballUrl = toPreview?.url;
  if (!fromTarballUrl || !toTarballUrl) {
    const metadata = await fetchPublicPackageMetadata(
      env,
      ctx,
      input.packageName,
      input.registryUrl,
    );
    fromTarballUrl ??= metadata.versions?.[input.fromVersion]?.dist?.tarball;
    toTarballUrl ??= metadata.versions?.[input.toVersion]?.dist?.tarball;
    if (!fromTarballUrl || !toTarballUrl) {
      throw new PublicDiffError("unknown version", 404);
    }
    for (const [tarballUrl, preview] of [
      [fromTarballUrl, fromPreview],
      [toTarballUrl, toPreview],
    ] as const) {
      if (
        !preview &&
        !isPublishedTarballUrlAllowed(
          tarballUrl,
          input.registryUrl,
          input.allowInsecureLocalhost ?? false,
        )
      ) {
        throw new PublicDiffError("registry returned an unexpected tarball URL", 502);
      }
    }
  }

  const [fromArchive, toArchive] = await Promise.all([
    fromPreview
      ? downloadPreviewArchive(env, ctx, fromPreview.url)
      : downloadArchive(env, ctx, fromTarballUrl, input),
    toPreview
      ? downloadPreviewArchive(env, ctx, toPreview.url)
      : downloadArchive(env, ctx, toTarballUrl, input),
  ]);

  return {
    from: { files: fromArchive.files, packageJson: fromArchive.packageJson ?? null },
    to: { files: toArchive.files, packageJson: toArchive.packageJson ?? null },
    buildFindings: (fileDiff, manifestDiff) =>
      buildNpmFindings({
        staged: {
          files: toArchive.files,
          manifest: toArchive.packageJson ?? null,
          suspiciousTarEntries: toArchive.suspiciousEntries,
        },
        details: null,
        fileDiff,
        manifestDiff,
        stagedManifestText:
          toArchive.files.find((file) => file.path === "package.json")?.textSample ?? null,
      }),
  };
}

async function downloadArchive(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  tarballUrl: string,
  input: { registryUrl: string; allowInsecureLocalhost?: boolean },
) {
  try {
    return await downloadPublishedTarball(env, ctx, tarballUrl, {
      registryUrl: input.registryUrl,
      allowInsecureLocalhost: input.allowInsecureLocalhost,
    });
  } catch (err) {
    throw publicDiffDownloadError(err);
  }
}

async function downloadPreviewArchive(env: Cloudflare.Env, ctx: ExecutionContext, url: string) {
  try {
    return await downloadPkgPrNewTarball(env, ctx, url);
  } catch (err) {
    // A preview ref that no longer resolves is the one failure the shared
    // mapping cannot name, because published tarball URLs come from registry
    // metadata and never 404 on their own.
    if (parseSandboxErrorDetail(err)?.status === 404) {
      throw new PublicDiffError("preview not found on pkg.pr.new", 404);
    }
    throw publicDiffDownloadError(err);
  }
}

export async function computePublicDiffCacheKey(input: {
  ecosystem: PublicDiffEcosystem;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  registryUrl: string;
}): Promise<string> {
  // PyPI project names are case- and separator-insensitive, so normalize them
  // before hashing to keep "Django" and "django" on one cache entry.
  const packageName =
    input.ecosystem === "pypi" ? normalizePyPiProjectName(input.packageName) : input.packageName;
  const data = new TextEncoder().encode(
    `${input.ecosystem}|${input.registryUrl}|${packageName}|${input.fromVersion}|${input.toVersion}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${publicDiffCachePrefix(input.ecosystem)}${hex}`;
}

export async function readPublicDiffCache(
  env: Cloudflare.Env,
  key: string,
): Promise<PublicPackageDiff | null> {
  const coloCached = await readPublicDiffColoCache(key);
  if (coloCached) return coloCached;
  if (!env.COMPARE_CACHE) return null;
  try {
    const cached = await env.COMPARE_CACHE.get<PublicPackageDiff>(key, {
      type: "json",
      cacheTtl: CACHE_READ_COLO_TTL_SECONDS,
    });
    if (cached) {
      await writePublicDiffColoCache(key, JSON.stringify(cached), payloadCacheTtlSeconds(cached));
    }
    return cached;
  } catch {
    return null;
  }
}

export async function writePublicDiffCache(
  env: Cloudflare.Env,
  key: string,
  payload: PublicPackageDiff,
  options: { ttlSeconds?: number } = {},
): Promise<void> {
  const ttlSeconds = options.ttlSeconds ?? CACHE_TTL_SECONDS;
  const serialized = serializePublicDiffCachePayload(payload);
  const writes: Promise<unknown>[] = [writePublicDiffColoCache(key, serialized, ttlSeconds)];
  if (env.COMPARE_CACHE && utf8ByteLength(serialized) <= CACHE_MAX_PAYLOAD_BYTES) {
    writes.push(
      env.COMPARE_CACHE.put(key, serialized, {
        expirationTtl: ttlSeconds,
      }),
    );
  }
  await Promise.allSettled(writes);
}

export function serializePublicDiffCachePayload(
  payload: PublicPackageDiff,
  maxPayloadBytes = CACHE_MAX_PAYLOAD_BYTES,
): string {
  const serialized = JSON.stringify(payload);
  if (utf8ByteLength(serialized) <= maxPayloadBytes) return serialized;

  // Oversized pair: cache a reduced sample set so repeat views stay cheap
  // without blanking the workbench. Dropping every sample used to leave large
  // releases (a numpy wheel pair carries ~20 MiB of Python text) rendering
  // "No text samples available to diff." on every file, including the handful
  // that actually changed — the only ones a reviewer opens.
  const retained = retainedSamplePaths(payload, maxPayloadBytes);
  if (retained.size) {
    const reduced = JSON.stringify({
      ...payload,
      fromFiles: applySampleRetention(payload.fromFiles, retained),
      toFiles: applySampleRetention(payload.toFiles, retained),
      textSamplesOmitted: true,
    } satisfies PublicPackageDiff);
    // The selection above works from estimated per-path costs, so confirm the
    // real payload fits before committing to it rather than trusting the
    // estimate to be exact.
    if (utf8ByteLength(reduced) <= maxPayloadBytes) return reduced;
  }

  // Nothing fit: cache metadata only. The per-file endpoint then reports
  // samples as unavailable instead of recomputing two archive parses per file
  // view.
  return JSON.stringify({
    ...payload,
    fromFiles: applySampleRetention(payload.fromFiles, new Set()),
    toFiles: applySampleRetention(payload.toFiles, new Set()),
    textSamplesOmitted: true,
  } satisfies PublicPackageDiff);
}

// Flags a record whose display sample was dropped to fit the cache budget, so
// the UI can say why the body is missing instead of implying the parser never
// captured one. Mirrored as a literal in src/components/DiffView.tsx alongside
// the parser's own flags.
export const SAMPLE_OMITTED_FLAG = "sample-omitted";

// JSON cost of `,"textSample":<value>` — the bytes a retained sample adds back
// to a record that would otherwise carry none.
const TEXT_SAMPLE_KEY_BYTES = ',"textSample":'.length;

// Which paths keep their display sample when the pair exceeds the cache value
// budget. Changed paths come first — they are what the workbench opens — then
// unchanged ones as package context, cheapest sample first inside each tier so
// the budget buys the most reviewable files. A path's two sides are always
// kept or dropped together: a half-sampled modification would render as a
// whole-file addition or deletion.
function retainedSamplePaths(payload: PublicPackageDiff, maxPayloadBytes: number): Set<string> {
  const retained = new Set<string>();
  const bare = JSON.stringify({
    ...payload,
    fromFiles: applySampleRetention(payload.fromFiles, retained),
    toFiles: applySampleRetention(payload.toFiles, retained),
    textSamplesOmitted: true,
  } satisfies PublicPackageDiff);
  let budget = maxPayloadBytes - utf8ByteLength(bare);
  if (budget <= 0) return retained;

  const changedPaths = new Set(
    payload.diff.filter((entry) => entry.status !== "unchanged").map((entry) => entry.path),
  );
  const candidates = sampleCandidates(payload, changedPaths);
  for (const candidate of candidates) {
    // Keep scanning past an unaffordable candidate: a cheaper one later in the
    // tier still fits, and skipping it would waste the remaining budget.
    if (candidate.bytes > budget) continue;
    budget -= candidate.bytes;
    retained.add(candidate.path);
  }
  return retained;
}

interface SampleCandidate {
  path: string;
  bytes: number;
  changed: boolean;
}

function sampleCandidates(
  payload: PublicPackageDiff,
  changedPaths: Set<string>,
): SampleCandidate[] {
  const byPath = new Map<string, SampleCandidate>();
  for (const file of [...payload.fromFiles, ...payload.toFiles]) {
    if (!file.textSample) continue;
    const bytes = utf8ByteLength(JSON.stringify(file.textSample)) + TEXT_SAMPLE_KEY_BYTES;
    const existing = byPath.get(file.path);
    if (existing) existing.bytes += bytes;
    else byPath.set(file.path, { path: file.path, bytes, changed: changedPaths.has(file.path) });
  }
  return [...byPath.values()].sort(
    (a, b) =>
      Number(b.changed) - Number(a.changed) || a.bytes - b.bytes || a.path.localeCompare(b.path),
  );
}

function applySampleRetention(files: FileRecord[], retained: Set<string>): FileRecord[] {
  return files.map((file) => {
    if (!file.textSample || retained.has(file.path)) return file;
    const { textSample: _omitted, ...rest } = file;
    return {
      ...rest,
      flags: rest.flags.includes(SAMPLE_OMITTED_FLAG)
        ? rest.flags
        : [...rest.flags, SAMPLE_OMITTED_FLAG],
    };
  });
}

function publicDiffColoCacheRequest(key: string): Request {
  return new Request(`${COLO_CACHE_ORIGIN}${encodeURIComponent(key)}`);
}

function coloCache(): Cache {
  return (caches as unknown as { default: Cache }).default;
}

async function readPublicDiffColoCache(key: string): Promise<PublicPackageDiff | null> {
  try {
    const response = await coloCache().match(publicDiffColoCacheRequest(key));
    if (!response) return null;
    return (await response.json()) as PublicPackageDiff;
  } catch {
    return null;
  }
}

async function writePublicDiffColoCache(
  key: string,
  serialized: string,
  ttlSeconds: number = CACHE_TTL_SECONDS,
): Promise<void> {
  await coloCache().put(
    publicDiffColoCacheRequest(key),
    new Response(serialized, {
      headers: {
        "cache-control": `public, max-age=${ttlSeconds}, immutable`,
        "content-type": "application/json",
      },
    }),
  );
}

// Re-warms of the colo cache must not outlive the KV entry's own bound for
// mutable preview pairs.
function payloadCacheTtlSeconds(payload: PublicPackageDiff): number {
  return parsePkgPrNewUrl(payload.fromVersion) || parsePkgPrNewUrl(payload.toVersion)
    ? PREVIEW_CACHE_TTL_SECONDS
    : CACHE_TTL_SECONDS;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
