/**
 * Writing a completed scan back to D1.
 *
 * persistScan is the only writer of scan results. It runs against a claim
 * token so a retried or duplicated queue delivery cannot overwrite a scan that
 * another attempt already completed: every insert is guarded by the claim
 * still being held, and files/findings go in batched to fit D1's parameter cap.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
  annotateFindingsWithDiffStatus,
  type CodePatternSet,
  type DiffEntry,
  type FileRecord,
  type Finding,
  type PackageJsonSummary,
} from "../lib/review";
import type { ScanRiskBreakdown } from "../lib/review/risk";
import { scanFileRowsForArtifacts, type ScanArtifactMetadata } from "../lib/scan/artifacts";
import type { AppDb } from "./client";
import { chunkForD1CompoundSelect } from "./d1-chunk";
import { NON_TERMINAL_STATUSES } from "./scan-jobs";
import {
  computeRiskSummary,
  countChangedFileEntries,
  readPersistedListRiskSummary,
} from "./scan-risk";
import { scanFiles, scanFindings, scans } from "./schema";

export interface PersistedScanInput {
  id: string;
  stageId: string;
  organizationId: string;
  ownerUserId: string;
  packageJson?: PackageJsonSummary | null;
  previousPackageJson?: PackageJsonSummary | null;
  risk: string;
  status: string;
  summary: unknown;
  ai: unknown;
  files: FileRecord[];
  previousFiles?: FileRecord[];
  diff: DiffEntry[];
  findings: Finding[];
  /**
   * Findings a completed AI review contributed, already projected into the
   * deterministic Finding shape (see mergeAiFindings). Persisted as
   * `scan_findings` rows with source "ai" so they count into `finding_count`
   * and the risk summary; the full review stays in `ai_json`.
   */
  aiFindingRecords?: Finding[];
  codePatternSet?: CodePatternSet;
  riskSummary?: ScanRiskBreakdown;
  report?: { version: number; digest: string };
  artifacts?: ScanArtifactMetadata | null;
}

export async function persistScan(db: AppDb, input: PersistedScanInput) {
  const now = new Date();
  const artifactFileRows = scanFileRowsForArtifacts(input.files, input.diff);
  const fileRows = artifactFileRows.map((file) => {
    return {
      id: crypto.randomUUID(),
      scanId: input.id,
      path: file.path,
      status: file.status,
      size: file.size,
      sha256: file.sha256,
      flagsJson: file.flagsJson,
      textSample: file.textSample,
    };
  });
  // Rule rows first, AI rows after them — the same order the report artifact's
  // findingAnnotations index over, so both stores agree on finding identity.
  const findingRows = [
    ...input.findings.map((finding) => ({ finding, source: "rule" })),
    ...(input.aiFindingRecords ?? []).map((finding) => ({ finding, source: "ai" })),
  ].map(({ finding, source }) => ({
    id: crypto.randomUUID(),
    scanId: input.id,
    severity: finding.severity,
    file: finding.file,
    evidence: finding.evidence,
    reason: finding.reason,
    line: finding.line ?? null,
    source,
    ruleId: finding.ruleId ?? null,
    ruleVersion: finding.ruleVersion ?? null,
  }));
  const annotatedFindings = annotateFindingsWithDiffStatus(findingRows, input.diff, {
    previousFiles: input.previousFiles ?? [],
    stagedFiles: input.files,
    codePatternSet: input.codePatternSet,
  });
  const findingAnnotations = annotatedFindings.map((finding) => ({
    id: finding.id,
    diffStatus: finding.diffStatus,
    releaseDelta: finding.releaseDelta,
  }));

  const isComplete = input.status === "complete";
  const changedFileCount = isComplete ? countChangedFileEntries(input.diff) : null;
  const findingCount = isComplete ? findingRows.length : null;
  const riskSummary: ScanRiskBreakdown | null = isComplete
    ? (input.riskSummary ??
      readPersistedListRiskSummary(input.summary) ??
      computeRiskSummary(input.risk, annotatedFindings))
    : null;

  const scanValues = {
    id: input.id,
    stageId: input.stageId,
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId,
    packageName: input.packageJson?.name || null,
    stagedVersion: input.packageJson?.version || null,
    previousVersion: input.previousPackageJson?.version || null,
    risk: input.risk,
    status: input.status,
    summaryJson: withFindingAnnotations(input.summary, findingAnnotations),
    aiJson: input.ai,
    errorJson: null,
    changedFileCount,
    findingCount,
    riskSummaryJson: riskSummary,
    reportVersion: input.report?.version ?? null,
    reportDigest: input.report?.digest ?? null,
    artifactStorageVersion: input.artifacts?.artifactStorageVersion ?? null,
    artifactManifestKey: input.artifacts?.artifactManifestKey ?? null,
    artifactManifestDigest: input.artifacts?.artifactManifestDigest ?? null,
    artifactManifestSize: input.artifacts?.artifactManifestSize ?? null,
    reportArtifactKey: input.artifacts?.reportArtifactKey ?? null,
    fileSamplesArtifactKey: input.artifacts?.fileSamplesArtifactKey ?? null,
    diffArtifactKey: input.artifacts?.diffArtifactKey ?? null,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  const claimToken = `persist:${crypto.randomUUID()}`;
  const existing = await db
    .select({ id: scans.id, status: scans.status, reportDigest: scans.reportDigest })
    .from(scans)
    .where(and(eq(scans.id, input.id), eq(scans.organizationId, input.organizationId)))
    .limit(1);
  if (existing[0] && !NON_TERMINAL_STATUSES.some((status) => status === existing[0]?.status)) {
    return { persisted: false, reason: "already_terminal" as const };
  }

  // D1 rejects SQL BEGIN/SAVEPOINT in Workers, so use a batch: D1 applies the
  // statements atomically. The temporary reportDigest token gates every child
  // mutation and is cleared by the final statement before the batch commits.
  const claimScan = existing[0]
    ? db
        .update(scans)
        .set({
          packageName: scanValues.packageName,
          stagedVersion: scanValues.stagedVersion,
          previousVersion: scanValues.previousVersion,
          risk: scanValues.risk,
          status: scanValues.status,
          summaryJson: scanValues.summaryJson,
          aiJson: scanValues.aiJson,
          errorJson: scanValues.errorJson,
          changedFileCount: scanValues.changedFileCount,
          findingCount: scanValues.findingCount,
          riskSummaryJson: scanValues.riskSummaryJson,
          reportVersion: scanValues.reportVersion,
          artifactStorageVersion: scanValues.artifactStorageVersion,
          artifactManifestKey: scanValues.artifactManifestKey,
          artifactManifestDigest: scanValues.artifactManifestDigest,
          artifactManifestSize: scanValues.artifactManifestSize,
          reportArtifactKey: scanValues.reportArtifactKey,
          fileSamplesArtifactKey: scanValues.fileSamplesArtifactKey,
          diffArtifactKey: scanValues.diffArtifactKey,
          completedAt: scanValues.completedAt,
          reportDigest: claimToken,
          updatedAt: now,
        })
        .where(
          and(
            eq(scans.id, input.id),
            eq(scans.organizationId, input.organizationId),
            inArray(scans.status, [...NON_TERMINAL_STATUSES]),
          ),
        )
        .returning({ id: scans.id })
    : db
        .insert(scans)
        .values({ ...scanValues, reportDigest: claimToken })
        .onConflictDoNothing({ target: scans.id })
        .returning({ id: scans.id });

  const claimExists = scanPersistClaimExists(input.id, input.organizationId, claimToken);
  const batch: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    claimScan,
    // Always clear prior detail rows first so a retry — including one that flips a
    // scan from D1-backed to R2-backed — never leaves stale rows behind.
    db.delete(scanFiles).where(and(eq(scanFiles.scanId, input.id), claimExists)),
    db.delete(scanFindings).where(and(eq(scanFindings.scanId, input.id), claimExists)),
  ];

  // When the scan is R2-artifact-backed, its redacted file samples, file
  // metadata, diff, and findings already live in R2 (files.json / diff.json /
  // report.json) and are read back from there, so persisting the same rows into
  // D1 would be a pure duplicate. Only the degraded path — the R2 write was
  // skipped (no bucket) and `artifacts` is null — falls back to storing the
  // detail in D1 so the scan stays readable.
  if (!input.artifacts) {
    // D1 caps bound parameters at 100 per query, so insert in chunks sized to
    // each row's columns plus the claim guard. Without this, packages with more
    // than ~12 files silently drop their scan_files rows and the scan-detail view
    // renders as "No file content available." for every entry.
    for (const chunk of chunkForD1CompoundSelect(fileRows, 11)) {
      batch.push(insertScanFilesWhenClaimed(db, chunk, input.organizationId, claimToken));
    }
    for (const chunk of chunkForD1CompoundSelect(findingRows, 13)) {
      batch.push(insertScanFindingsWhenClaimed(db, chunk, input.organizationId, claimToken));
    }
  }

  batch.push(
    db
      .update(scans)
      .set({ reportDigest: scanValues.reportDigest, updatedAt: now })
      .where(
        and(
          eq(scans.id, input.id),
          eq(scans.organizationId, input.organizationId),
          eq(scans.reportDigest, claimToken),
        ),
      ),
  );

  const [claimed] = await db.batch(batch);
  if (Array.isArray(claimed) && claimed.length === 0) {
    return { persisted: false, reason: "already_terminal" as const };
  }
  return { persisted: true as const };
}

type ScanFileInsertRow = typeof scanFiles.$inferInsert;
type ScanFindingInsertRow = typeof scanFindings.$inferInsert;

function scanPersistClaimExists(scanId: string, organizationId: string, claimToken: string) {
  return sql`exists (
    select 1
    from ${scans}
    where ${scans.id} = ${scanId}
      and ${scans.organizationId} = ${organizationId}
      and ${scans.reportDigest} = ${claimToken}
  )`;
}

function insertScanFilesWhenClaimed(
  db: AppDb,
  rows: ScanFileInsertRow[],
  organizationId: string,
  claimToken: string,
) {
  return db.insert(scanFiles).select(
    sql.join(
      rows.map(
        (row) => sql`
          select
            ${row.id},
            ${row.scanId},
            ${row.path},
            ${row.status},
            ${row.size},
            ${row.sha256},
            ${JSON.stringify(row.flagsJson)},
            ${row.textSample}
          where ${scanPersistClaimExists(row.scanId, organizationId, claimToken)}
        `,
      ),
      sql.raw(" union all "),
    ),
  );
}

function insertScanFindingsWhenClaimed(
  db: AppDb,
  rows: ScanFindingInsertRow[],
  organizationId: string,
  claimToken: string,
) {
  return db.insert(scanFindings).select(
    sql.join(
      rows.map(
        (row) => sql`
          select
            ${row.id},
            ${row.scanId},
            ${row.severity},
            ${row.file},
            ${row.evidence},
            ${row.reason},
            ${row.line},
            ${row.source},
            ${row.ruleId},
            ${row.ruleVersion}
          where ${scanPersistClaimExists(row.scanId, organizationId, claimToken)}
        `,
      ),
      sql.raw(" union all "),
    ),
  );
}

function withFindingAnnotations(
  summary: unknown,
  annotations: Array<{ id: string; diffStatus: string; releaseDelta: boolean }>,
): Record<string, unknown> {
  const base =
    summary && typeof summary === "object" && !Array.isArray(summary)
      ? (summary as Record<string, unknown>)
      : {};
  return { ...base, findingAnnotations: annotations };
}
