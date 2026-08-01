import { sha256Hex } from "../platform/crypto-utils";
import type { AiReview } from "../ai-review/types";
import { getPublicDiffAdapter } from "../ecosystems";
import { coloCache } from "../platform/http";
import { parsePkgPrNewUrl } from "../../../src/lib/pkg-pr-new";
import { PublicDiffError } from "./error";
import { writePublicDiffDisplayName } from "./display-metadata";
import type {
  PublicDiffAdapter,
  PublicDiffAttestation,
  PublicDiffInput,
  PublicDiffProvenanceEntry,
} from "./types";
import {
  annotateFindingsWithDiffStatus,
  applySampleRetention,
  createPackageDiff,
  redactFileRecords,
  redactFindings,
  redactJson,
  retainedSamplePaths,
  sampleCandidates,
  summarizePackageJsonDiff,
  type DiffEntry,
  type FileRecord,
  type Finding,
  type FindingDiffAnnotation,
  type PackageJsonDiff,
  type PackageJsonSummary,
} from "../review";
import { computeScanRiskBreakdown, type ScanRiskBreakdown } from "../review/risk";
// The budget arithmetic, the `sample-omitted` flag, and the byte counters live in
// `lib/review/sample-budget` and `lib/platform/json-size`: `lib/compare-cache`
// applies the same shedding to the authed compare payload.
import { utf8ByteLength } from "../platform/json-size";

export { PublicDiffError } from "./error";
export type { PublicDiffInput } from "./types";

/**
 * Resolve an ecosystem's public-diff capability, or fail the request. The
 * registry is the authority on which ecosystems `/diff` serves — routes
 * validate the query parameter against it rather than against a literal union.
 */
function requirePublicDiffAdapter(ecosystem: string): PublicDiffAdapter {
  const adapter = getPublicDiffAdapter(ecosystem);
  if (!adapter) throw new PublicDiffError("unsupported ecosystem", 400);
  return adapter;
}

// Anonymous, credential-free diff of two published versions of an npm, PyPI,
// or atpm package — or, on npm, of a pkg.pr.new preview tarball against a
// published version (fromVersion / toVersion may each be a validated
// pkg.pr.new URL). Reuses the scan pipeline's pure phases (package diff,
// deterministic rules, diff-status annotation, risk breakdown) over published
// artifacts instead of staged-vs-published. Findings run on raw text samples
// before redaction, like the scan pipeline, so secret detection keeps working;
// only redacted evidence is cached or returned.
export interface PublicPackageDiff {
  ecosystem: string;
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
  // How the reviewed bytes were located, for ecosystems where that is a chain
  // of independent authorities rather than a single registry (atpm).
  provenance?: PublicDiffProvenanceEntry[];
  // Whether the target version proves where it was built, and whether that
  // agrees with the publisher's own trusted-publishing declaration (atpm).
  attestation?: PublicDiffAttestation;
  // Human-facing spelling of `packageName`, when the canonical one is an atpm
  // DID rather than the readable verified handle. See PublicDiffVersionListing.
  displayName?: string;
  cachedAt: string;
  // Absolute freshness bound for mutable acquisition metadata. Cache rewarms
  // use the remaining lifetime rather than restarting the adapter's TTL.
  cacheExpiresAt?: string;
}

// Bump this when risk aggregation changes without a deterministic-rules bump.
const PUBLIC_DIFF_RISK_VERSION = "1";
// The payload and rules segments are per-ecosystem (`PublicDiffAdapter`) so one
// ecosystem's rules or payload bump cannot invalidate another's cached pairs.
function publicDiffCachePrefix(adapter: PublicDiffAdapter): string {
  return `public-diff:${adapter.payloadVersion}:${adapter.ecosystem}:rules=${adapter.rulesVersionSegment}:risk=${PUBLIC_DIFF_RISK_VERSION}:`;
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
  reviewerVersion: null,
};

export async function loadPublicPackageDiff(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  input: PublicDiffInput,
  // Reported before the payload is returned so callers can attribute cost:
  // /diff is the one surface where cache behaviour, not analysis time,
  // dominates what a visitor experiences.
  options: { onCacheOutcome?: (hit: boolean) => void } = {},
): Promise<PublicPackageDiff> {
  const adapter = requirePublicDiffAdapter(input.ecosystem);

  const cacheKey = await computePublicDiffCacheKey(input);
  const cached = await readPublicDiffCache(env, cacheKey);
  options.onCacheOutcome?.(Boolean(cached));
  if (cached) {
    await adapter.validateCachedPair?.(env, ctx, input);
    return cached;
  }

  const sources = await adapter.acquire(env, ctx, input);

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

  const cachedAtMs = Date.now();
  const cachedAt = new Date(cachedAtMs).toISOString();
  const cacheExpiresAt = mutablePayloadExpiry(adapter, sources.cacheExpiresAt, cachedAtMs);
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
    ...(sources.provenance?.length ? { provenance: sources.provenance } : {}),
    ...(sources.attestation ? { attestation: sources.attestation } : {}),
    ...(sources.displayName ? { displayName: sources.displayName } : {}),
    cachedAt,
    ...(cacheExpiresAt ? { cacheExpiresAt } : {}),
  };
  const ttlSeconds = payloadCacheTtlSeconds(payload);
  writePublicDiffDisplayName(
    env,
    ctx,
    cacheKey,
    payload.displayName,
    ttlSeconds,
    payload.cacheExpiresAt,
  );
  await writePublicDiffCache(env, cacheKey, payload, { ttlSeconds });
  return payload;
}

export async function computePublicDiffCacheKey(input: {
  ecosystem: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  registryUrl: string;
}): Promise<string> {
  const adapter = requirePublicDiffAdapter(input.ecosystem);
  // Names the ecosystem treats as equivalent must share one cache entry (PyPI
  // is case- and separator-insensitive, so "Django" and "django" are one key).
  const packageName = adapter.normalizePackageName(input.packageName);
  const hex = await sha256Hex(
    `${input.ecosystem}|${input.registryUrl}|${packageName}|${input.fromVersion}|${input.toVersion}`,
  );
  return `${publicDiffCachePrefix(adapter)}${hex}`;
}

export async function readPublicDiffCache(
  env: Cloudflare.Env,
  key: string,
): Promise<PublicPackageDiff | null> {
  const coloCached = await readPublicDiffColoCache(key);
  if (coloCached && payloadCacheTtlSeconds(coloCached) > 0) return coloCached;
  if (!env.COMPARE_CACHE) return null;
  try {
    const cached = await env.COMPARE_CACHE.get<PublicPackageDiff>(key, {
      type: "json",
      cacheTtl: CACHE_READ_COLO_TTL_SECONDS,
    });
    if (cached) {
      const ttlSeconds = payloadCacheTtlSeconds(cached);
      if (ttlSeconds <= 0) return null;
      await writePublicDiffColoCache(key, JSON.stringify(cached), ttlSeconds);
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
  if (ttlSeconds <= 0) return;
  const serialized = serializePublicDiffCachePayload(payload);
  const writes: Promise<unknown>[] = [writePublicDiffColoCache(key, serialized, ttlSeconds)];
  if (
    env.COMPARE_CACHE &&
    ttlSeconds >= 60 &&
    utf8ByteLength(serialized) <= CACHE_MAX_PAYLOAD_BYTES
  ) {
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
  let serialized = JSON.stringify(payload);
  if (utf8ByteLength(serialized) <= maxPayloadBytes) return serialized;
  // Drop the reference before building anything else: for the pairs that reach
  // this branch the discarded string is ~20 MiB, and the Worker still holds
  // both parsed sides. Holding it while the reduced payload is built is what
  // pushes peak memory past the isolate limit.
  serialized = "";

  // Metadata-only floor. Doubles as the fallback below, so it is built once
  // rather than re-serialized.
  const bare = JSON.stringify(bareSamplePayload(payload));
  const budget = maxPayloadBytes - utf8ByteLength(bare);
  if (budget <= 0) return bare;

  // Oversized pair: cache a reduced sample set so repeat views stay cheap
  // without blanking the workbench. Dropping every sample used to leave large
  // releases (a numpy wheel pair carries ~20 MiB of Python text) rendering
  // "No text samples available to diff." on every file, including the handful
  // that actually changed — the only ones a reviewer opens.
  const retained = retainedSamplePaths(
    sampleCandidates([payload.fromFiles, payload.toFiles], changedPathsIn(payload)),
    budget,
    UNCHANGED_SAMPLE_BUDGET_BYTES,
  );
  if (!retained.size) return bare;

  const reduced = JSON.stringify({
    ...payload,
    fromFiles: applySampleRetention(payload.fromFiles, retained),
    toFiles: applySampleRetention(payload.toFiles, retained),
    textSamplesOmitted: true,
  } satisfies PublicPackageDiff);
  // Selection works from per-path cost arithmetic rather than a trial
  // serialization, so confirm the real payload fits before committing to it.
  return utf8ByteLength(reduced) <= maxPayloadBytes ? reduced : bare;
}

// How much of the budget unchanged files may claim once a pair is over it.
// Every file navigation re-reads and re-parses the whole cached payload, so a
// degraded payload that fills the full 20 MiB would trade one broken workbench
// for a slow one. Changed files are what the workbench opens and are not
// subject to this cap; unchanged bodies are best-effort package context.
const UNCHANGED_SAMPLE_BUDGET_BYTES = 2 * 1024 * 1024;

function bareSamplePayload(payload: PublicPackageDiff): PublicPackageDiff {
  return {
    ...payload,
    fromFiles: applySampleRetention(payload.fromFiles, new Set()),
    toFiles: applySampleRetention(payload.toFiles, new Set()),
    textSamplesOmitted: true,
  };
}

// A path's two sides are always kept or dropped together (sampleCandidates keys
// by path across both lists): a half-sampled modification would render as a
// whole-file addition or deletion.
function changedPathsIn(payload: PublicPackageDiff): Set<string> {
  return new Set(
    payload.diff.filter((entry) => entry.status !== "unchanged").map((entry) => entry.path),
  );
}

function publicDiffColoCacheRequest(key: string): Request {
  return new Request(`${COLO_CACHE_ORIGIN}${encodeURIComponent(key)}`);
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
  if (ttlSeconds <= 0) return;
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
// mutable preview pairs or an adapter's mutable resolution metadata.
export function payloadCacheTtlSeconds(
  payload: PublicPackageDiff,
  nowMs: number = Date.now(),
): number {
  const adapterTtl = getPublicDiffAdapter(payload.ecosystem)?.cacheTtlSeconds ?? CACHE_TTL_SECONDS;
  const pairTtl =
    parsePkgPrNewUrl(payload.fromVersion) || parsePkgPrNewUrl(payload.toVersion)
      ? PREVIEW_CACHE_TTL_SECONDS
      : CACHE_TTL_SECONDS;
  const maximum = Math.min(adapterTtl, pairTtl);
  // Mutable adapters must carry the original acquisition deadline. Failing
  // closed here also prevents an old payload shape from regaining a fresh TTL.
  if (getPublicDiffAdapter(payload.ecosystem)?.cacheTtlSeconds !== undefined) {
    if (!payload.cacheExpiresAt) return 0;
    return remainingCacheTtlSeconds(payload.cacheExpiresAt, maximum, nowMs);
  }
  return maximum;
}

/** Bound an absolute deadline by a cache layer's own maximum lifetime. */
export function remainingCacheTtlSeconds(
  expiresAt: string | undefined,
  maximumSeconds: number,
  nowMs: number = Date.now(),
): number {
  if (!expiresAt) return maximumSeconds;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return 0;
  return Math.max(0, Math.min(maximumSeconds, Math.floor((expiresAtMs - nowMs) / 1000)));
}

function mutablePayloadExpiry(
  adapter: PublicDiffAdapter,
  sourceExpiresAt: string | undefined,
  nowMs: number,
): string | undefined {
  if (adapter.cacheTtlSeconds === undefined) return undefined;
  const adapterExpiresAtMs = nowMs + adapter.cacheTtlSeconds * 1000;
  const sourceExpiresAtMs = sourceExpiresAt ? Date.parse(sourceExpiresAt) : Number.NaN;
  if (sourceExpiresAt !== undefined && !Number.isFinite(sourceExpiresAtMs)) {
    return new Date(nowMs).toISOString();
  }
  return new Date(
    Number.isFinite(sourceExpiresAtMs)
      ? Math.min(adapterExpiresAtMs, sourceExpiresAtMs)
      : adapterExpiresAtMs,
  ).toISOString();
}
