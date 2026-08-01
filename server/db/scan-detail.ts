/**
 * Reading one scan back out.
 *
 * D1 holds the scan's metadata row and its events; the body — file metadata,
 * redacted samples, diff, and findings — is read from the digest-verified R2
 * artifact set. There is no D1 copy to fall back to, so a scan whose artifacts
 * cannot be read degrades to metadata only (empty files/findings) rather than
 * failing: the risk summary and the summary-embedded diff still render.
 */
import { and, asc, eq, getTableColumns } from "drizzle-orm";
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

// The release-memory profile is internal maintenance data and can be large.
// Ordinary detail/file/compare reads do not need it, so omit it in SQL.
const { findingProfileJson: _findingProfileJsonColumn, ...scanReadColumns } =
  getTableColumns(scans);

/**
 * How much of the scan body a `getScan` caller needs:
 * - `samples` (default) — every artifact; file rows carry their redacted text
 *   samples. The workbench detail view.
 * - `list` — file metadata and findings from report.json alone, samples
 *   stripped. One R2 read; the cheapest mode.
 * - `omit` — full report/diff fidelity (so `findings` and their `diffStatus`
 *   are byte-identical to `samples`) while skipping the file-samples artifact
 *   entirely. For callers that serialize the report and never read `files`.
 *
 * Omitting `artifactBucket` skips the R2 read entirely: `files` and `findings`
 * come back empty and only the scan row, its events, and the summary-derived
 * risk breakdown are populated. That is deliberate for callers that need
 * identity/status alone (existence checks, notifications, gate decisions) — but
 * it means a caller that reads `findings` must pass the bucket.
 */
export type ScanDetailFileMode = "samples" | "list" | "omit";

export async function getScan(
  db: AppDb,
  id: string,
  organizationId: string,
  artifactBucket?: R2Bucket,
  options: { files?: ScanDetailFileMode } = {},
) {
  const [scanRows, events] = await Promise.all([
    db
      .select(scanReadColumns)
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
  // `list` needs only the file metadata the report already carries, so it reads
  // report.json alone; the other modes read the full artifact set.
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
    // The authoritative full diff lives in R2; summary_json may contain only
    // the compact release delta for artifact-backed scans.
    diff: artifactDetail?.diff ?? null,
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
    .select(scanReadColumns)
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
    .select(scanReadColumns)
    .from(scans)
    .where(and(eq(scans.id, id), eq(scans.organizationId, organizationId)))
    .limit(1);
  if (!scan) return null;
  // Metadata only: the compare view rebuilds both sides' bodies from the
  // registry archives it fetches, and only needs this scan's file list and
  // findings to annotate them.
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
