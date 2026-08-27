import { and, eq, inArray } from "drizzle-orm";
import {
  annotateFindingsWithDiffStatus,
  type CodePatternSet,
  type DiffEntry,
  type FileRecord,
  type Finding,
  type PackageJsonSummary,
} from "../lib/review";
import type { ScanRiskBreakdown } from "../lib/review/risk";
import type { ScanArtifactMetadata } from "../lib/scan/artifacts";
import type { AppDb } from "./client";
import { NON_TERMINAL_STATUSES } from "./scan-jobs";
import {
  computeRiskSummary,
  countChangedFileEntries,
  readPersistedListRiskSummary,
} from "./scan-risk";
import { scans } from "./schema";

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
  artifacts: ScanArtifactMetadata;
}

export async function persistScan(db: AppDb, input: PersistedScanInput) {
  const now = new Date();
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
    summaryJson: input.summary,
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
    return { persisted: false as const, reason: "already_terminal" as const };
  }

  // The UPDATE branch assumes the existing row is non-terminal and therefore
  // carries NULL artifact key columns: the pre-read above and `claimScanForRun`
  // both refuse terminal rows, and the sole production caller always persists
  // `status: "complete"`. A caller that persists a non-terminal status would
  // break that, and would have to sweep the artifact run this overwrites.
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

  // D1 rejects transactions in Workers; the batch atomically claims and finalizes the row.
  const batch = [
    claimScan,
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
  ] as const;

  const [claimed] = await db.batch(batch);
  if (Array.isArray(claimed) && claimed.length === 0) {
    return { persisted: false as const, reason: "already_terminal" as const };
  }
  return { persisted: true as const };
}
