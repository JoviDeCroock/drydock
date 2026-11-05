import type { AppDb } from "../../db/client";
import { getLinkedGateReviewScan, persistLinkedGateScan } from "../../db/scans";
import { isRecord } from "../platform/guards";
import { copyScanArtifacts, discardScanArtifactRun } from "../scan/artifacts";
import type { RiskLevel } from "../review";
import type { LinkedGateReview } from "./types";

const RISK_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "critical"]);

/**
 * Complete a gate's package scan from an approved review earlier in the same
 * workflow run instead of reviewing again (PyPI PEP 694 two-gate staging).
 *
 * The adapter has already proven the bytes this gate releases are the bytes
 * that review covered. The new scan carries the same report (copied, so it
 * outlives neither more nor less than its own row) plus the verification
 * record, and starts undecided: approving this gate is a separate human
 * decision. Throws when the review is no longer an approved, readable scan;
 * the caller fails the batch and leaves the gate pending.
 */
export async function completeFromLinkedReview(
  env: Cloudflare.Env,
  db: AppDb,
  args: { organizationId: string; scanId: string; linked: LinkedGateReview },
): Promise<{
  packageName: string | null;
  version: string | null;
  releaseRisk: RiskLevel;
  baselineComparisonSkipped: boolean;
}> {
  const { organizationId, scanId, linked } = args;
  const source = await getLinkedGateReviewScan(db, {
    organizationId,
    gateId: linked.gateId,
    scanId: linked.scanId,
  });
  if (!source) throw new Error("linked review is no longer an approved scan of its gate");
  const recorded = isRecord(source.riskSummaryJson) ? source.riskSummaryJson.releaseRisk : null;
  if (typeof recorded !== "string" || !RISK_LEVELS.has(recorded)) {
    throw new Error("linked review has no release risk");
  }
  const releaseRisk = recorded as RiskLevel;
  const artifacts = await copyScanArtifacts(env.ARTIFACTS, source, scanId);
  if (!artifacts) throw new Error("linked review artifacts could not be read");

  const summary = isRecord(source.summaryJson) ? source.summaryJson : {};
  const persisted = await persistLinkedGateScan(db, {
    scanId,
    organizationId,
    source,
    summaryJson: { ...summary, stageVerification: linked.verification },
    artifacts,
  });
  if (!persisted.persisted) {
    await discardScanArtifactRun(env.ARTIFACTS, {
      organizationId,
      scanId,
      artifactRunPrefix: artifacts.artifactRunPrefix,
      reason: "already_terminal",
    });
    throw new Error("linked review scan is no longer pending");
  }

  const baseline = isRecord(summary.baseline) ? summary.baseline : null;
  return {
    packageName: source.packageName,
    version: source.stagedVersion,
    releaseRisk,
    baselineComparisonSkipped: baseline?.comparisonSkipped === true,
  };
}
