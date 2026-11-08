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
  | { delivered: true }
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
 * An approval GitHub has not yet accepted is re-checked against the run first:
 * the callback releases whatever the run holds now, so a changed attempt or
 * artifact set withdraws the approval instead of posting it. A rejection needs
 * no check.
 */
export async function deliverGateDecision(
  config: GithubAppConfig,
  db: AppDb,
  gate: WorkflowGateRecord,
): Promise<GateDeliveryOutcome> {
  if (gate.decision !== "approved" && gate.decision !== "rejected") {
    throw new Error(`gate ${gate.id} has no decision to deliver`);
  }
  // Unbound approvals predate review bindings; new approvals require one
  // (`markGateDecidedForPackageAggregate`).
  if (gate.decision === "approved" && !gate.decisionDeliveredAt && gate.reviewBinding) {
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
  return { delivered: true };
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
  });
}
