import type { AppDb } from "../../db/client";
import type { GithubAppConfig } from "../github-app/config";
import { getInstallationExternalId } from "../github-app/persistence";
import { postDeploymentProtectionDecision } from "../github-app/webhook";
import type { WorkflowGateRecord } from "../github-app/webhook-gates";
import { describeOperationalError, emitOperationalEvent } from "../platform/observability";

/**
 * POST a gate's stored decision to GitHub's deployment-protection callback.
 * The decision is already durable on the gate row; this only tells GitHub.
 * Callback errors propagate so the caller (queue job or route) can retry.
 */
export async function deliverGateDecision(
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

/**
 * Re-delivery of a gate that a previous delivery already decided, with the
 * outcome observed. Callback errors are rethrown so the queue can retry until
 * GitHub receives the durable decision.
 */
export async function redeliverGateDecision(
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
