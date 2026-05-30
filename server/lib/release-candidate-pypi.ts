import { and, eq } from "drizzle-orm";
import type { AppDb } from "../db";
import { githubAppInstallations, githubReleaseTargets } from "../db/schema";
import {
  normalizePyPiProjectName,
  parsePyPiReleaseManifest,
  preparePyPiArtifact,
  PYPI_RELEASE_MANIFEST_SCHEMA,
  type PyPiAdapterInput,
  type PyPiArtifactInput,
  type PyPiArtifactKind,
  type PyPiPreparedArtifact,
  type PyPiReleaseManifest,
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
 * the outer ZIP is parsed with hardened limits, and every wheel/sdist SHA-256
 * is recomputed from the bundle bytes.
 *
 * Step 2 hands each wheel/sdist's bytes to the credentials-free
 * `downloadInSandboxInline` path so the same untrusted-archive parser the npm
 * pipeline uses produces bounded `FileRecord[]` evidence, then derives the
 * release identity from the parsed `METADATA`/`PKG-INFO` (see
 * `deriveReleaseManifest`).
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
  const prepared = artifacts.map(preparePyPiArtifact);
  const manifest = deriveReleaseManifest(bundle, prepared);
  return {
    adapterInput: { manifest, artifacts },
    bundle,
  };
}

/**
 * Synthesize the `PyPiReleaseManifest` the rest of the pipeline consumes from
 * the artifacts themselves. There is no maintainer-declared manifest: identity
 * comes from each wheel's `METADATA` / sdist's `PKG-INFO`, and the SHA-256 is
 * the digest already recomputed from the bundle bytes.
 *
 * Every artifact must expose a `Name`/`Version` and agree on the normalized
 * (PEP 503) name and the version, so a foreign or version-skewed file slipped
 * into the bundle is rejected rather than silently shipped.
 */
function deriveReleaseManifest(
  bundle: ResolvedReleaseBundle,
  prepared: PyPiPreparedArtifact[],
): PyPiReleaseManifest {
  let name: string | null = null;
  let normalizedName: string | null = null;
  let version: string | null = null;
  for (const artifact of prepared) {
    const { summary } = artifact;
    if (!summary.name || !summary.version) {
      throw new WorkflowArtifactError(
        "artifact_identity_missing",
        `${artifact.path} does not expose a PyPI Name/Version in its metadata`,
      );
    }
    const normalized = normalizePyPiProjectName(summary.name);
    if (name === null) {
      name = summary.name;
      normalizedName = normalized;
      version = summary.version;
      continue;
    }
    if (normalized !== normalizedName) {
      throw new WorkflowArtifactError(
        "artifact_identity_inconsistent",
        `${artifact.path} package ${summary.name} disagrees with ${name}`,
      );
    }
    if (summary.version !== version) {
      throw new WorkflowArtifactError(
        "artifact_identity_inconsistent",
        `${artifact.path} version ${summary.version} disagrees with ${version}`,
      );
    }
  }

  // `prepared` is non-empty: the resolver throws `bundle_empty` when a bundle
  // has no wheels/sdists, so `name`/`version` are always set here.
  const candidate = {
    schema: PYPI_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "pypi",
    package: name,
    version,
    artifacts: bundle.artifacts.map((file) => ({ path: file.path, sha256: file.sha256 })),
  };
  try {
    return parsePyPiReleaseManifest(candidate);
  } catch (err) {
    throw new WorkflowArtifactError(
      "artifact_identity_missing",
      err instanceof Error ? err.message : "derived release identity is not valid",
    );
  }
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
    const prepared = await preparePyPiReleaseCandidateFromBundle(env, ctx, bundle);
    const derivedPackage = normalizePyPiProjectName(prepared.adapterInput.manifest.package);
    if (derivedPackage !== releaseTarget.packageName) {
      throw new WorkflowArtifactError(
        "release_target_mismatch",
        `derived package ${derivedPackage} does not match release target ${releaseTarget.packageName}`,
      );
    }
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
