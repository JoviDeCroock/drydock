import { and, eq } from "drizzle-orm";
import type { AppDb } from "../../db";
import { githubAppInstallations, githubReleaseTargets } from "../../db/schema";
import {
  fetchReleaseBundleForGate,
  getGateForOrganization,
  type GithubAppConfig,
  markGateErrored,
  WorkflowArtifactError,
  type WorkflowGateRecord,
} from "../github-app";
import { describeOperationalError, emitOperationalEvent } from "../observability";
import { getWorkflowGateAdapter, UnsupportedEcosystemError } from "./registry";
import type { PreparedReleaseCandidate, WorkflowGateAdapter } from "./types";

export interface PrepareForGateInput {
  config: GithubAppConfig;
  organizationId: string;
  gateId: string;
  /** Overrides the adapter's default GitHub Actions artifact name. */
  artifactName?: string;
}

export interface PreparedGateReleaseCandidate {
  gate: WorkflowGateRecord;
  adapter: WorkflowGateAdapter;
  candidate: PreparedReleaseCandidate;
}

/**
 * Resolve a pending workflow gate into the scan-pipeline input its ecosystem
 * adapter produces.
 *
 * Ecosystem-neutral plumbing lives here: load the gate + installation + release
 * target, select the adapter by `release_target.ecosystem`, fetch the GitHub
 * Actions artifact bundle (the installation token is swapped + used only in the
 * control plane, never in the sandbox), and hand the verified bundle to the
 * adapter. Any `WorkflowArtifactError` (or downstream sandbox parse failure)
 * transitions the pending gate to `errored` with the typed code so it cannot
 * advance to scanning.
 */
export async function prepareReleaseCandidateForGate(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  db: AppDb,
  input: PrepareForGateInput,
): Promise<PreparedGateReleaseCandidate> {
  const gate = await getGateForOrganization(db, input.organizationId, input.gateId);
  if (!gate) {
    throw new WorkflowArtifactError(
      "bundle_unavailable",
      `workflow gate ${input.gateId} not found in organization`,
    );
  }
  if (gate.status !== "pending") {
    throw new WorkflowArtifactError(
      "bundle_unavailable",
      `workflow gate ${gate.id} is not pending (status=${gate.status})`,
    );
  }

  const [installation] = await db
    .select()
    .from(githubAppInstallations)
    .where(
      and(
        eq(githubAppInstallations.id, gate.installationRowId),
        eq(githubAppInstallations.organizationId, gate.organizationId),
      ),
    )
    .limit(1);
  if (!installation) {
    await markGateErroredSafe(db, gate.id, "installation_missing");
    throw new WorkflowArtifactError(
      "bundle_unavailable",
      `installation row ${gate.installationRowId} missing for gate ${gate.id}`,
    );
  }
  if (installation.status !== "active") {
    await markGateErroredSafe(db, gate.id, `installation_${installation.status}`);
    throw new WorkflowArtifactError(
      "bundle_unavailable",
      `installation ${installation.installationId} is ${installation.status}`,
    );
  }

  const [releaseTarget] = await db
    .select()
    .from(githubReleaseTargets)
    .where(
      and(
        eq(githubReleaseTargets.id, gate.releaseTargetId),
        eq(githubReleaseTargets.organizationId, gate.organizationId),
      ),
    )
    .limit(1);
  if (!releaseTarget) {
    await markGateErroredSafe(db, gate.id, "release_target_missing");
    throw new WorkflowArtifactError(
      "bundle_unavailable",
      `release target ${gate.releaseTargetId} missing for gate ${gate.id}`,
    );
  }

  let adapter: WorkflowGateAdapter;
  try {
    adapter = getWorkflowGateAdapter(releaseTarget.ecosystem);
  } catch (err) {
    if (err instanceof UnsupportedEcosystemError) {
      // A configuration/data problem, not an artifact verification failure: mark
      // the gate errored for visibility and rethrow so the runner leaves it
      // pending (never auto-approved) rather than fail-closing the deployment.
      await markGateErroredSafe(db, gate.id, "unsupported_ecosystem");
      emitOperationalEvent("error", "github_workflow_gate.unsupported_ecosystem", {
        gateId: gate.id,
        organizationId: gate.organizationId,
        ecosystem: releaseTarget.ecosystem,
      });
    }
    throw err;
  }

  try {
    const bundle = await fetchReleaseBundleForGate(
      input.config,
      {
        installationExternalId: installation.installationId,
        repositoryFullName: gate.repositoryFullName,
        runId: gate.runId,
        artifactName: input.artifactName ?? adapter.artifactName,
      },
      adapter.classifyArtifact,
    );
    const candidate = await adapter.prepareReleaseCandidate(env, ctx, { bundle });
    return { gate, adapter, candidate };
  } catch (err) {
    const reason = err instanceof WorkflowArtifactError ? err.code : "preparation_failed";
    await markGateErroredSafe(db, gate.id, reason);
    emitOperationalEvent("error", "github_workflow_gate.bundle_failed", {
      gateId: gate.id,
      organizationId: gate.organizationId,
      repositoryFullName: gate.repositoryFullName,
      runId: gate.runId,
      ecosystem: releaseTarget.ecosystem,
      reason,
      error: describeOperationalError(err),
    });
    throw err;
  }
}

async function markGateErroredSafe(db: AppDb, gateId: string, reason: string): Promise<void> {
  try {
    await markGateErrored(db, gateId, reason);
  } catch (err) {
    emitOperationalEvent("error", "github_workflow_gate.mark_errored_failed", {
      gateId,
      reason,
      error: describeOperationalError(err),
    });
  }
}
