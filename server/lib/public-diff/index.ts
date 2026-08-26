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
  createPackageDiff,
  diffCapabilities,
  projectCapabilities,
  redactFileRecords,
  redactFindings,
  redactJson,
  summarizePackageJsonDiff,
  type CapabilityDelta,
  type DiffEntry,
  type FileRecord,
  type Finding,
  type FindingDiffAnnotation,
  type PackageJsonDiff,
  type PackageJsonSummary,
} from "../review";
import { extractDeclaredRepository, normalizeRepositoryUrl } from "../intent-envelope";
import { computeScanRiskBreakdown, type ScanRiskBreakdown } from "../review/risk";

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
  // Advisory per-side capability sets and their cross-version delta. Derived
  // from the same pattern sets the deterministic rules match; never feeds the
  // findings or risk above.
  capabilities: CapabilityDelta;
  // Registry publication timestamps per side, when the ecosystem has them.
  // The verdict projection turns these into the release-age signal.
  fromPublishedAt?: string;
  toPublishedAt?: string;
  // Declared-tier source binding per side (repository the manifest/metadata
  // claims, normalized). `changed` marks a repository move between versions —
  // itself a signal. Never verified on the anonymous plane.
  sourceBinding: {
    from: string | null;
    to: string | null;
    changed: boolean;
  };
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
  const fromPackageJson = redactJson(sources.from.packageJson);
  const toPackageJson = redactJson(sources.to.packageJson);
  // Projected before the cache-size sample reduction below, so a payload whose
  // samples were dropped still carries the capability sets computed over them.
  const capabilities = diffCapabilities(
    sources.hasComparableBaseline !== false
      ? projectCapabilities(redactedFromFiles, fromPackageJson, sources.codePatternSet)
      : null,
    projectCapabilities(redactedToFiles, toPackageJson, sources.codePatternSet),
  );
  const fromRepository = declaredSideRepository(sources.from);
  const toRepository = declaredSideRepository(sources.to);

  const cachedAtMs = Date.now();
  const cachedAt = new Date(cachedAtMs).toISOString();
  const cacheExpiresAt = mutablePayloadExpiry(adapter, sources.cacheExpiresAt, cachedAtMs);
  const payload: PublicPackageDiff = {
    ecosystem: input.ecosystem,
    packageName: input.packageName,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    fromPackageJson,
    toPackageJson,
    fromFiles: redactedFromFiles,
    toFiles: redactedToFiles,
    diff: fileDiff,
    packageJsonDiff: manifestDiff,
    findings,
    risk,
    capabilities,
    ...(sources.from.publishedAt ? { fromPublishedAt: sources.from.publishedAt } : {}),
    ...(sources.to.publishedAt ? { toPublishedAt: sources.to.publishedAt } : {}),
    sourceBinding: {
      from: fromRepository,
      to: toRepository,
      changed: fromRepository !== null && toRepository !== null && fromRepository !== toRepository,
    },
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

// Declared-tier source binding for one side: the repository the package's own
// manifest (or PyPI core metadata) claims, normalized to a bounded canonical
// URL. Read off the raw acquired files — the sample-retention pass may later
// drop the manifest's text from the cached payload, so this cannot be
// projected on demand.
function declaredSideRepository(side: {
  files: FileRecord[];
  packageJson: PackageJsonSummary | null;
}): string | null {
  const manifestText = side.files.find((file) => file.path === "package.json")?.textSample ?? null;
  return normalizeRepositoryUrl(extractDeclaredRepository({ manifestText, files: side.files }));
}

/**
 * Full analysis identity of a payload this module computes: the ecosystem's
 * deterministic-rules segment plus the risk-aggregation version. The verdict
 * projection cites this so a consumer can tell two verdicts of the same pair
 * apart after a rules bump.
 */
export function publicDiffAnalysisVersion(
  adapter: Pick<PublicDiffAdapter, "rulesVersionSegment">,
): string {
  return `${adapter.rulesVersionSegment}+risk-${PUBLIC_DIFF_RISK_VERSION}`;
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
  const retained = retainedSamplePaths(payload, budget);
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

// Flags a record whose display sample was dropped to fit the cache budget, so
// the UI can say why the body is missing instead of implying the parser never
// captured one. Mirrored as a literal in src/components/DiffView.tsx alongside
// the parser's own flags.
export const SAMPLE_OMITTED_FLAG = "sample-omitted";

// JSON cost of `,"textSample":<value>` — the bytes a retained sample adds back
// to a record that would otherwise carry none.
const TEXT_SAMPLE_KEY_BYTES = ',"textSample":'.length;

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

// Which paths keep their display sample when the pair exceeds the cache value
// budget. Changed paths come first — they are what the workbench opens — then
// unchanged ones as package context under their own smaller cap, cheapest
// sample first inside each tier so the budget buys the most reviewable files.
// A path's two sides are always kept or dropped together: a half-sampled
// modification would render as a whole-file addition or deletion.
function retainedSamplePaths(payload: PublicPackageDiff, sampleBudget: number): Set<string> {
  const retained = new Set<string>();
  let budget = sampleBudget;
  let unchangedBudget = Math.min(budget, UNCHANGED_SAMPLE_BUDGET_BYTES);
  for (const candidate of sampleCandidates(payload)) {
    // Keep scanning past an unaffordable candidate rather than stopping: each
    // tier is cheapest-first, so only a later tier can still yield a fit.
    if (candidate.bytes > budget) continue;
    if (!candidate.changed) {
      if (candidate.bytes > unchangedBudget) continue;
      unchangedBudget -= candidate.bytes;
    }
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

function sampleCandidates(payload: PublicPackageDiff): SampleCandidate[] {
  const changedPaths = new Set(
    payload.diff.filter((entry) => entry.status !== "unchanged").map((entry) => entry.path),
  );
  const byPath = new Map<string, SampleCandidate>();
  for (const file of [...payload.fromFiles, ...payload.toFiles]) {
    if (!file.textSample) continue;
    const bytes = jsonStringByteLength(file.textSample) + TEXT_SAMPLE_KEY_BYTES;
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

// Counted rather than encoded: the strings measured here are the whole cache
// payload (tens of MiB for a large release), and `TextEncoder.encode` would
// allocate a throwaway buffer that size on a Worker isolate that is already
// holding both parsed sides of the diff. Exported for the equivalence tests
// that pin it to TextEncoder.
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(value.charCodeAt(index + 1))) {
      // Surrogate pair: one 4-byte code point across two UTF-16 units.
      bytes += 4;
      index++;
    } else {
      // Includes an unpaired surrogate, which encodes as U+FFFD (3 bytes).
      bytes += 3;
    }
  }
  return bytes;
}

// JSON.stringify's short escapes; every other control character becomes \u00XX.
const JSON_SHORT_ESCAPES = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d]);

// Bytes `JSON.stringify(value)` would produce for a string, quotes included,
// without building the escaped copy. Sample costs are summed over every file in
// the payload, so materializing each escaped body just to measure it would
// double the transient allocation of the whole reduction pass. Exported for the
// equivalence tests that pin it to JSON.stringify.
export function jsonStringByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20) bytes += JSON_SHORT_ESCAPES.has(code) ? 2 : 6;
    else if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(value.charCodeAt(index + 1))) {
      bytes += 4;
      index++;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      // Well-formed JSON.stringify escapes an unpaired surrogate as \udXXX.
      bytes += 6;
    } else bytes += 3;
  }
  return bytes;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
