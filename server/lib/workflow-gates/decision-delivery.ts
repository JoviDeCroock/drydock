import type { AppDb } from "../../db/client";
import { recordScanEvent } from "../../db/events";
import type { GithubAppConfig } from "../github-app/config";
import { getInstallationExternalId } from "../github-app/persistence";
import { postDeploymentProtectionDecision } from "../github-app/webhook";
import {
  type WorkflowGateRecord,
  markGateDecisionDelivered,
  withdrawUndeliveredGateApproval,
} from "../github-app/webhook-gates";
import { describeOperationalError, emitOperationalEvent } from "../platform/observability";
import { type GateStaleReviewReason, checkGateReviewBinding } from "./review-binding";

export type GateDeliveryOutcome =
  | { delivered: true; alreadyDelivered: boolean }
  | {
      delivered: false;
      withdrawn: GateStaleReviewReason;
      clearedApprovals: Awaited<ReturnType<typeof withdrawUndeliveredGateApproval>>;
    };

/**
 * POST a gate's stored decision to GitHub's deployment-protection callback.
 * The decision is already durable on the gate row; this only tells GitHub.
 * Callback errors propagate so the caller (queue job or route) can retry.
 *
 * The callback is per run, so it acts on whatever the run holds when it lands.
 * A decision GitHub already accepted is therefore never posted again: a
 * replayed request after a re-run would otherwise release the new attempt. An
 * approval is posted only with a review binding that GitHub still reports; a
 * changed or missing binding withdraws it instead. A rejection needs no check.
 */
export async function deliverGateDecision(
  config: GithubAppConfig,
  db: AppDb,
  gate: WorkflowGateRecord,
): Promise<GateDeliveryOutcome> {
  if (gate.decision !== "approved" && gate.decision !== "rejected") {
    throw new Error(`gate ${gate.id} has no decision to deliver`);
  }
  if (gate.decisionDeliveredAt) return { delivered: true, alreadyDelivered: true };
  if (gate.decision === "approved") {
    const check = await checkGateReviewBinding(config, db, gate);
    if (!check.ok) {
      const clearedApprovals = await withdrawUndeliveredGateApproval(db, gate, check.reason);
      return { delivered: false, withdrawn: check.reason, clearedApprovals };
    }
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
  try {
    await markGateDecisionDelivered(db, gate.id);
  } catch (err) {
    // GitHub has the decision; failing here would only re-post it.
    emitOperationalEvent("warn", "github_workflow_gate.delivery_record_failed", {
      organizationId: gate.organizationId,
      gateId: gate.id,
      error: describeOperationalError(err),
    });
  }
  return { delivered: true, alreadyDelivered: false };
}

/**
 * Re-delivery of a gate that a previous delivery already decided, with the
 * outcome observed. Callback errors are rethrown so the queue can retry until
 * GitHub receives the durable decision; a withdrawn approval is final.
 */
export async function redeliverGateDecision(
  config: GithubAppConfig,
  db: AppDb,
  gate: WorkflowGateRecord,
): Promise<void> {
  let outcome: GateDeliveryOutcome;
  try {
    outcome = await deliverGateDecision(config, db, gate);
  } catch (err) {
    emitOperationalEvent("warn", "github_workflow_gate.redelivery_failed", {
      organizationId: gate.organizationId,
      gateId: gate.id,
      error: describeOperationalError(err),
    });
    throw err;
  }
  if (!outcome.delivered) {
    emitOperationalEvent("warn", "github_workflow_gate.approval_withdrawn", {
      organizationId: gate.organizationId,
      gateId: gate.id,
      reason: outcome.withdrawn,
    });
    // Gate-level so a later re-review, which discards the package scans, keeps it.
    await recordScanEvent(db, {
      organizationId: gate.organizationId,
      type: "github_workflow_gate.approval_withdrawn",
      metadata: {
        gateId: gate.id,
        reason: outcome.withdrawn,
        clearedApprovals: outcome.clearedApprovals,
      },
    });
    return;
  }
  emitOperationalEvent("info", "github_workflow_gate.decision_redelivered", {
    organizationId: gate.organizationId,
    gateId: gate.id,
    decision: gate.decision,
    alreadyDelivered: outcome.alreadyDelivered,
  });
}
