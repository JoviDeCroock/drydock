import { and, eq } from "drizzle-orm";
import { mapWithConcurrency } from "./platform/concurrency";
import { type AppDb, createDb } from "../db/client";
import { recordScanEvent } from "../db/events";
import { getOrganizationOwnerUserId } from "../db/organizations";
import { createScanJob, discardGateScans, markScanFailed } from "../db/scans";
import { githubAppInstallations } from "../db/schema";
import { WorkflowArtifactError } from "./github-app/artifacts";
import {
  type GithubAppConfig,
  GithubAppConfigError,
  readGithubAppConfig,
} from "./github-app/config";
import { postDeploymentProtectionDecision } from "./github-app/webhook";
import {
  type WorkflowGateRecord,
  attachScanToGate,
  claimGateReviewStart,
  getGateForOrganization,
  markGateDecided,
  releaseGateReviewClaim,
} from "./github-app/webhook-gates";
import { notifyWorkflowGateReview, notifyWorkflowGateTimeout } from "./notify";
import {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
} from "./platform/observability";
import { recordProductEvent } from "./platform/analytics";
import {
  type PreparedGatePackage,
  type PreparedGateRelease,
  prepareReleaseCandidatesForGate,
} from "./workflow-gates/prepare";
import { combineRisk, type RiskLevel } from "./review";
import { runScanPipeline } from "./scan/pipeline";
import { classifyScanError, type WorkflowGateQueueMessage } from "./scan/job";

// A release whose changed (release-delta) findings reach these levels is
// recommended for rejection in the workbench; everything below is recommended
// for approval. This is advisory only — a human drives the actual decision.
// The threshold is a product decision held in one place so it is easy to tune.
const BLOCKING_RISKS: ReadonlySet<RiskLevel> = new Set<RiskLevel>(["high", "critical"]);

export type GateRecommendation = "approved" | "rejected" | "manual_review";

export function recommendationForReleaseRisk(
  releaseRisk: RiskLevel,
  baselineComparisonSkipped = false,
): GateRecommendation {
  // No baseline was downloaded, so there is no release delta to grade. Neither
  // "approved" nor "rejected" is supported by the evidence: say the comparison
  // is missing and let the maintainer review the artifact as a whole.
  if (baselineComparisonSkipped) return "manual_review";
  return BLOCKING_RISKS.has(releaseRisk) ? "rejected" : "approved";
}

// GitHub auto-rejects a held deployment if the protection rule does not call
// back inside its decision window. We don't get told when that happens, so we
// compare the review's wall-clock duration against this window to flag a gate
// that almost certainly already lapsed (`missed`) or is close to it
// (`imminent`). GitHub's custom deployment protection rule callback window is
// 30 days; override with WORKFLOW_GATE_CALLBACK_WINDOW_MS if GitHub changes it
// or a test needs a shorter deterministic window.
const DEFAULT_GATE_CALLBACK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const GATE_TIMEOUT_IMMINENT_FRACTION = 0.8;

export function workflowGateCallbackWindowMs(env: Cloudflare.Env): number {
  const raw = Number(env.WORKFLOW_GATE_CALLBACK_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GATE_CALLBACK_WINDOW_MS;
}

export function classifyGateTimeout(
  elapsedMs: number,
  windowMs: number,
): "ok" | "imminent" | "missed" {
  if (elapsedMs >= windowMs) return "missed";
  if (elapsedMs >= windowMs * GATE_TIMEOUT_IMMINENT_FRACTION) return "imminent";
  return "ok";
}

/**
 * Review a resolved workflow gate end to end and leave it pending for a human
 * decision. The ecosystem is selected from the gate's release target: this
 * runner owns all GitHub plumbing, while a `WorkflowGateAdapter`
 * (`server/lib/workflow-gates`) supplies the ecosystem's artifact semantics and
 * review adapter.
 *
 * Trust boundary: the installation token never enters the sandbox. Artifact
 * bytes are fetched + SHA-256-verified in the control plane
 * (`prepareReleaseCandidatesForGate`), then the credentials-free sandbox parser
 * turns them into evidence the deterministic rules run against via
 * `runScanPipeline`.
 *
 * Decision model: a maintainer drives the gate from the workbench. A successful
 * review records a `reviewed` event carrying an advisory recommendation and
 * leaves the gate PENDING — Drydock never auto-approves, because approving
 * releases the GitHub job and publishing happens immediately via Trusted
 * Publishing/OIDC (too late to reverse).
 *
 * Failure handling matches the gate contract:
 *  - Artifact-level problems (`WorkflowArtifactError`, e.g. an unverifiable
 *    bundle, inconsistent artifact identity, or a release-target mismatch) →
 *    the deployment is REJECTED with a generic comment (fail-closed; no human
 *    in the loop is needed to block).
 *  - Review/processing errors → the deployment is left PENDING (never
 *    auto-approved on error); the failure is recorded and surfaced.
 *  - Re-enqueues are idempotent: a gate with a completed review attached is not
 *    re-reviewed, a failed attached review can be retried, and an
 *    already-decided gate re-delivers its stored decision so a transient
 *    callback failure can be retried without re-running the review.
 */
export async function executeWorkflowGateJob(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
  message: WorkflowGateQueueMessage,
  db: AppDb = createDb(env.DB),
): Promise<void> {
  const startedAtMs = Date.now();
  const { organizationId, gateId } = message;

  let config: GithubAppConfig;
  try {
    config = readGithubAppConfig(env);
  } catch (err) {
    // Without app credentials we can neither fetch artifacts nor post the
    // callback. Leave the gate pending and surface the misconfiguration; there
    // is nothing a retry can fix.
    emitOperationalEvent("error", "github_workflow_gate.config_error", {
      organizationId,
      gateId,
      message: err instanceof GithubAppConfigError ? err.message : describeOperationalError(err),
    });
    return;
  }

  const gate = await getGateForOrganization(db, organizationId, gateId);
  if (!gate) {
    emitOperationalEvent("warn", "github_workflow_gate.job_skipped", {
      organizationId,
      gateId,
      reason: "gate_not_found",
    });
    return;
  }

  // A prior delivery already decided this gate. Re-deliver the stored decision
  // to GitHub (best effort) in case that delivery's callback POST failed, then
  // ack — we never re-run the review for a decided gate.
  if (gate.status === "approved" || gate.status === "rejected") {
    await redeliverGateDecision(config, db, gate);
    return;
  }
  if (gate.status !== "pending") {
    emitOperationalEvent("warn", "github_workflow_gate.job_skipped", {
      organizationId,
      gateId,
      reason: `status_${gate.status}`,
    });
    return;
  }

  // A finished batch attaches a representative scan to the gate. A re-delivery
  // must not re-run the per-package scans; the gate is waiting on a human.
  if (gate.scanId) {
    emitOperationalEvent("info", "github_workflow_gate.job_skipped", {
      organizationId,
      gateId,
      scanId: gate.scanId,
      reason: "already_reviewed",
    });
    return;
  }

  await recordScanEvent(db, {
    organizationId,
    type: "github_workflow_gate.received",
    metadata: {
      gateId: gate.id,
      repositoryFullName: gate.repositoryFullName,
      environment: gate.environment,
      runId: gate.runId,
    },
  });

  let prepared: PreparedGateRelease;
  try {
    prepared = await prepareReleaseCandidatesForGate(env, executionCtx, db, {
      config,
      organizationId,
      gateId,
    });
  } catch (err) {
    if (err instanceof WorkflowArtifactError) {
      // The published artifacts could not be verified against the reviewed
      // manifest (missing bundle, tampered digest, package mismatch, …). Block
      // the deployment with a generic comment; the typed reason is already
      // stored on the gate by `prepareReleaseCandidatesForGate`.
      await rejectGateForArtifactError(env, db, config, gate, err);
      emitOperationalEvent("warn", "github_workflow_gate.rejected_artifact_error", {
        organizationId,
        gateId,
        reason: err.code,
        durationMs: durationMsSince(startedAtMs),
      });
      return;
    }
    // A review/processing error (e.g. the sandbox parser). Leave the deployment
    // pending so GitHub waits for a human; record the failure for the dashboard.
    const safe = classifyScanError(err);
    await recordScanEvent(db, {
      organizationId,
      type: "github_workflow_gate.review_failed",
      metadata: { gateId: gate.id, error: safe },
    });
    emitOperationalEvent("error", "github_workflow_gate.review_failed", {
      organizationId,
      gateId,
      durationMs: durationMsSince(startedAtMs),
      error: safe,
    });
    return;
  }

  const ownerUserId = await getOrganizationOwnerUserId(db, organizationId);
  if (!ownerUserId) {
    await recordScanEvent(db, {
      organizationId,
      type: "github_workflow_gate.review_failed",
      metadata: { gateId: gate.id, error: { code: "organization_owner_missing" } },
    });
    emitOperationalEvent("error", "github_workflow_gate.review_failed", {
      organizationId,
      gateId,
      reason: "organization_owner_missing",
    });
    return;
  }

  // Claim the review batch. Only the first delivery to flip `review_started_at`
  // runs the per-package scans; a concurrent re-delivery loses the CAS and skips
  // here rather than double-running. Early returns above leave the claim unset,
  // so a transient prepare/owner failure stays retryable.
  const claimed = await claimGateReviewStart(db, gate.id);
  if (!claimed) {
    emitOperationalEvent("info", "github_workflow_gate.job_skipped", {
      organizationId,
      gateId,
      reason: "review_claim_lost",
    });
    return;
  }

  let reviewed: ReviewedPackage[];
  try {
    // A retried batch (a prior attempt released its claim mid-flight) discards
    // the half-finished scans first so the gate's package set is exactly this
    // batch.
    await discardGateScans(db, gate.id, organizationId, env.ARTIFACTS);
    reviewed = await reviewGatePackages(
      { env, executionCtx, db },
      { gate, ownerUserId, packages: prepared.packages },
    );
  } catch (err) {
    // A per-package scan failed. Release the claim so a retry re-runs the whole
    // batch, and leave the deployment pending (never auto-approved on error).
    await releaseGateReviewClaim(db, gate.id);
    const safe = classifyScanError(err);
    await recordScanEvent(db, {
      organizationId,
      actorUserId: ownerUserId,
      type: "github_workflow_gate.review_failed",
      metadata: { gateId: gate.id, error: safe },
    });
    emitOperationalEvent("error", "github_workflow_gate.review_failed", {
      organizationId,
      gateId,
      durationMs: durationMsSince(startedAtMs),
      error: safe,
    });
    return;
  }

  // The gate's headline risk is the worst package's release risk; the
  // representative scan is the (first) package carrying it.
  const aggregateReleaseRisk = combineRisk(...reviewed.map((pkg) => pkg.releaseRisk));
  const representative =
    reviewed.find((pkg) => pkg.releaseRisk === aggregateReleaseRisk) ?? reviewed[0];
  const baselineComparisonSkipped = reviewed.some((pkg) => pkg.baselineComparisonSkipped);
  const recommendation = recommendationForReleaseRisk(
    aggregateReleaseRisk,
    baselineComparisonSkipped,
  );

  await recordScanEvent(db, {
    organizationId,
    actorUserId: ownerUserId,
    scanId: representative.scanId,
    type: "github_workflow_gate.reviewed",
    metadata: {
      gateId: gate.id,
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

  // Attach the representative scan as the gate headline and leave the gate
  // PENDING. The CAS (expecting no scan yet) guards against a racing decision or
  // fail-closed artifact reject. A maintainer drives the decision; every package
  // must be approved before the gate releases.
  const reviewReady = await attachScanToGate(db, gate.id, representative.scanId, null);
  if (!reviewReady) {
    const currentGate = await getGateForOrganization(db, organizationId, gate.id);
    emitOperationalEvent("info", "github_workflow_gate.job_skipped", {
      organizationId,
      gateId,
      scanId: representative.scanId,
      reason: currentGate
        ? `review_ready_lost_to_status_${currentGate.status}`
        : "review_ready_gate_missing",
    });
    return;
  }

  // Detect whether the review outran GitHub's deployment-protection callback
  // window. GitHub never tells us when it auto-rejects, so a `missed` gate is
  // most likely already lost — we tell the maintainer it timed out instead of
  // asking them to decide a gate GitHub has already closed.
  const gateElapsedMs = Date.now() - gate.requestedAt.getTime();
  const jobDurationMs = durationMsSince(startedAtMs);
  const windowMs = workflowGateCallbackWindowMs(env);
  const timeoutState = classifyGateTimeout(gateElapsedMs, windowMs);
  if (timeoutState !== "ok") {
    await recordScanEvent(db, {
      organizationId,
      actorUserId: ownerUserId,
      scanId: representative.scanId,
      type:
        timeoutState === "missed"
          ? "github_workflow_gate.timeout_missed"
          : "github_workflow_gate.timeout_imminent",
      metadata: { gateId: gate.id, elapsedMs: gateElapsedMs, windowMs },
    });
    emitOperationalEvent(
      timeoutState === "missed" ? "error" : "warn",
      timeoutState === "missed"
        ? "github_workflow_gate.timeout_missed"
        : "github_workflow_gate.timeout_imminent",
      { organizationId, gateId, scanId: representative.scanId, elapsedMs: gateElapsedMs, windowMs },
    );
  }

  // Tell the maintainer the outcome. For a gate still inside its window this is
  // the only review-ready transition (a re-delivery short-circuits above at
  // `already_reviewed`), so it produces exactly one email; for a `missed` gate
  // we send the timeout notice instead. Delivery is best-effort: a failure is
  // recorded inside the notifier and must never fail or stall the deployment.
  try {
    if (timeoutState === "missed") {
      await notifyWorkflowGateTimeout({
        env,
        db,
        organizationId,
        ownerUserId,
        gateId: gate.id,
        repositoryFullName: gate.repositoryFullName,
        environment: gate.environment,
        scanId: representative.scanId,
        packageName: representative.packageName,
        version: representative.version,
      });
    } else {
      await notifyWorkflowGateReview({
        env,
        db,
        organizationId,
        ownerUserId,
        gateId: gate.id,
        repositoryFullName: gate.repositoryFullName,
        environment: gate.environment,
        scanId: representative.scanId,
        packageName: representative.packageName,
        version: representative.version,
        releaseRisk: aggregateReleaseRisk,
        packageCount: reviewed.length,
      });
    }
  } catch (err) {
    emitOperationalEvent("warn", "github_workflow_gate.notification_error", {
      organizationId,
      gateId,
      scanId: representative.scanId,
      error: describeOperationalError(err),
    });
  }

  emitOperationalEvent("info", "github_workflow_gate.review_ready", {
    organizationId,
    gateId,
    scanId: representative.scanId,
    packageCount: reviewed.length,
    releaseRisk: aggregateReleaseRisk,
    recommendation,
    timeoutState,
    durationMs: jobDurationMs,
  });

  // The denominator for gate approval rate, and the only place the reviewer's
  // own recommendation is counted — a decision below records what a human (or
  // the timeout) actually did with it.
  recordProductEvent(env, {
    name: "workflow_gate.reviewed",
    organizationId,
    recommendation,
    timeoutState,
    durationMs: jobDurationMs,
    packageCount: reviewed.length,
  });
}

interface ReviewedPackage {
  scanId: string;
  packageName: string | null;
  version: string | null;
  releaseRisk: RiskLevel;
  /** The published baseline was not downloaded, so `releaseRisk` graded nothing. */
  baselineComparisonSkipped: boolean;
}

const GATE_PACKAGE_SCAN_CONCURRENCY = 3;

/**
 * Run one scan per discovered package, each against its own baseline, and link
 * every scan back to the gate via `scans.gate_id`. A monorepo release bundle
 * fans out into several packages here; the gate decision later aggregates them
 * (release only when all are approved). A pipeline failure on any package
 * rethrows so the caller fail-closes the batch — a half-reviewed gate must never
 * become review-ready.
 */
async function reviewGatePackages(
  ctx: { env: Cloudflare.Env; executionCtx: ExecutionContext; db: AppDb },
  args: { gate: WorkflowGateRecord; ownerUserId: string; packages: PreparedGatePackage[] },
): Promise<ReviewedPackage[]> {
  const { env, executionCtx, db } = ctx;
  const { gate, ownerUserId, packages } = args;
  const organizationId = gate.organizationId;

  return mapWithConcurrency(packages, GATE_PACKAGE_SCAN_CONCURRENCY, async (pkg) => {
    const { candidate, packageAdapter } = pkg;
    const scanId = crypto.randomUUID();
    const stageId = `workflow-gate:${gate.id}:${candidate.ecosystem}:${candidate.package.name}`;
    await createScanJob(db, {
      id: scanId,
      stageId,
      organizationId,
      ownerUserId,
      source: "workflow_gate",
      gateId: gate.id,
      packageName: candidate.package.name,
      stagedVersion: candidate.package.version,
    });
    // Counted per package scan, not per gate: a monorepo bundle creates several
    // scans under one gate and each emits its own `scan.completed`, so counting
    // the gate would make the queued -> completed drop-off unreadable.
    recordProductEvent(env, {
      name: "scan.queued",
      organizationId,
      ecosystem: candidate.ecosystem,
      source: "workflow_gate",
    });

    try {
      const result = await runScanPipeline(
        { env, executionCtx, db, session: { userId: ownerUserId } },
        packageAdapter,
        {
          scanId,
          stageId,
          organizationId,
          // `source` matches the `workflow_gate` value the D1 row already
          // carries; without it the product counter files every gated scan as
          // "unknown" and the npm/gate split is unreadable.
          source: "workflow_gate",
          // Marks the scan as gate-attested in the intent envelope: the signed
          // webhook bound repository + run + environment, and the reviewed
          // bytes came from that run.
          gateContext: {
            repositoryFullName: gate.repositoryFullName,
            runId: gate.runId,
            environment: gate.environment,
          },
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
      // `scan.failed` otherwise only fires on the npm queue path, so gated
      // failures went uncounted while gated *completions* were counted — which
      // biases the derived failure rate low for exactly the ecosystems that
      // only release through a gate.
      recordProductEvent(env, {
        name: "scan.failed",
        organizationId,
        ecosystem: packageAdapter.id,
        source: "workflow_gate",
        code: safe.code,
        durationMs: 0,
      });
      throw err;
    }
  });
}

// ── Internals ────────────────────────────────────────────────────────────────

async function rejectGateForArtifactError(
  env: Cloudflare.Env,
  db: AppDb,
  config: GithubAppConfig,
  gate: WorkflowGateRecord,
  error: WorkflowArtifactError,
): Promise<void> {
  const comment =
    "Drydock blocked this release: the published artifacts could not be verified against the reviewed manifest.";
  const decided = await markGateDecided(db, {
    gateId: gate.id,
    decision: "rejected",
    comment,
    reportUrl: null,
  });
  if (!decided) return;
  recordProductEvent(env, {
    name: "workflow_gate.decided",
    organizationId: gate.organizationId,
    surface: "automatic",
    decision: "rejected",
    packageCount: 0,
  });
  try {
    await deliverGateDecision(config, db, decided);
  } catch (err) {
    // First-delivery POST of the auto-block decision failed: GitHub still holds
    // the job, so alert an operator. Redeliveries are observed separately in
    // `redeliverGateDecision`; the throw lets the queue retry.
    emitOperationalEvent("error", "github_workflow_gate.decision_callback_failed", {
      organizationId: gate.organizationId,
      gateId: gate.id,
      decision: "rejected",
      reason: error.code,
      error: describeOperationalError(err),
    });
    throw err;
  }
  await recordScanEvent(db, {
    organizationId: gate.organizationId,
    type: "github_workflow_gate.rejected",
    metadata: { gateId: gate.id, reason: error.code },
  });
}

/**
 * Re-delivery of a gate that a previous delivery already decided. Callback
 * errors are rethrown so the queue can retry until GitHub receives the durable
 * decision.
 */
async function redeliverGateDecision(
  config: GithubAppConfig,
  db: AppDb,
  gate: WorkflowGateRecord,
): Promise<void> {
  try {
    await deliverGateDecision(config, db, gate);
    emitOperationalEvent("info", "github_workflow_gate.decision_redelivered", {
      organizationId: gate.organizationId,
      gateId: gate.id,
      decision: gate.decision,
    });
  } catch (err) {
    emitOperationalEvent("warn", "github_workflow_gate.redelivery_failed", {
      organizationId: gate.organizationId,
      gateId: gate.id,
      error: describeOperationalError(err),
    });
    throw err;
  }
}

async function deliverGateDecision(
  config: GithubAppConfig,
  db: AppDb,
  gate: WorkflowGateRecord,
): Promise<void> {
  if (gate.decision !== "approved" && gate.decision !== "rejected") {
    throw new Error(`gate ${gate.id} has no decision to deliver`);
  }
  const installationExternalId = await getInstallationExternalId(
    db,
    gate.installationRowId,
    gate.organizationId,
  );
  if (!installationExternalId) {
    throw new Error(`installation row ${gate.installationRowId} missing for gate ${gate.id}`);
  }
  await postDeploymentProtectionDecision({
    config,
    installationExternalId,
    callbackUrl: gate.deploymentCallbackUrl,
    environment: gate.environment,
    state: gate.decision,
    comment: gate.decisionComment ?? "",
  });
}

async function getInstallationExternalId(
  db: AppDb,
  installationRowId: string,
  organizationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ installationId: githubAppInstallations.installationId })
    .from(githubAppInstallations)
    .where(
      and(
        eq(githubAppInstallations.id, installationRowId),
        eq(githubAppInstallations.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row?.installationId ?? null;
}

export function buildReportUrl(env: Cloudflare.Env, scanId: string | null): string | null {
  const base = env.BETTER_AUTH_URL?.trim();
  if (!base || !scanId) return null;
  return `${base.replace(/\/$/, "")}/dashboard/scans/${scanId}`;
}

/**
 * The comment GitHub renders in the Actions run log when a maintainer decides a
 * gate from the workbench. Trimmed to 140 chars by the callback POST.
 */
export function buildHumanDecisionComment(
  decision: "approved" | "rejected",
  reportUrl: string | null,
): string {
  const verb = decision === "approved" ? "approved" : "blocked";
  const head = `A Drydock maintainer ${verb} this release.`;
  return reportUrl ? `${head} Review: ${reportUrl}` : head;
}
