import { and, eq } from "drizzle-orm";
import {
  createDb,
  createScanJob,
  getOrganizationOwnerUserId,
  markScanFailed,
  recordScanEvent,
  type AppDb,
} from "../db";
import { githubAppInstallations } from "../db/schema";
import { pypiAdapter } from "./adapters/pypi/index";
import {
  attachScanToGate,
  GithubAppConfigError,
  type GithubAppConfig,
  getGateForOrganization,
  markGateDecided,
  postDeploymentProtectionDecision,
  readGithubAppConfig,
  WorkflowArtifactError,
  type WorkflowGateRecord,
} from "./github-app";
import { describeOperationalError, durationMsSince, emitOperationalEvent } from "./observability";
import { preparePyPiReleaseCandidateForGate } from "./release-candidate-pypi";
import type { RiskLevel } from "./review";
import { runScanPipeline } from "./scan-pipeline";
import { classifyScanError, type WorkflowGateQueueMessage } from "./scan-job";

// A release whose changed (release-delta) findings reach these levels is
// recommended for rejection in the workbench; everything below is recommended
// for approval. This is advisory only — a human drives the actual decision.
// The threshold is a product decision held in one place so it is easy to tune.
const BLOCKING_RISKS: ReadonlySet<RiskLevel> = new Set<RiskLevel>(["high", "critical"]);

export function recommendationForReleaseRisk(releaseRisk: RiskLevel): "approved" | "rejected" {
  return BLOCKING_RISKS.has(releaseRisk) ? "rejected" : "approved";
}

/**
 * Review a resolved PyPI workflow gate end to end and leave it pending for a
 * human decision.
 *
 * Trust boundary: the installation token never enters the sandbox. Artifact
 * bytes are fetched + SHA-256-verified in the control plane (`prepare…`), then
 * the credentials-free sandbox parser turns them into evidence the existing
 * deterministic rules run against via `runScanPipeline`.
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
 *  - Re-enqueues are idempotent: a gate that already has a scan attached is not
 *    re-reviewed, and an already-decided gate re-delivers its stored decision so
 *    a transient callback failure can be retried without re-running the review.
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

  // A prior delivery already reviewed this gate and attached its scan; it is
  // waiting on a human decision. Re-enqueues (GitHub redelivery, queue retry)
  // must not re-run the pipeline.
  if (gate.scanId) {
    emitOperationalEvent("info", "github_workflow_gate.job_skipped", {
      organizationId,
      gateId,
      reason: "already_reviewed",
    });
    return;
  }

  await recordScanEvent(db, {
    organizationId,
    scanId: gate.scanId,
    type: "github_workflow_gate.received",
    metadata: {
      gateId: gate.id,
      repositoryFullName: gate.repositoryFullName,
      environment: gate.environment,
      runId: gate.runId,
    },
  });

  let prepared;
  try {
    prepared = await preparePyPiReleaseCandidateForGate(env, executionCtx, db, {
      config,
      organizationId,
      gateId,
    });
  } catch (err) {
    if (err instanceof WorkflowArtifactError) {
      // The published artifacts could not be verified against the reviewed
      // manifest (missing bundle, tampered digest, package mismatch, …). Block
      // the deployment with a generic comment; the typed reason is already
      // stored on the gate by `preparePyPiReleaseCandidateForGate`.
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
      scanId: gate.scanId,
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

  const scanId = crypto.randomUUID();
  const stageId = `workflow-gate:${gate.id}`;
  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId,
    ownerUserId,
    source: "workflow_gate",
  });

  let result;
  try {
    result = await runScanPipeline(
      { env, executionCtx, db, session: { userId: ownerUserId } },
      pypiAdapter,
      {
        scanId,
        stageId,
        organizationId,
        manifest: prepared.adapterInput.manifest,
        artifacts: prepared.adapterInput.artifacts,
      },
    );
  } catch (err) {
    const safe = classifyScanError(err);
    await markScanFailed(db, scanId, organizationId, safe);
    await recordScanEvent(db, {
      organizationId,
      actorUserId: ownerUserId,
      scanId,
      type: "github_workflow_gate.review_failed",
      metadata: { gateId: gate.id, error: safe },
    });
    emitOperationalEvent("error", "github_workflow_gate.review_failed", {
      organizationId,
      gateId,
      scanId,
      durationMs: durationMsSince(startedAtMs),
      error: safe,
    });
    return;
  }

  const releaseRisk = result.riskSummary.releaseRisk;
  const recommendation = recommendationForReleaseRisk(releaseRisk);

  await recordScanEvent(db, {
    organizationId,
    actorUserId: ownerUserId,
    scanId,
    type: "github_workflow_gate.reviewed",
    metadata: {
      gateId: gate.id,
      recommendation,
      releaseRisk,
      artifactRisk: result.risk,
      contextRisk: result.riskSummary.contextRisk,
      packageName: result.package.name,
      stagedVersion: result.package.stagedVersion,
    },
  });

  // Link the gate to its completed review and leave it PENDING. A maintainer
  // drives the decision from the workbench; the recommendation above is
  // advisory. Attaching last means a transient pipeline failure leaves
  // gate.scanId unset so a retry re-runs the review.
  await attachScanToGate(db, gate.id, scanId);

  emitOperationalEvent("info", "github_workflow_gate.review_ready", {
    organizationId,
    gateId,
    scanId,
    releaseRisk,
    recommendation,
    durationMs: durationMsSince(startedAtMs),
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
  await deliverGateDecision(config, db, decided);
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
