import { env } from "cloudflare:test";
import type { AppDb } from "../../../server/db/client";
import { persistScan, type PersistedScanInput } from "../../../server/db/scans";
import { annotateFindingsWithDiffStatus } from "../../../server/lib/review";
import { sha256Hex } from "../../../server/lib/platform/crypto-utils";
import { stableJson } from "../../../server/lib/platform/stable-json";
import { writeScanArtifactsWithRetry } from "../../../server/lib/scan/artifacts";

type SeedInput = Omit<PersistedScanInput, "artifacts" | "report"> & {
  reportExtras?: Record<string, unknown>;
};

export async function persistScanWithArtifacts(db: AppDb, input: SeedInput) {
  const findings = input.findings ?? [];
  const aiFindingRecords = input.aiFindingRecords ?? [];
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
  return { ...result, reportDigest };
}
