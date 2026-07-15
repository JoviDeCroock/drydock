import type { AiReview } from "./ai-review-types";
import { buildNpmFindings } from "./adapters/npm/findings";
import {
  computeCompareMetadataCacheKey,
  readCompareMetadataCache,
  writeCompareMetadataCache,
} from "./compare-cache";
import { downloadPublishedTarball, isPublishedTarballUrlAllowed } from "./published-tarball";
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

// Anonymous, credential-free diff of two published npm versions. Reuses the
// scan pipeline's pure phases (package diff, deterministic rules, diff-status
// annotation, risk breakdown) over two published tarballs instead of
// staged-vs-published. Findings run on raw text samples before redaction, like
// the scan pipeline, so secret detection keeps working; only redacted evidence
// is cached or returned.
export interface PublicPackageDiff {
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
  textSamplesOmitted?: boolean;
  cachedAt: string;
}

export class PublicDiffError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 413 | 502,
  ) {
    super(message);
    this.name = "PublicDiffError";
  }
}

// Bump this when risk aggregation changes without a deterministic-rules bump.
const PUBLIC_DIFF_RISK_VERSION = "1";
const CACHE_PREFIX = `public-diff:v2:rules=${DETERMINISTIC_RULES_VERSION}:risk=${PUBLIC_DIFF_RISK_VERSION}:`;
// Package bytes are immutable, while the analysis version is encoded above.
// The TTL therefore bounds storage rather than correctness.
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
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
  input: {
    packageName: string;
    fromVersion: string;
    toVersion: string;
    registryUrl: string;
    allowInsecureLocalhost?: boolean;
  },
): Promise<PublicPackageDiff> {
  const cacheKey = await computePublicDiffCacheKey(input);
  const cached = await readPublicDiffCache(env, cacheKey);
  if (cached) return cached;

  const metadata = await fetchPublicPackageMetadata(env, ctx, input.packageName, input.registryUrl);
  const fromTarballUrl = metadata.versions?.[input.fromVersion]?.dist?.tarball;
  const toTarballUrl = metadata.versions?.[input.toVersion]?.dist?.tarball;
  if (!fromTarballUrl || !toTarballUrl) {
    throw new PublicDiffError("unknown version", 404);
  }
  for (const tarballUrl of [fromTarballUrl, toTarballUrl]) {
    if (
      !isPublishedTarballUrlAllowed(
        tarballUrl,
        input.registryUrl,
        input.allowInsecureLocalhost ?? false,
      )
    ) {
      throw new PublicDiffError("registry returned an unexpected tarball URL", 502);
    }
  }

  const [fromArchive, toArchive] = await Promise.all([
    downloadArchive(env, ctx, fromTarballUrl, input),
    downloadArchive(env, ctx, toTarballUrl, input),
  ]);

  const fileDiff = createPackageDiff(fromArchive.files, toArchive.files);
  const manifestDiff = redactJson(
    summarizePackageJsonDiff(fromArchive.packageJson, toArchive.packageJson),
  );
  const toManifestText =
    toArchive.files.find((file) => file.path === "package.json")?.textSample ?? null;

  const ruleFindings = redactFindings(
    buildNpmFindings({
      staged: {
        files: toArchive.files,
        manifest: toArchive.packageJson ?? null,
        suspiciousTarEntries: toArchive.suspiciousEntries,
      },
      details: null,
      fileDiff,
      manifestDiff,
      stagedManifestText: toManifestText,
    }),
  );

  const redactedFromFiles = redactFileRecords(fromArchive.files);
  const redactedToFiles = redactFileRecords(toArchive.files);
  const findings = annotateFindingsWithDiffStatus(ruleFindings, fileDiff, {
    previousFiles: redactedFromFiles,
    stagedFiles: redactedToFiles,
  });
  const risk = computeScanRiskBreakdown(findings, AI_REVIEW_DISABLED);

  const payload: PublicPackageDiff = {
    packageName: input.packageName,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    fromPackageJson: redactJson(fromArchive.packageJson ?? null),
    toPackageJson: redactJson(toArchive.packageJson ?? null),
    fromFiles: redactedFromFiles,
    toFiles: redactedToFiles,
    diff: fileDiff,
    packageJsonDiff: manifestDiff,
    findings,
    risk,
    cachedAt: new Date().toISOString(),
  };
  await writePublicDiffCache(env, cacheKey, payload);
  return payload;
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
    const detail = parseSandboxErrorDetail(err);
    if (detail?.status === 413) {
      throw new PublicDiffError("package is too large to diff", 413);
    }
    throw new PublicDiffError("package download failed", 502);
  }
}

export async function computePublicDiffCacheKey(input: {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  registryUrl: string;
}): Promise<string> {
  const data = new TextEncoder().encode(
    `${input.registryUrl}|${input.packageName}|${input.fromVersion}|${input.toVersion}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${CACHE_PREFIX}${hex}`;
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
    if (cached) await writePublicDiffColoCache(key, JSON.stringify(cached));
    return cached;
  } catch {
    return null;
  }
}

export async function writePublicDiffCache(
  env: Cloudflare.Env,
  key: string,
  payload: PublicPackageDiff,
): Promise<void> {
  const serialized = serializePublicDiffCachePayload(payload);
  const writes: Promise<unknown>[] = [writePublicDiffColoCache(key, serialized)];
  if (env.COMPARE_CACHE && utf8ByteLength(serialized) <= CACHE_MAX_PAYLOAD_BYTES) {
    writes.push(
      env.COMPARE_CACHE.put(key, serialized, {
        expirationTtl: CACHE_TTL_SECONDS,
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

  // Rare oversized pair: cache without samples so repeat views stay cheap.
  // The per-file endpoint then reports samples as unavailable instead of
  // recomputing two archive parses per file view.
  serialized = JSON.stringify({
    ...payload,
    fromFiles: stripSamples(payload.fromFiles),
    toFiles: stripSamples(payload.toFiles),
    textSamplesOmitted: true,
  } satisfies PublicPackageDiff);
  return serialized;
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

async function writePublicDiffColoCache(key: string, serialized: string): Promise<void> {
  await coloCache().put(
    publicDiffColoCacheRequest(key),
    new Response(serialized, {
      headers: {
        "cache-control": `public, max-age=${CACHE_TTL_SECONDS}, immutable`,
        "content-type": "application/json",
      },
    }),
  );
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function stripSamples(files: FileRecord[]): FileRecord[] {
  return files.map(({ textSample: _omitted, ...rest }) => rest);
}
