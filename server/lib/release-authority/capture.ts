// Capture the release authority behind a workflow gate and compare it to the
// last approved baseline.
//
// This is the only place the three halves meet: the GitHub fetch (control
// plane, installation token), the pure projection + delta, and persistence.
// It is deliberately best effort — a gate review must never fail because a
// workflow definition could not be read. When capture cannot complete, no
// record is written and the review renders "authority not captured", which is
// visibly different from "authority unchanged".

import type { AppDb } from "../../db/client";
import { recordScanEvent } from "../../db/events";
import {
  deleteReleaseAuthorityForGate,
  findApprovedAuthorityBaseline,
  listApprovedReleasePaths,
  recordReleaseAuthoritySnapshot,
} from "../../db/release-authority";
import { fetchReleaseAuthoritySources } from "../github-app/workflow-source";
import type { GithubAppConfig } from "../github-app/config";
import type { WorkflowGateRecord } from "../github-app/webhook-gates";
import {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
} from "../platform/observability";
import type { PreparedGateArtifactRef } from "../workflow-gates/prepare";
import { computeReleaseAuthorityDelta, type ReleaseAuthorityDelta } from "./delta";
import {
  type AuthorityArtifact,
  buildReleaseAuthoritySnapshot,
  computeArtifactBindingDigest,
} from "./snapshot";

export interface CaptureReleaseAuthorityInput {
  config: GithubAppConfig;
  gate: WorkflowGateRecord;
  installationExternalId: string;
  artifacts: PreparedGateArtifactRef[];
}

/**
 * Snapshot the gate's release authority, diff it against the last approved
 * baseline for the same release boundary, and persist both. Returns the delta
 * for the caller's telemetry, or null when nothing could be captured.
 */
export async function captureReleaseAuthority(
  db: AppDb,
  input: CaptureReleaseAuthorityInput,
): Promise<ReleaseAuthorityDelta | null> {
  const { gate } = input;
  const startedAtMs = Date.now();
  let captured: {
    delta: ReleaseAuthorityDelta;
    workflowCount: number;
  };

  try {
    const sources = await fetchReleaseAuthoritySources(input.config, {
      installationExternalId: input.installationExternalId,
      repositoryFullName: gate.repositoryFullName,
      environment: gate.environment,
      runId: gate.runId,
    });

    const artifacts: AuthorityArtifact[] = input.artifacts.map((artifact) => ({
      name: artifact.path,
      kind: artifact.kind,
      sha256: artifact.sha256,
    }));

    const snapshot = await buildReleaseAuthoritySnapshot({
      run: sources.run,
      workflows: sources.workflows,
      artifacts,
      unresolved: sources.unresolved,
    });

    const baseline = await findApprovedAuthorityBaseline(db, {
      organizationId: gate.organizationId,
      releaseTargetId: gate.releaseTargetId,
      workflowPath: sources.run.workflowPath,
      excludeGateId: gate.id,
    });
    const readableBaseline = baseline?.snapshot
      ? { snapshot: baseline.snapshot, ref: baseline.ref }
      : null;

    // Only asked when this release path has no baseline of its own: the answer
    // separates a target's genuine first release from a target with approved
    // history that just gained another way to publish.
    const approvedReleasePaths = baseline
      ? []
      : await listApprovedReleasePaths(db, {
          organizationId: gate.organizationId,
          releaseTargetId: gate.releaseTargetId,
          excludeGateId: gate.id,
          excludeWorkflowPath: sources.run.workflowPath,
        });

    const delta = computeReleaseAuthorityDelta(snapshot, readableBaseline, {
      approvedReleasePaths,
      unreadableBaseline: baseline?.snapshot ? undefined : baseline?.ref,
    });

    await recordReleaseAuthoritySnapshot(db, {
      organizationId: gate.organizationId,
      releaseTargetId: gate.releaseTargetId,
      gateId: gate.id,
      runId: gate.runId,
      workflowPath: sources.run.workflowPath,
      headSha: sources.run.headSha,
      snapshot,
      delta,
      artifactBindingDigest: await computeArtifactBindingDigest(artifacts),
    });
    captured = { delta, workflowCount: snapshot.workflows.length };
  } catch (err) {
    // Never block or fail the review on a capture problem. The absent record is
    // itself the signal: the workbench shows the authority as not captured
    // rather than implying it was checked and found unchanged. The review-claim
    // CAS clears a predecessor atomically; this cleanup also preserves the
    // contract for direct callers and failures after a partial write.
    try {
      await deleteReleaseAuthorityForGate(db, {
        organizationId: gate.organizationId,
        gateId: gate.id,
      });
    } catch (cleanupError) {
      emitOperationalEvent("warn", "github_workflow_gate.authority_cleanup_failed", {
        organizationId: gate.organizationId,
        gateId: gate.id,
        error: describeOperationalError(cleanupError),
      });
    }
    emitOperationalEvent("warn", "github_workflow_gate.authority_capture_failed", {
      organizationId: gate.organizationId,
      gateId: gate.id,
      durationMs: durationMsSince(startedAtMs),
      error: describeOperationalError(err),
    });
    return null;
  }

  // Audit bookkeeping is downstream of durable capture. If it fails, retain
  // and return the current evidence rather than misclassifying a successful
  // capture as "not assessed" or deleting the row that was just written.
  try {
    await recordScanEvent(db, {
      organizationId: gate.organizationId,
      type: "github_workflow_gate.authority_captured",
      metadata: {
        gateId: gate.id,
        status: captured.delta.status,
        changeCount: captured.delta.changeCount,
        highestSignificance: captured.delta.highestSignificance,
        coverageComplete: captured.delta.standing.coverageComplete,
        workflowCount: captured.workflowCount,
      },
    });
  } catch (err) {
    emitOperationalEvent("warn", "github_workflow_gate.authority_audit_failed", {
      organizationId: gate.organizationId,
      gateId: gate.id,
      error: describeOperationalError(err),
    });
  }

  emitOperationalEvent("info", "github_workflow_gate.authority_captured", {
    organizationId: gate.organizationId,
    gateId: gate.id,
    status: captured.delta.status,
    changeCount: captured.delta.changeCount,
    highestSignificance: captured.delta.highestSignificance,
    coverageComplete: captured.delta.standing.coverageComplete,
    durationMs: durationMsSince(startedAtMs),
  });
  return captured.delta;
}
