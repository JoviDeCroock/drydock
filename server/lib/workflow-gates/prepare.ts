import { and, eq } from "drizzle-orm";
import type { AppDb } from "../../db";
import { githubAppInstallations, githubReleaseTargets } from "../../db/schema";
import type { AdapterBroker, PackageAdapter } from "../adapters/types";
import {
  type ClassifyArtifact,
  fetchReleaseBundleForGate,
  getGateForOrganization,
  type GithubAppConfig,
  markGateErrored,
  type ResolvedReleaseBundle,
  WorkflowArtifactError,
  type WorkflowGateRecord,
} from "../github-app";
import { describeOperationalError, emitOperationalEvent } from "../observability";
import {
  classifyBundleArtifact,
  getWorkflowGateAdapter,
  UnsupportedEcosystemError,
} from "./registry";
import { resolveBundleArtifacts } from "./resolve";
import type { ParsedGateArtifact, PreparedReleaseCandidate, WorkflowGateAdapter } from "./types";

export interface PrepareForGateInput {
  config: GithubAppConfig;
  organizationId: string;
  gateId: string;
  /** Narrows artifact discovery to one GitHub Actions artifact name. */
  artifactName?: string;
}

/** One reviewable package derived from the bundle, paired with its review adapter. */
export interface PreparedGatePackage {
  candidate: PreparedReleaseCandidate;
  packageAdapter: PackageAdapter<unknown, AdapterBroker>;
}

export interface PreparedGateRelease {
  gate: WorkflowGateRecord;
  /** One entry per distinct package the bundle publishes (≥ 1). */
  packages: PreparedGatePackage[];
}

/**
 * Resolve a pending workflow gate into the per-package scan-pipeline inputs its
 * ecosystem adapter(s) produce.
 *
 * Ecosystem-neutral plumbing lives here: load the gate + installation + release
 * target, pick the classifier (a pinned ecosystem uses that adapter's
 * classifier; an unpinned target auto-detects across every registered
 * ecosystem), fetch the GitHub Actions artifact bundle (the installation token
 * is swapped + used only in the control plane, never in the sandbox), group the
 * verified artifacts by ecosystem, and hand each ecosystem's slice to its
 * adapter — which splits it into one candidate per distinct package. A monorepo
 * release therefore fans out into several packages, each scanned against its own
 * baseline. Any `WorkflowArtifactError` (or downstream sandbox parse failure)
 * transitions the pending gate to `errored` with the typed code so it cannot
 * advance to scanning.
 */
export async function prepareReleaseCandidatesForGate(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  db: AppDb,
  input: PrepareForGateInput,
): Promise<PreparedGateRelease> {
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

  const ecosystemLabel = releaseTarget.ecosystem ?? "auto";
  const { classify, artifactName } = resolveBundleClassifier(db, gate, releaseTarget, input);

  try {
    const bundle = await fetchReleaseBundleForGate(
      input.config,
      {
        installationExternalId: installation.installationId,
        repositoryFullName: gate.repositoryFullName,
        runId: gate.runId,
        ...(artifactName ? { artifactName } : {}),
      },
      classify,
    );
    const packages = await prepareBundlePackages(env, ctx, bundle);
    return { gate, packages };
  } catch (err) {
    const reason =
      err instanceof WorkflowArtifactError
        ? err.code
        : err instanceof UnsupportedEcosystemError
          ? "unsupported_ecosystem"
          : "preparation_failed";
    await markGateErroredSafe(db, gate.id, reason);
    emitOperationalEvent("error", "github_workflow_gate.bundle_failed", {
      gateId: gate.id,
      organizationId: gate.organizationId,
      repositoryFullName: gate.repositoryFullName,
      runId: gate.runId,
      ecosystem: ecosystemLabel,
      reason,
      error: describeOperationalError(err),
    });
    throw err;
  }
}

/**
 * Pick the artifact classifier + optional upload-name narrowing for a release
 * target. A pinned ecosystem resolves its adapter up front so an unknown
 * ecosystem is surfaced as a configuration error (gate left pending, never
 * auto-approved) rather than a fail-closed artifact rejection; an unpinned target
 * classifies across every registered ecosystem. Unpinned targets inspect every
 * non-expired upload by default, while pinned targets use the adapter's default
 * artifact name unless the release target supplies an override.
 */
function resolveBundleClassifier(
  db: AppDb,
  gate: WorkflowGateRecord,
  releaseTarget: { ecosystem: string | null; artifactName: string | null },
  input: PrepareForGateInput,
): { classify: ClassifyArtifact; artifactName?: string } {
  const override = input.artifactName ?? releaseTarget.artifactName ?? undefined;
  if (releaseTarget.ecosystem === null) {
    return {
      classify: classifyBundleArtifact,
      ...(override ? { artifactName: override } : {}),
    };
  }

  let adapter: WorkflowGateAdapter;
  try {
    adapter = getWorkflowGateAdapter(releaseTarget.ecosystem);
  } catch (err) {
    if (err instanceof UnsupportedEcosystemError) {
      // A configuration/data problem, not an artifact verification failure: mark
      // the gate errored for visibility and rethrow so the runner leaves it
      // pending (never auto-approved) rather than fail-closing the deployment.
      void markGateErroredSafe(db, gate.id, "unsupported_ecosystem");
      emitOperationalEvent("error", "github_workflow_gate.unsupported_ecosystem", {
        gateId: gate.id,
        organizationId: gate.organizationId,
        ecosystem: releaseTarget.ecosystem,
      });
    }
    throw err;
  }
  return {
    classify: (path) => {
      const kind = adapter.classifyArtifact(path);
      return kind ? { ecosystem: adapter.ecosystem, kind } : null;
    },
    artifactName: override ?? adapter.artifactName,
  };
}

/**
 * Parse every verified artifact once in the shared sandbox router, group the
 * parsed artifacts by their (possibly content-resolved) ecosystem, and let each
 * ecosystem's adapter split its slice into one prepared candidate per distinct
 * package.
 */
async function prepareBundlePackages(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  bundle: ResolvedReleaseBundle,
): Promise<PreparedGatePackage[]> {
  const resolved = await resolveBundleArtifacts(env, ctx, bundle);

  const byEcosystem = new Map<string, ParsedGateArtifact[]>();
  for (const artifact of resolved) {
    const slice = byEcosystem.get(artifact.ecosystem);
    if (slice) slice.push(artifact);
    else byEcosystem.set(artifact.ecosystem, [artifact]);
  }

  const packages: PreparedGatePackage[] = [];
  for (const [ecosystem, artifacts] of byEcosystem) {
    const adapter = getWorkflowGateAdapter(ecosystem);
    const candidates = adapter.prepareReleaseCandidates(artifacts);
    for (const candidate of candidates) {
      packages.push({ candidate, packageAdapter: adapter.packageAdapter });
    }
  }
  return packages;
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
