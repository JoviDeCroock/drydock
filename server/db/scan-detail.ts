/**
 * Reading one scan back out.
 *
 * Scan bodies live in two places: new artifact-backed scans keep files/findings
 * in R2, while legacy or degraded scans can retain them in D1. These readers
 * hide that split — callers ask for a scan detail and get the same shape either
 * way, with artifact rows merged over whatever D1 still holds.
 */
import { and, asc, eq, getTableColumns } from "drizzle-orm";
import {
  annotateFindingsWithDiffStatus,
  type FindingDiffAnnotation,
  normalizeFindingDiffStatus,
} from "../lib/review";
import {
  loadScanArtifactFile,
  loadScanArtifactMetadata,
  loadScanArtifacts,
  type ScanArtifactFileRow,
} from "../lib/scan/artifacts";
import type { AppDb } from "./client";
import { redactScanEventForClient } from "./events";
import { computeRiskSummary, readPersistedRiskBreakdown } from "./scan-risk";
import { scanEvents, scanFiles, scanFindings, scans } from "./schema";

// Internal scan-maintenance columns never belong in ordinary detail/file/compare
// reads: `finding_profile_json` is a release-memory lookup cache up to 256 KiB,
// while the retention lease is orchestration state. Omit them in SQL rather than
// reading them only to strip them from the response afterward. Their owning
// queries select them explicitly.
const {
  findingProfileJson: _findingProfileJsonColumn,
  retentionClaimToken: _retentionClaimTokenColumn,
  retentionClaimedAt: _retentionClaimedAtColumn,
  ...scanReadColumns
} = getTableColumns(scans);
type ScanReadRow = Omit<
  typeof scans.$inferSelect,
  "findingProfileJson" | "retentionClaimToken" | "retentionClaimedAt"
>;

/**
 * How much of the file table a `getScan` caller needs:
 * - `samples` (default) — every artifact, file rows carry their redacted text
 *   samples. The workbench detail view.
 * - `list` — metadata only, and the artifacts are read only when D1 alone is
 *   short (`needsArtifactMetadataFallback`). The cheapest mode; note it can
 *   leave `findings` sourced from D1 rather than report.json.
 * - `omit` — full report/diff fidelity (so `findings` and their `diffStatus`
 *   are byte-identical to `samples`) while skipping the file-samples artifact
 *   entirely. For callers that serialize the report and never read `files`.
 */
export type ScanDetailFileMode = "samples" | "list" | "omit";

export async function getScan(
  db: AppDb,
  id: string,
  organizationId: string,
  artifactBucket?: R2Bucket,
  options: { files?: ScanDetailFileMode } = {},
) {
  const [scanRows, files, findings, events] = await Promise.all([
    db
      .select(scanReadColumns)
      .from(scans)
      .where(and(eq(scans.id, id), eq(scans.organizationId, organizationId)))
      .limit(1),
    db.select().from(scanFiles).where(eq(scanFiles.scanId, id)),
    db.select().from(scanFindings).where(eq(scanFindings.scanId, id)),
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
      ? needsArtifactMetadataFallback(scan, files, findings)
        ? await loadScanArtifactMetadata(artifactBucket, scan)
        : null
      : await loadScanArtifacts(artifactBucket, scan, {
          includeFileSamples: fileMode === "samples",
        });
  const detailFiles = artifactDetail ? mergeArtifactFiles(files, artifactDetail.files, id) : files;
  const responseFiles =
    fileMode === "samples" ? detailFiles : detailFiles.map(stripFileSampleForList);
  const diff = artifactDetail?.diff ?? diffForFindingAnnotations(scan.summaryJson, detailFiles);
  const findingRows = artifactDetail ? artifactDetail.findings : findings;
  const annotatedFindings = annotateFindingsWithDiffStatus(findingRows, diff, {
    persistedAnnotations: artifactDetail
      ? artifactDetail.findingAnnotations
      : readFindingAnnotations(scan.summaryJson),
  });
  return {
    scan,
    files: responseFiles,
    findings: annotatedFindings,
    // The scan's file diff, sourced from R2 for artifact-backed scans. It used to
    // reach readers only through the full copy embedded in `summary_json`; that
    // embed is now compacted to the release delta for artifact-backed scans, so
    // the authoritative full diff travels here instead. Null for legacy/degraded
    // rows (their `summary.diff` is still the full copy) and for an artifact read
    // that failed closed — both cases leave readers on the summary embed.
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
  const [scanRows, fileRows] = await Promise.all([
    db
      .select(scanReadColumns)
      .from(scans)
      .where(and(eq(scans.id, id), eq(scans.organizationId, organizationId)))
      .limit(1),
    db
      .select()
      .from(scanFiles)
      .where(and(eq(scanFiles.scanId, id), eq(scanFiles.path, path)))
      .limit(1),
  ]);
  const scan = scanRows[0];
  if (!scan) return null;

  const file = fileRows[0] ?? null;
  const artifactFile = await loadScanArtifactFile(artifactBucket, scan, path);
  if (!file && !artifactFile) return null;
  if (!artifactFile) return file;
  return mergeArtifactFiles(file ? [file] : [], [artifactFile], id)[0] ?? null;
}

/**
 * Single indexed row read for the poll path (`GET /api/v1/scans/:id/status`)
 * and for routes that only need the scan's identity.
 *
 * Deliberately a column projection rather than `select()`: the JSON blobs on the
 * row (`summary_json`, `ai_json`, `error_json`, and `finding_profile_json`) carry
 * compacted diff/review data that can still make a completed scan's row large —
 * and the poll that observes the terminal transition would otherwise ship all
 * of it, only for the client to immediately fetch the full detail anyway.
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
  const [scanRows, files, findings] = await Promise.all([
    db
      .select(scanReadColumns)
      .from(scans)
      .where(and(eq(scans.id, id), eq(scans.organizationId, organizationId)))
      .limit(1),
    db.select().from(scanFiles).where(eq(scanFiles.scanId, id)),
    db.select().from(scanFindings).where(eq(scanFindings.scanId, id)),
  ]);
  const scan = scanRows[0];
  if (!scan) return null;
  const artifactDetail = needsArtifactMetadataFallback(scan, files, findings)
    ? await loadScanArtifactMetadata(artifactBucket, scan)
    : null;
  const detailFiles = artifactDetail ? mergeArtifactFiles(files, artifactDetail.files, id) : files;
  const findingRows = artifactDetail ? artifactDetail.findings : findings;
  return { scan, files: detailFiles.map(stripFileSampleForList), findings: findingRows };
}

function needsArtifactMetadataFallback(
  scan: ScanReadRow,
  files: Array<typeof scanFiles.$inferSelect>,
  findings: Array<typeof scanFindings.$inferSelect>,
): boolean {
  if (!hasArtifactReferences(scan)) return false;
  if (files.length === 0) return true;
  return typeof scan.findingCount === "number" && findings.length < scan.findingCount;
}

function hasArtifactReferences(scan: ScanReadRow): boolean {
  return (
    scan.artifactStorageVersion !== null &&
    scan.artifactManifestKey !== null &&
    scan.artifactManifestDigest !== null &&
    scan.artifactManifestSize !== null &&
    scan.reportArtifactKey !== null &&
    scan.fileSamplesArtifactKey !== null &&
    scan.diffArtifactKey !== null
  );
}

function stripFileSampleForList<T extends { textSample: string | null }>(file: T): T {
  return file.textSample === null ? file : { ...file, textSample: null };
}

function mergeArtifactFiles(
  d1Files: (typeof scanFiles.$inferSelect)[],
  artifactFiles: ScanArtifactFileRow[],
  scanId: string,
): (typeof scanFiles.$inferSelect)[] {
  const d1ByPath = new Map(d1Files.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const merged = artifactFiles.map((file) => {
    seen.add(file.path);
    const d1 = d1ByPath.get(file.path);
    return {
      id: d1?.id ?? `${scanId}:${file.path}`,
      scanId: d1?.scanId ?? scanId,
      path: file.path,
      status: d1?.status ?? file.status,
      size: d1?.size ?? file.size,
      sha256: d1?.sha256 ?? file.sha256,
      flagsJson: d1?.flagsJson ?? file.flagsJson,
      textSample: file.textSample ?? d1?.textSample ?? null,
    };
  });
  for (const file of d1Files) {
    if (!seen.has(file.path)) merged.push(file);
  }
  return merged;
}

function readFindingAnnotations(summaryJson: unknown): Map<string, FindingDiffAnnotation> {
  const summary = summaryJson && typeof summaryJson === "object" ? summaryJson : null;
  const annotations =
    summary && !Array.isArray(summary)
      ? (summary as { findingAnnotations?: unknown }).findingAnnotations
      : null;
  const out = new Map<string, FindingDiffAnnotation>();
  if (!Array.isArray(annotations)) return out;
  for (const annotation of annotations) {
    if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)) continue;
    const id = (annotation as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    const diffStatus = normalizeFindingDiffStatus(
      (annotation as { diffStatus?: unknown }).diffStatus,
    );
    out.set(id, {
      diffStatus,
      releaseDelta: Boolean((annotation as { releaseDelta?: unknown }).releaseDelta),
    });
  }
  return out;
}

function diffForFindingAnnotations(
  summaryJson: unknown,
  files: Array<{ path: string; status: string }>,
): Array<{ path: string; status: string }> {
  const summary = summaryJson && typeof summaryJson === "object" ? summaryJson : null;
  const diff = summary && !Array.isArray(summary) ? (summary as { diff?: unknown }).diff : null;
  if (Array.isArray(diff)) {
    const entries = diff.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const path = (entry as { path?: unknown }).path;
      if (typeof path !== "string") return [];
      return [{ path, status: normalizeFindingDiffStatus((entry as { status?: unknown }).status) }];
    });
    if (entries.length) return entries;
  }
  return files.map((file) => ({
    path: file.path,
    status: normalizeFindingDiffStatus(file.status),
  }));
}
