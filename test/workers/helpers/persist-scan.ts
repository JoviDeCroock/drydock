import { env } from "cloudflare:test";
import type { AppDb } from "../../../server/db/client";
import { persistScan, type PersistedScanInput } from "../../../server/db/scans";
import { annotateFindingsWithDiffStatus } from "../../../server/lib/review";
import { sha256Hex } from "../../../server/lib/platform/crypto-utils";
import { stableJson } from "../../../server/lib/platform/stable-json";
import { writeScanArtifactsWithRetry } from "../../../server/lib/scan/artifacts";

type SeedInput = Omit<PersistedScanInput, "artifacts" | "report"> & {
  /** Extra report.json fields a test asserts on (registryStatus, safety, ...). */
  reportExtras?: Record<string, unknown>;
};

/**
 * Seed a scan the way the pipeline does: write the R2 artifact set, then persist
 * the D1 metadata row that points at it.
 *
 * A completed scan's body lives only in R2, so `persistScan` alone leaves a row
 * whose files and findings read back empty. Tests that assert on scan detail go
 * through here; the report digest is computed over the same bytes the read path
 * verifies against `scans.report_digest`.
 */
export async function persistScanWithArtifacts(db: AppDb, input: SeedInput) {
  const findings = input.findings ?? [];
  const aiFindingRecords = input.aiFindingRecords ?? [];
  // Annotate exactly the way the pipeline does before writing the report, so a
  // seeded scan's served diff statuses are the real ones and not placeholders.
  const annotated = annotateFindingsWithDiffStatus(
    [...findings, ...aiFindingRecords].map((finding, index) => ({ ...finding, id: String(index) })),
    input.diff ?? [],
    {
      previousFiles: input.previousFiles ?? [],
      stagedFiles: input.files ?? [],
      codePatternSet: input.codePatternSet,
    },
  );
  const reportJson = stableJson({
    version: 1,
    stageId: input.stageId,
    package: {
      name: input.packageJson?.name ?? null,
      stagedVersion: input.packageJson?.version ?? null,
      previousVersion: input.previousPackageJson?.version ?? null,
    },
    packageJson: input.packageJson ?? null,
    diff: input.diff ?? [],
    ruleFindings: findings,
    aiFindings: input.ai ?? null,
    // Rule findings first, AI findings after them — the order the read path
    // re-derives, so `findingIndex` addresses the same combined list.
    findingAnnotations: annotated.map((finding, index) => ({
      findingIndex: index,
      diffStatus: finding.diffStatus,
      releaseDelta: finding.releaseDelta,
    })),
    ...input.reportExtras,
  });
  const reportDigest = await sha256Hex(reportJson);
  const artifacts = await writeScanArtifactsWithRetry(env.ARTIFACTS, {
    organizationId: input.organizationId,
    scanId: input.id,
    reportJson,
    reportDigest,
    files: input.files ?? [],
    diff: input.diff ?? [],
    generatedAt: new Date(0).toISOString(),
  });
  const result = await persistScan(db, {
    ...input,
    report: { version: 1, digest: reportDigest },
    artifacts,
  });
  // The digest is the scan's claim token once persisted, so tests that assert
  // which attempt won need it back.
  return { ...result, reportDigest };
}
