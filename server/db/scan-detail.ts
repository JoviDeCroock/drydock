import { and, asc, eq } from "drizzle-orm";
import { annotateFindingsWithDiffStatus } from "../lib/review";
import {
  loadScanArtifactFile,
  loadScanArtifactMetadata,
  loadScanArtifacts,
} from "../lib/scan/artifacts";
import type { AppDb } from "./client";
import { redactScanEventForClient } from "./events";
import { computeRiskSummary, readPersistedRiskBreakdown } from "./scan-risk";
import { scanEvents, scans } from "./schema";

export type ScanDetailFileMode = "samples" | "list" | "omit";

/**
 * What `omit` (the report-export mode) returns: the client-facing detail plus
 * the artifact's full-fidelity `diff`.
 *
 * The split is a type-level contract, not a convenience. The export document's
 * bytes are an attestation subject and `summary_json.diff` no longer carries
 * the content digests, so an export built from a `samples`/`list` detail would
 * silently fall back to the digest-free D1 copy and serialize to *different*
 * bytes than the ones already attested. `buildReportExport` takes a
 * `ScanExportDetail`, so that mistake is a compile error rather than an
 * attestation that stops verifying.
 */
export type ScanExportDetail = NonNullable<Awaited<ReturnType<typeof readScanDetail>>>;

/** What every other mode returns: the same detail without the export diff. */
export type ScanDetailView = Omit<ScanExportDetail, "diff">;

export function getScan(
  db: AppDb,
  id: string,
  organizationId: string,
  artifactBucket: R2Bucket | undefined,
  options: { files: "omit" },
): Promise<ScanExportDetail | null>;
export function getScan(
  db: AppDb,
  id: string,
  organizationId: string,
  artifactBucket?: R2Bucket,
  options?: { files?: "samples" | "list" },
): Promise<ScanDetailView | null>;
export function getScan(
  db: AppDb,
  id: string,
  organizationId: string,
  artifactBucket?: R2Bucket,
  options: { files?: ScanDetailFileMode } = {},
): Promise<ScanExportDetail | null> {
  return readScanDetail(db, id, organizationId, artifactBucket, options);
}

async function readScanDetail(
  db: AppDb,
  id: string,
  organizationId: string,
  artifactBucket?: R2Bucket,
  options: { files?: ScanDetailFileMode } = {},
) {
  const [scanRows, events] = await Promise.all([
    db
      .select()
      .from(scans)
      .where(and(eq(scans.id, id), eq(scans.organizationId, organizationId)))
      .limit(1),
    db
      .select()
      .from(scanEvents)
      .where(and(eq(scanEvents.scanId, id), eq(scanEvents.organizationId, organizationId)))
      .orderBy(asc(scanEvents.createdAt)),
  ]);
  const scan = scanRows[0];
  if (!scan) return null;
  const fileMode = options.files ?? "samples";
  const artifactDetail =
    fileMode === "list"
      ? await loadScanArtifactMetadata(artifactBucket, scan)
      : await loadScanArtifacts(artifactBucket, scan, {
          includeFileSamples: fileMode === "samples",
        });
  const responseFiles =
    fileMode === "samples"
      ? (artifactDetail?.files ?? [])
      : (artifactDetail?.files ?? []).map(stripFileSampleForList);
  const annotatedFindings = artifactDetail
    ? annotateFindingsWithDiffStatus(artifactDetail.findings, artifactDetail.diff, {
        persistedAnnotations: artifactDetail.findingAnnotations,
      })
    : [];
  return {
    scan,
    files: responseFiles,
    findings: annotatedFindings,
    // Surfaced to `omit` callers only (see `ScanExportDetail`): the
    // client-facing modes already carry every path's `sha256` on `files[]`, so
    // shipping it there would be a third copy of the same array in one response
    // body. Null on the degraded path — the export falls back to D1.
    diff: fileMode === "omit" ? (artifactDetail?.diff ?? null) : null,
    riskSummary:
      scan.status === "complete"
        ? computeRiskSummary(
            scan.risk,
            annotatedFindings,
            readPersistedRiskBreakdown(scan.summaryJson),
          )
        : null,
    events: events.map(redactScanEventForClient),
  };
}

export async function getScanFile(
  db: AppDb,
  id: string,
  organizationId: string,
  path: string,
  artifactBucket?: R2Bucket,
) {
  const [scan] = await db
    .select()
    .from(scans)
    .where(and(eq(scans.id, id), eq(scans.organizationId, organizationId)))
    .limit(1);
  if (!scan) return null;
  return loadScanArtifactFile(artifactBucket, scan, path);
}

/**
 * Single indexed row read for the poll path (`GET /api/v1/scans/:id/status`)
 * and for routes that only need the scan's identity.
 *
 * Deliberately a column projection rather than `select()`: the three JSON blobs
 * on the row (`summary_json`, `ai_json`, `error_json`) carry the whole file diff
 * and the AI review envelope, so a completed scan's row is large — and the poll
 * that observes the terminal transition would otherwise ship all of it, only
 * for the client to immediately fetch the full detail anyway.
 *
 * The projection is an allowlist, so it also drops the R2 artifact keys and the
 * public-share columns. That is safe for today's callers — the poll only holds
 * this row while the scan is `pending`/`running`, and the client re-fetches the
 * full detail on the terminal transition — but it means adding a column to
 * `scans` does NOT make it visible here. Anything needing a dropped column must
 * be added below or use `getScan`; reading it off this row yields `undefined`
 * without a type error, because the client types those fields optional.
 */
export async function getScanStatus(db: AppDb, id: string, organizationId: string) {
  const [scan] = await db
    .select({
      id: scans.id,
      stageId: scans.stageId,
      organizationId: scans.organizationId,
      ownerUserId: scans.ownerUserId,
      gateId: scans.gateId,
      packageName: scans.packageName,
      stagedVersion: scans.stagedVersion,
      previousVersion: scans.previousVersion,
      risk: scans.risk,
      status: scans.status,
      source: scans.source,
      decision: scans.decision,
      decisionReason: scans.decisionReason,
      decidedByUserId: scans.decidedByUserId,
      decidedAt: scans.decidedAt,
      changedFileCount: scans.changedFileCount,
      findingCount: scans.findingCount,
      riskSummaryJson: scans.riskSummaryJson,
      reportVersion: scans.reportVersion,
      reportDigest: scans.reportDigest,
      startedAt: scans.startedAt,
      completedAt: scans.completedAt,
      createdAt: scans.createdAt,
      updatedAt: scans.updatedAt,
    })
    .from(scans)
    .where(and(eq(scans.id, id), eq(scans.organizationId, organizationId)))
    .limit(1);
  return scan ?? null;
}

export async function getScanCompareData(
  db: AppDb,
  id: string,
  organizationId: string,
  artifactBucket?: R2Bucket,
) {
  const [scan] = await db
    .select()
    .from(scans)
    .where(and(eq(scans.id, id), eq(scans.organizationId, organizationId)))
    .limit(1);
  if (!scan) return null;
  const artifactDetail = await loadScanArtifactMetadata(artifactBucket, scan);
  return {
    scan,
    files: (artifactDetail?.files ?? []).map(stripFileSampleForList),
    findings: artifactDetail?.findings ?? [],
  };
}

function stripFileSampleForList<T extends { textSample: string | null }>(file: T): T {
  return file.textSample === null ? file : { ...file, textSample: null };
}
