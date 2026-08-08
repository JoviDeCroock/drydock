import { type AppDb } from "../../db/client";
import { type ScanSource, createScanJob, markScanFailed } from "../../db/scans";
import type { PreparedGatePackage } from "../workflow-gates/prepare";
import type { CiReleaseIntent, WorkflowGateIntent } from "../intent-envelope";
import type { RiskLevel } from "../review";
import { recordProductEvent } from "../platform/analytics";
import { classifyScanError } from "./job";
import { runScanPipeline } from "./pipeline";

/** One package's finished review, as both release paths summarize it. */
export interface ReviewedPackage {
  scanId: string;
  packageName: string | null;
  version: string | null;
  releaseRisk: RiskLevel;
  /** The published baseline was not downloaded, so `releaseRisk` graded nothing. */
  baselineComparisonSkipped: boolean;
}

export interface ReviewPackagesInput {
  organizationId: string;
  ownerUserId: string;
  packages: PreparedGatePackage[];
  source: ScanSource;
  /**
   * Namespace for each package's synthetic stage id. Scans are keyed by
   * `${stageIdPrefix}:${ecosystem}:${package}` so a re-review of the same
   * release is recognizable and two releases never collide.
   */
  stageIdPrefix: string;
  gateId?: string | null;
  releaseSetId?: string | null;
  gateContext?: WorkflowGateIntent;
  ciReleaseContext?: CiReleaseIntent;
}

const PACKAGE_SCAN_CONCURRENCY = 3;

/**
 * Run one scan per discovered package, each against its own baseline.
 *
 * Shared by both release paths. The pull path (a held GitHub deployment) and
 * the push path (the CI Action uploading during the build) differ only in where
 * the artifact bytes came from and what the finished scans link back to — the
 * per-package fan-out, baseline resolution, and failure semantics are the same
 * review, so they are the same code.
 *
 * A monorepo release fans out here. A pipeline failure on any package rethrows
 * so the caller fail-closes the batch: a half-reviewed release must never be
 * presented as ready for a decision.
 */
export async function reviewReleasePackages(
  ctx: { env: Cloudflare.Env; executionCtx: ExecutionContext; db: AppDb },
  input: ReviewPackagesInput,
): Promise<ReviewedPackage[]> {
  const { env, executionCtx, db } = ctx;
  const { organizationId, ownerUserId, packages, source } = input;

  return mapWithConcurrency(packages, PACKAGE_SCAN_CONCURRENCY, async (pkg) => {
    const { candidate, packageAdapter } = pkg;
    const scanId = crypto.randomUUID();
    const stageId = `${input.stageIdPrefix}:${candidate.ecosystem}:${candidate.package.name}`;
    await createScanJob(db, {
      id: scanId,
      stageId,
      organizationId,
      ownerUserId,
      source,
      gateId: input.gateId ?? null,
      releaseSetId: input.releaseSetId ?? null,
      packageName: candidate.package.name,
      stagedVersion: candidate.package.version,
    });
    // Counted per package scan, not per release: a monorepo bundle creates
    // several scans under one release and each emits its own `scan.completed`,
    // so counting the release would make the queued -> completed drop-off
    // unreadable.
    recordProductEvent(env, {
      name: "scan.queued",
      organizationId,
      ecosystem: candidate.ecosystem,
      source,
    });

    try {
      const result = await runScanPipeline(
        { env, executionCtx, db, session: { userId: ownerUserId } },
        packageAdapter,
        {
          scanId,
          stageId,
          organizationId,
          source,
          ...(input.gateContext ? { gateContext: input.gateContext } : {}),
          ...(input.ciReleaseContext ? { ciReleaseContext: input.ciReleaseContext } : {}),
          ...candidate.pipelineInput,
        },
      );
      return {
        scanId,
        packageName: result.package.name,
        version: result.package.stagedVersion,
        releaseRisk: result.riskSummary.releaseRisk,
        baselineComparisonSkipped: Boolean(result.baseline.comparisonSkipped),
      };
    } catch (err) {
      const safe = classifyScanError(err);
      await markScanFailed(db, scanId, organizationId, safe);
      // Without this, gated/pushed failures would go uncounted while their
      // completions were counted, biasing the derived failure rate low for
      // exactly the ecosystems that only release this way.
      recordProductEvent(env, {
        name: "scan.failed",
        organizationId,
        ecosystem: packageAdapter.id,
        source,
        code: safe.code,
        durationMs: 0,
      });
      throw err;
    }
  });
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<U>,
): Promise<U[]> {
  const results = new Map<number, U>();
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results.set(index, await worker(items[index]));
    }
  });
  await Promise.all(workers);
  return items.map((_, index) => results.get(index)!);
}
