import { type AppDb, createDb } from "../../db/client";
import {
  claimReleaseSetReview,
  clearReleaseArtifactStorageKeys,
  deleteReleaseSetScans,
  getReleaseSet,
  listGateIdsForReleaseSet,
  listReleaseArtifacts,
  markReleaseSetErrored,
  markReleaseSetReviewed,
  releaseReleaseSetReviewClaim,
  type CiReleaseSetRecord,
} from "../../db/ci-release-sets";
import { recordScanEvent } from "../../db/events";
import { getOrganizationOwnerUserId } from "../../db/organizations";
import { deleteScanArtifacts } from "../scan/artifacts";
import {
  classifyBundleArtifact,
  getEcosystem,
  getWorkflowGateAdapter,
  UnsupportedEcosystemError,
} from "../ecosystems";
import { WorkflowArtifactError, type ResolvedReleaseFile } from "../github-app/artifacts";
import { deleteReleaseArtifacts, readReleaseArtifact } from "./release-store";
import { notifyWorkflowGateReview } from "../notify";
import { recordProductEvent } from "../platform/analytics";
import {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
} from "../platform/observability";
import { combineRisk } from "../review";
import { classifyScanError, type CiReleaseSetQueueMessage } from "../scan/job";
import { type ReviewedPackage, reviewReleasePackages } from "../scan/review-packages";
import { prepareBundlePackages } from "../workflow-gates/prepare";
import { resolveBundleArtifact } from "../workflow-gates/resolve";
import type { ParsedGateArtifact } from "../workflow-gates/types";
import { executeWorkflowGateJob, recommendationForReleaseRisk } from "../workflow-gate-job";

/**
 * Review a sealed push-path release set.
 *
 * This is the pull-path gate job with the GitHub half removed. There is no
 * bundle to download, no installation token to swap, and no deployment waiting:
 * CI already handed us the bytes and told us the release was complete. What
 * remains is identical — parse each artifact in the credentials-free sandbox,
 * let the ecosystem adapters split the release into packages, scan each against
 * its own baseline, and leave the result for a human.
 *
 * Nothing here ever decides a deployment. A gate may bind to this set later and
 * collect the decision a maintainer made; see `bindGateToReviewedReleaseSet`.
 */
export async function executeCiReleaseSetJob(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
  message: CiReleaseSetQueueMessage,
  db: AppDb = createDb(env.DB),
): Promise<void> {
  const startedAtMs = Date.now();
  const { organizationId, releaseSetId } = message;

  const set = await getReleaseSet(db, organizationId, releaseSetId);
  if (!set) {
    emitOperationalEvent("warn", "ci_release_set.job_skipped", {
      organizationId,
      releaseSetId,
      reason: "set_not_found",
    });
    return;
  }
  if (set.status === "reviewed") {
    emitOperationalEvent("info", "ci_release_set.job_skipped", {
      organizationId,
      releaseSetId,
      reason: "already_reviewed",
    });
    return;
  }
  if (set.status !== "sealed") {
    emitOperationalEvent("warn", "ci_release_set.job_skipped", {
      organizationId,
      releaseSetId,
      reason: `status_${set.status}`,
    });
    return;
  }

  const ownerUserId = await getOrganizationOwnerUserId(db, organizationId);
  if (!ownerUserId) {
    await markReleaseSetErrored(db, set.id, "organization_owner_missing");
    emitOperationalEvent("error", "ci_release_set.review_failed", {
      organizationId,
      releaseSetId,
      reason: "organization_owner_missing",
    });
    return;
  }

  // Claim before doing any work: a re-delivered queue message must not re-run
  // the package scans while the first delivery is still running them.
  const claimed = await claimReleaseSetReview(db, set.id);
  if (!claimed) {
    emitOperationalEvent("info", "ci_release_set.job_skipped", {
      organizationId,
      releaseSetId,
      reason: "review_claim_lost",
    });
    return;
  }

  let reviewed: ReviewedPackage[];
  try {
    const parsed = await parseReleaseSetArtifacts(env, executionCtx, db, set);
    const packages = prepareBundlePackages(parsed);
    if (packages.length === 0) {
      throw new WorkflowArtifactError(
        "artifact_identity_missing",
        "no uploaded artifact was recognizable as a release candidate",
      );
    }
    // A retried batch discards its half-finished scans so the set's package
    // list is exactly this attempt's.
    await discardPreviousScans(env, db, set);
    reviewed = await reviewReleasePackages(
      { env, executionCtx, db },
      {
        organizationId,
        ownerUserId,
        packages,
        source: "ci_release",
        stageIdPrefix: `ci-release:${set.id}`,
        releaseSetId: set.id,
        // Signed OIDC claims, not caller assertions: this is what makes a
        // pushed release attested in the intent envelope.
        ciReleaseContext: {
          repositoryFullName: set.repositoryFullName,
          runId: set.runId,
          jobWorkflowRef: set.jobWorkflowRef,
          sha: set.sha,
        },
      },
    );
  } catch (err) {
    // Release the claim so a retry can re-run the batch, and record why. The
    // set never advances to `reviewed`, so a gate binding to it later will not
    // find an approvable review — it stays blocked, which is the safe default.
    await releaseReleaseSetReviewClaim(db, set.id);
    const reason =
      err instanceof WorkflowArtifactError
        ? err.code
        : err instanceof UnsupportedEcosystemError
          ? "unsupported_ecosystem"
          : "review_failed";
    await markReleaseSetErrored(db, set.id, reason);
    const safe = classifyScanError(err);
    await recordScanEvent(db, {
      organizationId,
      type: "ci_release_set.review_failed",
      metadata: { releaseSetId: set.id, reason, error: safe },
    });
    emitOperationalEvent("error", "ci_release_set.review_failed", {
      organizationId,
      releaseSetId,
      reason,
      durationMs: durationMsSince(startedAtMs),
      error: safe,
    });
    return;
  }

  const aggregateReleaseRisk = combineRisk(...reviewed.map((pkg) => pkg.releaseRisk));
  const representative =
    reviewed.find((pkg) => pkg.releaseRisk === aggregateReleaseRisk) ?? reviewed[0];
  const baselineComparisonSkipped = reviewed.some((pkg) => pkg.baselineComparisonSkipped);
  const recommendation = recommendationForReleaseRisk(
    aggregateReleaseRisk,
    baselineComparisonSkipped,
  );

  const finished = await markReleaseSetReviewed(db, set.id, representative.scanId);
  if (!finished) {
    emitOperationalEvent("info", "ci_release_set.job_skipped", {
      organizationId,
      releaseSetId,
      reason: "review_ready_lost",
    });
    return;
  }

  // The reviewed bytes have done their job. Digests stay on the artifact rows
  // as provenance; the package contents do not outlive the review.
  await dropStoredArtifacts(env, db, set);

  // A gate may already be waiting on this review — the protected job reached
  // its environment while the scan was still running. Nudge every bound gate so
  // it adopts the finished packages instead of sitting until a redelivery.
  await nudgeBoundGates(env, executionCtx, db, set);

  await recordScanEvent(db, {
    organizationId,
    actorUserId: ownerUserId,
    scanId: representative.scanId,
    type: "ci_release_set.reviewed",
    metadata: {
      releaseSetId: set.id,
      recommendation,
      releaseRisk: aggregateReleaseRisk,
      packageCount: reviewed.length,
      packages: reviewed.map((pkg) => ({
        scanId: pkg.scanId,
        packageName: pkg.packageName,
        stagedVersion: pkg.version,
        releaseRisk: pkg.releaseRisk,
      })),
    },
  });

  const durationMs = durationMsSince(startedAtMs);
  emitOperationalEvent("info", "ci_release_set.review_ready", {
    organizationId,
    releaseSetId,
    scanId: representative.scanId,
    packageCount: reviewed.length,
    releaseRisk: aggregateReleaseRisk,
    recommendation,
    durationMs,
  });
  recordProductEvent(env, {
    name: "ci_release_set.reviewed",
    organizationId,
    recommendation,
    durationMs,
    packageCount: reviewed.length,
  });

  // Tell the maintainer there is a release waiting. On the push path this
  // usually arrives while CI is still running, which is the point: the human
  // review window overlaps the build instead of following it.
  try {
    await notifyWorkflowGateReview({
      env,
      db,
      organizationId,
      ownerUserId,
      gateId: set.id,
      repositoryFullName: set.repositoryFullName,
      environment: set.releaseKey || "ci",
      scanId: representative.scanId,
      packageName: representative.packageName,
      version: representative.version,
      releaseRisk: aggregateReleaseRisk,
      packageCount: reviewed.length,
      // No deployment is blocked yet — this release may reach a gate later, or
      // never. Saying otherwise would cry wolf.
      deploymentHeld: false,
    });
  } catch (err) {
    emitOperationalEvent("warn", "ci_release_set.notification_error", {
      organizationId,
      releaseSetId,
      error: describeOperationalError(err),
    });
  }
}

/**
 * Pull each uploaded artifact back out of R2, classify it, and parse it in the
 * credentials-free sandbox.
 *
 * Trust boundary: identical to the pull path. The bytes are hostile evidence,
 * the sandbox holds no credentials, and the digest we carry forward is the one
 * the control plane recomputed at ingest — not one the uploader asserted.
 *
 * Entries no ecosystem claims (a `SHA256SUMS` file, a README) are dropped
 * rather than rejected, so a workflow can upload its checksum record alongside
 * the artifacts exactly as the documented pull-path workflow does.
 */
async function parseReleaseSetArtifacts(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
  db: AppDb,
  set: CiReleaseSetRecord,
): Promise<ParsedGateArtifact[]> {
  if (!env.ARTIFACTS) {
    throw new WorkflowArtifactError("bundle_unavailable", "artifact storage is not configured");
  }
  const artifacts = await listReleaseArtifacts(db, set.id);
  if (artifacts.length === 0) {
    throw new WorkflowArtifactError("bundle_unavailable", "release set has no artifacts");
  }

  const classify = set.ecosystem ? pinnedClassifier(set.ecosystem) : classifyBundleArtifact;
  const retainedSamples = new Map<string, string>();
  const parsed: ParsedGateArtifact[] = [];

  // Sequential on purpose: each artifact is buffered whole before parsing, so
  // fanning out would multiply peak memory by the concurrency factor for no
  // wall-clock win that matters at this size.
  for (const artifact of artifacts) {
    const claim = classify(artifact.path);
    if (!claim) continue;
    if (!artifact.storageKey) {
      throw new WorkflowArtifactError(
        "bundle_unavailable",
        `${artifact.path} is no longer stored; re-run the release to upload it again`,
      );
    }
    const bytes = await readReleaseArtifact(env.ARTIFACTS, artifact.storageKey);
    if (!bytes) {
      throw new WorkflowArtifactError(
        "bundle_unavailable",
        `${artifact.path} could not be read back from storage`,
      );
    }
    const file: ResolvedReleaseFile = {
      path: artifact.path,
      bytes,
      sha256: artifact.sha256,
      ecosystem: claim.ecosystem,
      kind: claim.kind,
    };
    const resolved = await resolveBundleArtifact(env, executionCtx, file);
    const adapter = getEcosystem(resolved.ecosystem)?.gate;
    parsed.push(adapter?.narrowParsedArtifact?.(resolved, retainedSamples) ?? resolved);
  }

  if (parsed.length === 0) {
    throw new WorkflowArtifactError(
      "artifact_identity_missing",
      set.ecosystem
        ? `no uploaded artifact looked like a ${set.ecosystem} release candidate`
        : "no uploaded artifact was recognizable as a release candidate",
    );
  }
  return parsed;
}

function pinnedClassifier(ecosystem: string) {
  const adapter = getWorkflowGateAdapter(ecosystem);
  return (path: string) => {
    const kind = adapter.classifyArtifact(path);
    return kind ? { ecosystem: adapter.ecosystem, kind } : null;
  };
}

async function discardPreviousScans(
  env: Cloudflare.Env,
  db: AppDb,
  set: CiReleaseSetRecord,
): Promise<void> {
  const removed = await deleteReleaseSetScans(db, {
    releaseSetId: set.id,
    organizationId: set.organizationId,
  });
  if (removed.length === 0 || !env.ARTIFACTS) return;
  for (const scanId of removed) {
    try {
      await deleteScanArtifacts(env.ARTIFACTS, set.organizationId, scanId);
    } catch (err) {
      emitOperationalEvent("warn", "ci_release_set.scan_artifact_cleanup_failed", {
        organizationId: set.organizationId,
        releaseSetId: set.id,
        scanId,
        error: describeOperationalError(err),
      });
    }
  }
}

async function dropStoredArtifacts(
  env: Cloudflare.Env,
  db: AppDb,
  set: CiReleaseSetRecord,
): Promise<void> {
  try {
    if (env.ARTIFACTS) {
      await deleteReleaseArtifacts(env.ARTIFACTS, set.organizationId, set.id);
    }
    await clearReleaseArtifactStorageKeys(db, set.id);
  } catch (err) {
    // A failed cleanup must never fail a review that already succeeded.
    emitOperationalEvent("warn", "ci_release_set.artifact_cleanup_failed", {
      organizationId: set.organizationId,
      releaseSetId: set.id,
      error: describeOperationalError(err),
    });
  }
}

/**
 * Re-run every gate already bound to a set that just finished review.
 *
 * Without this a gate that arrived mid-scan would stay pending until GitHub
 * redelivered the webhook, which it may not do for a long time — the review
 * would be ready and the deployment still held for no reason. Failures are
 * swallowed: the gate remains pending, which is the safe state, and a
 * redelivery or a maintainer decision still resolves it.
 */
async function nudgeBoundGates(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
  db: AppDb,
  set: CiReleaseSetRecord,
): Promise<void> {
  let gateIds: string[];
  try {
    gateIds = await gatesForReleaseSet(db, set);
  } catch (err) {
    emitOperationalEvent("warn", "ci_release_set.gate_lookup_failed", {
      organizationId: set.organizationId,
      releaseSetId: set.id,
      error: describeOperationalError(err),
    });
    return;
  }

  for (const gateId of gateIds) {
    const message = {
      kind: "workflow_gate" as const,
      organizationId: set.organizationId,
      gateId,
    };
    try {
      if (env.SCAN_QUEUE) {
        await env.SCAN_QUEUE.send(message);
      } else {
        executionCtx.waitUntil(executeWorkflowGateJob(env, executionCtx, message));
      }
    } catch (err) {
      emitOperationalEvent("warn", "ci_release_set.gate_nudge_failed", {
        organizationId: set.organizationId,
        releaseSetId: set.id,
        gateId,
        error: describeOperationalError(err),
      });
    }
  }
}

/** Gates bound to a set, for the decision fan-out. */
async function gatesForReleaseSet(
  db: AppDb,
  set: Pick<CiReleaseSetRecord, "id" | "organizationId">,
): Promise<string[]> {
  return listGateIdsForReleaseSet(db, {
    releaseSetId: set.id,
    organizationId: set.organizationId,
  });
}
