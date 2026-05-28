import { and, eq } from "drizzle-orm";
import type { AppDb } from "../db";
import { githubAppInstallations, githubReleaseTargets } from "../db/schema";
import {
  normalizePyPiProjectName,
  type PyPiAdapterInput,
  type PyPiArtifactInput,
  type PyPiArtifactKind,
} from "./adapters/pypi/index";
import {
  fetchReleaseBundleForGate,
  WorkflowArtifactError,
  type ResolvedReleaseBundle,
  type ResolvedReleaseFile,
  type WorkflowArtifactSource,
} from "./github-app-artifacts";
import { type GithubAppConfig } from "./github-app";
import {
  getGateForOrganization,
  markGateErrored,
  type WorkflowGateRecord,
} from "./github-app-webhook";
import { describeOperationalError, emitOperationalEvent } from "./observability";
import { downloadInSandboxInline, type DownloadResult } from "./sandbox";

export interface PreparePyPiReleaseCandidateInput {
  config: GithubAppConfig;
  source: WorkflowArtifactSource;
}

export interface PreparedPyPiReleaseCandidate {
  adapterInput: PyPiAdapterInput;
  bundle: ResolvedReleaseBundle;
}

/**
 * Resolve a pending PyPI workflow gate into a `PyPiAdapterInput` the existing
 * adapter can run findings against.
 *
 * Step 1 (`fetchReleaseBundleForGate`) lives entirely in the control plane:
 * the GitHub installation token is used to list and download artifact bytes,
 * the outer ZIP is parsed with hardened limits, the manifest is validated,
 * and every wheel/sdist SHA-256 is recomputed and compared to the manifest.
 *
 * Step 2 hands each wheel/sdist's bytes to the credentials-free
 * `downloadInSandboxInline` path so the same untrusted-archive parser the npm
 * pipeline uses produces bounded `FileRecord[]` evidence.
 */
export async function preparePyPiReleaseCandidate(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  input: PreparePyPiReleaseCandidateInput,
): Promise<PreparedPyPiReleaseCandidate> {
  const bundle = await fetchReleaseBundleForGate(input.config, input.source);
  return preparePyPiReleaseCandidateFromBundle(env, ctx, bundle);
}

async function preparePyPiReleaseCandidateFromBundle(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  bundle: ResolvedReleaseBundle,
): Promise<PreparedPyPiReleaseCandidate> {
  const artifacts: PyPiArtifactInput[] = [];
  for (const artifact of bundle.artifacts) {
    const files = await parseArtifactBytes(env, ctx, artifact);
    artifacts.push({ path: artifact.path, files });
  }
  return {
    adapterInput: { manifest: bundle.manifest, artifacts },
    bundle,
  };
}

export interface PrepareForGateInput {
  config: GithubAppConfig;
  organizationId: string;
  gateId: string;
  artifactName?: string;
}

export interface PreparedPyPiReleaseCandidateForGate extends PreparedPyPiReleaseCandidate {
  gate: WorkflowGateRecord;
}

/**
 * Gate-aware wrapper. On any `WorkflowArtifactError` (or downstream sandbox
 * parse failure) the pending gate is transitioned to `errored` with the
 * typed code so it cannot advance to scanning.
 */
export async function preparePyPiReleaseCandidateForGate(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  db: AppDb,
  input: PrepareForGateInput,
): Promise<PreparedPyPiReleaseCandidateForGate> {
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

  try {
    const bundle = await fetchReleaseBundleForGate(input.config, {
      installationExternalId: installation.installationId,
      repositoryFullName: gate.repositoryFullName,
      runId: gate.runId,
      artifactName: input.artifactName,
    });
    const manifestPackage = normalizePyPiProjectName(bundle.manifest.package);
    if (manifestPackage !== releaseTarget.packageName) {
      throw new WorkflowArtifactError(
        "release_target_mismatch",
        `manifest package ${manifestPackage} does not match release target ${releaseTarget.packageName}`,
      );
    }
    const prepared = await preparePyPiReleaseCandidateFromBundle(env, ctx, bundle);
    return { ...prepared, gate };
  } catch (err) {
    const reason = err instanceof WorkflowArtifactError ? err.code : "preparation_failed";
    await markGateErroredSafe(db, gate.id, reason);
    emitOperationalEvent("error", "github_workflow_gate.bundle_failed", {
      gateId: gate.id,
      organizationId: gate.organizationId,
      repositoryFullName: gate.repositoryFullName,
      runId: gate.runId,
      reason,
      error: describeOperationalError(err),
    });
    throw err;
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

async function parseArtifactBytes(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  artifact: ResolvedReleaseFile,
): Promise<DownloadResult["files"]> {
  const format = inlineFormatForKind(artifact.kind);
  const result = await downloadInSandboxInline(env, ctx, {
    bytes: artifact.bytes,
    format,
  });
  return result.files;
}

function inlineFormatForKind(kind: PyPiArtifactKind): "zip" | "tgz" {
  return kind === "wheel" ? "zip" : "tgz";
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
