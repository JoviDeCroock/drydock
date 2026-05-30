import { sha256Hex, stableJson } from "./canonical-json";

/**
 * R2-backed scan artifact storage.
 *
 * D1 stays the authoritative metadata/index store; the heavy derived evidence
 * (canonical report JSON, redacted diff, redacted staged file text samples) is
 * bundled into a single digest-verified R2 object per scan. The bundle is keyed
 * by organization + scan + storage version so retention and rollback stay simple.
 *
 * This module is intentionally free of D1/Drizzle imports: callers pass plain
 * data in and persist the returned key/digest/size metadata themselves. See
 * `docs/r2-artifacts.md`.
 */

export const SCAN_ARTIFACT_STORAGE_VERSION = 1;

export type ScanArtifactOrigin = "pipeline" | "backfill";

export interface ScanArtifactFileSample {
  path: string;
  textSample: string;
}

export interface ScanArtifactBundle {
  storageVersion: number;
  scanId: string;
  organizationId: string;
  origin: ScanArtifactOrigin;
  report: {
    version: number | null;
    digest: string | null;
    /**
     * Canonical report payload. Present for pipeline-origin bundles, where it is
     * reproducible and its digest must equal `report.digest`. `null` for
     * backfilled scans whose original payload predates R2 and cannot be rebuilt
     * from D1 — those bundles are verified by their byte digest only.
     */
    payload: unknown | null;
  };
  /** Snapshot of `scans.summary_json` (diff, packageJsonDiff, risk, baseline, safety). */
  summary: unknown;
  fileSamples: ScanArtifactFileSample[];
}

export type ScanArtifactErrorCode =
  | "artifact_readback_missing"
  | "artifact_digest_mismatch"
  | "report_digest_mismatch"
  | "artifact_malformed";

export class ScanArtifactError extends Error {
  constructor(
    public code: ScanArtifactErrorCode,
    public key: string,
  ) {
    super(`${code}: ${key}`);
    this.name = "ScanArtifactError";
  }
}

export function scanArtifactKey(
  organizationId: string,
  scanId: string,
  storageVersion: number = SCAN_ARTIFACT_STORAGE_VERSION,
): string {
  return `reports/${organizationId}/${scanId}/v${storageVersion}.json`;
}

/**
 * Project a set of file records down to the path + redacted text sample pairs
 * that are worth persisting. Files without a text sample carry no heavy payload
 * and are reconstructable from their D1 metadata row, so they are skipped.
 */
export function scanArtifactFileSamples(
  files: Array<{ path: string; textSample?: string | null }>,
): ScanArtifactFileSample[] {
  const samples: ScanArtifactFileSample[] = [];
  for (const file of files) {
    if (typeof file.textSample === "string" && file.textSample.length > 0) {
      samples.push({ path: file.path, textSample: file.textSample });
    }
  }
  return samples;
}

export interface BuildPipelineArtifactBundleInput {
  scanId: string;
  organizationId: string;
  reportVersion: number | null;
  reportDigest: string | null;
  reportPayload: unknown;
  summary: unknown;
  fileSamples: ScanArtifactFileSample[];
}

export function buildPipelineArtifactBundle(
  input: BuildPipelineArtifactBundleInput,
): ScanArtifactBundle {
  return {
    storageVersion: SCAN_ARTIFACT_STORAGE_VERSION,
    scanId: input.scanId,
    organizationId: input.organizationId,
    origin: "pipeline",
    report: {
      version: input.reportVersion,
      digest: input.reportDigest,
      payload: input.reportPayload,
    },
    summary: input.summary,
    fileSamples: input.fileSamples,
  };
}

export interface BuildBackfillArtifactBundleInput {
  scanId: string;
  organizationId: string;
  reportVersion: number | null;
  reportDigest: string | null;
  summary: unknown;
  fileSamples: ScanArtifactFileSample[];
}

export function buildBackfillArtifactBundle(
  input: BuildBackfillArtifactBundleInput,
): ScanArtifactBundle {
  return {
    storageVersion: SCAN_ARTIFACT_STORAGE_VERSION,
    scanId: input.scanId,
    organizationId: input.organizationId,
    origin: "backfill",
    report: {
      version: input.reportVersion,
      digest: input.reportDigest,
      payload: null,
    },
    summary: input.summary,
    fileSamples: input.fileSamples,
  };
}

export interface WriteScanArtifactResult {
  key: string;
  storageVersion: number;
  digest: string;
  size: number;
}

/**
 * Write the bundle to R2 and verify it before the caller marks the scan
 * artifact-backed. Verification re-reads the object (durability), recomputes the
 * byte digest (integrity), and — for pipeline bundles — re-derives the canonical
 * report digest so it provably matches the digest persisted in D1.
 */
export async function writeScanArtifact(
  bucket: R2Bucket,
  bundle: ScanArtifactBundle,
): Promise<WriteScanArtifactResult> {
  const key = scanArtifactKey(bundle.organizationId, bundle.scanId, bundle.storageVersion);
  const serialized = JSON.stringify(bundle);
  const bytes = new TextEncoder().encode(serialized);
  const digest = await sha256Hex(serialized);

  await bucket.put(key, bytes, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      scanId: bundle.scanId,
      organizationId: bundle.organizationId,
      storageVersion: String(bundle.storageVersion),
      origin: bundle.origin,
      digest,
    },
  });

  const readback = await bucket.get(key);
  if (!readback) throw new ScanArtifactError("artifact_readback_missing", key);
  const readbackDigest = await sha256Hex(await readback.text());
  if (readbackDigest !== digest) throw new ScanArtifactError("artifact_digest_mismatch", key);

  if (bundle.origin === "pipeline" && bundle.report.payload != null && bundle.report.digest) {
    const reportDigest = await sha256Hex(stableJson(bundle.report.payload));
    if (reportDigest !== bundle.report.digest) {
      throw new ScanArtifactError("report_digest_mismatch", key);
    }
  }

  return { key, storageVersion: bundle.storageVersion, digest, size: bytes.byteLength };
}

export interface ReadScanArtifactRef {
  key: string;
  /** `scans.artifact_digest`; when present the read is rejected on mismatch. */
  expectedDigest: string | null;
}

/**
 * Read and verify a bundle. Returns `null` when the object is absent (caller
 * should fall back to D1). Throws `ScanArtifactError` on digest mismatch or a
 * malformed payload so the caller can log the integrity failure and fall back.
 */
export async function readScanArtifact(
  bucket: R2Bucket,
  ref: ReadScanArtifactRef,
): Promise<ScanArtifactBundle | null> {
  const object = await bucket.get(ref.key);
  if (!object) return null;
  const text = await object.text();
  if (ref.expectedDigest) {
    const digest = await sha256Hex(text);
    if (digest !== ref.expectedDigest)
      throw new ScanArtifactError("artifact_digest_mismatch", ref.key);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ScanArtifactError("artifact_malformed", ref.key);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as ScanArtifactBundle).fileSamples)
  ) {
    throw new ScanArtifactError("artifact_malformed", ref.key);
  }
  return parsed as ScanArtifactBundle;
}

/** Map of file path → redacted text sample for hydrating D1 file rows on read. */
export function scanArtifactSampleMap(bundle: ScanArtifactBundle): Map<string, string> {
  const map = new Map<string, string>();
  for (const sample of bundle.fileSamples) {
    if (sample && typeof sample.path === "string" && typeof sample.textSample === "string") {
      map.set(sample.path, sample.textSample);
    }
  }
  return map;
}
