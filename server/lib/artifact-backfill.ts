import {
  listScanArtifactBackfillCandidates,
  markScanArtifactBacked,
  type AppDb,
  type ScanArtifactBackfillCandidate,
} from "../db";
import {
  buildBackfillArtifactBundle,
  scanArtifactFileSamples,
  ScanArtifactError,
  writeScanArtifact,
} from "./scan-artifacts";
import { describeOperationalError, emitOperationalEvent } from "./observability";

export const DEFAULT_ARTIFACT_BACKFILL_BATCH = 25;

const ENABLED_VALUES = new Set(["1", "true", "on", "yes"]);

/**
 * Backfill is the migration's resumable catch-up phase and stays off until an
 * operator opts in. Flipping `ARTIFACT_BACKFILL` back off (or unbinding
 * `ARTIFACTS`) is the rollback toggle: the sweep returns early and never touches
 * R2 or D1.
 */
export function artifactBackfillEnabled(env: Cloudflare.Env): boolean {
  const flag = env.ARTIFACT_BACKFILL;
  return typeof flag === "string" && ENABLED_VALUES.has(flag.trim().toLowerCase());
}

export interface ArtifactBackfillSweepOptions {
  batchSize?: number;
}

export interface ArtifactBackfillSweepResult {
  considered: number;
  written: number;
  failed: number;
}

/**
 * Write one batch of un-backfilled completed scans to R2. Idempotent: a
 * successful write marks the row artifact-backed, removing it from the next
 * sweep's candidate set, so repeated runs converge without double-writing.
 * Backfill bundles carry `report.payload = null` (the original canonical report
 * predates R2 and cannot be rebuilt), so they are verified by byte digest only.
 */
export async function runArtifactBackfillSweep(
  env: Cloudflare.Env,
  db: AppDb,
  options: ArtifactBackfillSweepOptions = {},
): Promise<ArtifactBackfillSweepResult> {
  const result: ArtifactBackfillSweepResult = { considered: 0, written: 0, failed: 0 };
  const bucket = env.ARTIFACTS;
  if (!bucket || !artifactBackfillEnabled(env)) return result;

  const batchSize = options.batchSize ?? DEFAULT_ARTIFACT_BACKFILL_BATCH;
  const candidates = await listScanArtifactBackfillCandidates(db, batchSize);
  result.considered = candidates.length;
  if (!candidates.length) return result;

  for (const candidate of candidates) {
    try {
      await backfillScanArtifact(bucket, db, candidate);
      result.written += 1;
    } catch (err) {
      result.failed += 1;
      emitOperationalEvent("error", "scan.artifact.backfill_failed", {
        scanId: candidate.id,
        organizationId: candidate.organizationId,
        code: err instanceof ScanArtifactError ? err.code : undefined,
        error: describeOperationalError(err),
      });
    }
  }

  emitOperationalEvent("info", "scan.artifact.backfill_sweep", {
    considered: result.considered,
    written: result.written,
    failed: result.failed,
  });
  return result;
}

async function backfillScanArtifact(
  bucket: R2Bucket,
  db: AppDb,
  candidate: ScanArtifactBackfillCandidate,
): Promise<void> {
  const bundle = buildBackfillArtifactBundle({
    scanId: candidate.id,
    organizationId: candidate.organizationId,
    reportVersion: candidate.reportVersion,
    reportDigest: candidate.reportDigest,
    summary: candidate.summaryJson,
    fileSamples: scanArtifactFileSamples(candidate.files),
  });
  const written = await writeScanArtifact(bucket, bundle);
  await markScanArtifactBacked(db, {
    scanId: candidate.id,
    organizationId: candidate.organizationId,
    storageVersion: written.storageVersion,
    key: written.key,
    digest: written.digest,
    size: written.size,
  });
}
