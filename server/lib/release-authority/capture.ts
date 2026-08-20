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
      workflowPath: snapshot.run.workflowPath,
      excludeGateId: gate.id,
    });

    // Only asked when this release path has no baseline of its own: the answer
    // separates a target's genuine first release from a target with approved
    // history that just gained another way to publish.
    const approvedReleasePaths = baseline
      ? []
      : await listApprovedReleasePaths(db, {
          organizationId: gate.organizationId,
          releaseTargetId: gate.releaseTargetId,
          excludeGateId: gate.id,
          excludeWorkflowPath: snapshot.run.workflowPath,
        });

    const delta = computeReleaseAuthorityDelta(snapshot, baseline, { approvedReleasePaths });

    await recordReleaseAuthoritySnapshot(db, {
      organizationId: gate.organizationId,
      releaseTargetId: gate.releaseTargetId,
      gateId: gate.id,
      runId: gate.runId,
      workflowPath: snapshot.run.workflowPath,
      headSha: snapshot.run.headSha,
      snapshot,
      delta,
      artifactBindingDigest: await computeArtifactBindingDigest(artifacts),
    });

    await recordScanEvent(db, {
      organizationId: gate.organizationId,
      type: "github_workflow_gate.authority_captured",
      metadata: {
        gateId: gate.id,
        status: delta.status,
        changeCount: delta.changeCount,
        highestSignificance: delta.highestSignificance,
        coverageComplete: delta.standing.coverageComplete,
        workflowCount: snapshot.workflows.length,
      },
    });

    emitOperationalEvent("info", "github_workflow_gate.authority_captured", {
      organizationId: gate.organizationId,
      gateId: gate.id,
      status: delta.status,
      changeCount: delta.changeCount,
      highestSignificance: delta.highestSignificance,
      coverageComplete: delta.standing.coverageComplete,
      durationMs: durationMsSince(startedAtMs),
    });
    return delta;
  } catch (err) {
    // Never block or fail the review on a capture problem. The absent record is
    // itself the signal: the workbench shows the authority as not captured
    // rather than implying it was checked and found unchanged.
    emitOperationalEvent("warn", "github_workflow_gate.authority_capture_failed", {
      organizationId: gate.organizationId,
      gateId: gate.id,
      durationMs: durationMsSince(startedAtMs),
      error: describeOperationalError(err),
    });
    return null;
  }
}
