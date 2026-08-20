import { atpmAdapter } from ".";
import { parseAtpmPackageName, resolveAtpmRepoIdentity } from "./identity";
import { listAtpmStagedVersions, type AtpmStagedVersion } from "./stage-record";
import { formatAtpmStageId } from "./stage-ref";
import { WorkflowArtifactError } from "../../github-app/artifacts";
import type { AdapterBroker, PackageAdapter } from "../package-adapter";
import type {
  ArchiveContents,
  PreparedReleaseCandidate,
  TargetGateContext,
  WorkflowGateAdapter,
} from "../../workflow-gates/types";

/**
 * atpm's workflow gate: holding the *approval* job rather than the publish job.
 *
 * Every other gate exists because a registry cannot hold a private candidate,
 * so CI has to upload one and Drydock reviews the upload. atpm does not have
 * that problem — `npm stage publish` already produces a candidate the publisher
 * can leave unapproved, and a trusted publisher with `allowPublish: false`
 * makes that the only thing CI is permitted to do. The release is therefore
 * already paused before GitHub is involved.
 *
 * What a gate adds is where the pause is *visible* and who ends it. A workflow
 * shaped as "stage, then approve in a protected environment" shows the hold in
 * the Actions UI, records the decision against the deployment, and lets the
 * approval run from CI instead of a laptop. Drydock reviews the staged record
 * and answers the deployment-protection request; the approve step is the
 * workflow's own `npm stage approve`.
 *
 * The candidate is not an upload, so this adapter uses
 * `prepareReleaseCandidatesFromTarget` and never classifies a bundle entry. It
 * still owes the runner the binding a downloaded bundle would have given for
 * free, and it pays for that with the Sigstore certificate: a candidate is
 * matched to this gate only when its verified build provenance names this
 * repository *and this run*. That is a stronger link than any gate here has —
 * an artifact name is a convention, while the run URI is inside a certificate
 * Fulcio issued to that run's OIDC identity — and it is why an unattested
 * candidate cannot be gated at all.
 */
export const atpmWorkflowGateAdapter: WorkflowGateAdapter = {
  ecosystem: "atpm",
  // Nothing is downloaded from the run. The name is part of the contract, so it
  // is stated rather than left undefined, but the runner never uses it.
  artifactName: "atpm-release-candidate",
  packageAdapter: atpmAdapter as unknown as PackageAdapter<unknown, AdapterBroker>,

  // A gate whose candidates come from the publisher's repository never reaches
  // the bundle path, so neither classifier can ever claim anything. Returning
  // null also keeps atpm out of auto-detect targets, where an uploaded `.tgz`
  // must stay npm's.
  classifyArtifact(): null {
    return null;
  },

  detectArtifact(_contents: ArchiveContents): null {
    return null;
  },

  prepareReleaseCandidates(): PreparedReleaseCandidate[] {
    throw new WorkflowArtifactError(
      "bundle_empty",
      "atpm gates review the publisher's staged record, not an uploaded bundle",
    );
  },

  async prepareReleaseCandidatesFromTarget(
    context: TargetGateContext,
  ): Promise<PreparedReleaseCandidate[]> {
    const identity = await resolveTargetPublisher(context.publisherRef);
    const staged = await listStagedForGate(identity, context);

    const bound = staged.filter((candidate) =>
      isBuiltByRun(candidate, context.repositoryFullName, context.runId),
    );
    if (!bound.length) {
      // Fail closed, and say which of the two things went wrong. A run that
      // staged nothing is a workflow-ordering mistake; a candidate that exists
      // but is not attested to this run is the case a gate must never wave
      // through, because approving it would publish bytes this deployment did
      // not build.
      throw new WorkflowArtifactError(
        "candidate_not_bound_to_run",
        staged.length
          ? `no staged atpm candidate carries verified provenance for run ${context.runId} of ${context.repositoryFullName}`
          : `publisher ${identity.did} has no staged atpm candidate for run ${context.runId}`,
      );
    }

    return bound.map((candidate) => ({
      ecosystem: "atpm",
      pipelineInput: { stageId: formatAtpmStageId(identity.did, candidate.rkey) },
      package: { name: candidate.declaredName, version: candidate.version },
    }));
  },
};

/**
 * Resolve the publishing account a release target names.
 *
 * A handle is accepted because it is what a maintainer knows, and resolution
 * verifies it bidirectionally before anything is read — so a handle that has
 * since moved to another account fails here rather than gating that account's
 * releases.
 */
async function resolveTargetPublisher(publisherRef: string | null) {
  const ref = publisherRef?.trim() ? parseAtpmPackageName(`${publisherRef.trim()}/x`) : null;
  if (!ref) {
    throw new WorkflowArtifactError(
      "release_target_misconfigured",
      "atpm release targets must name the publishing account as @handle or a DID",
    );
  }
  try {
    return await resolveAtpmRepoIdentity(ref);
  } catch (err) {
    throw new WorkflowArtifactError(
      "release_target_misconfigured",
      `atpm publisher ${publisherRef} did not resolve: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }
}

async function listStagedForGate(
  identity: Awaited<ReturnType<typeof resolveAtpmRepoIdentity>>,
  context: TargetGateContext,
): Promise<AtpmStagedVersion[]> {
  try {
    return await listAtpmStagedVersions(identity);
  } catch (err) {
    throw new WorkflowArtifactError(
      "bundle_unavailable",
      `could not read staged candidates for ${identity.did} (gate ${context.repositoryFullName}#${context.runId}): ${
        err instanceof Error ? err.message : "unknown error"
      }`,
    );
  }
}

/**
 * Whether a staged candidate's verified provenance names this repository and
 * this workflow run.
 *
 * Both halves come out of the Fulcio certificate, so neither is something the
 * publisher's record can restate. The run invocation URI is
 * `https://github.com/<owner>/<repo>/actions/runs/<id>/attempts/<n>`; the
 * attempt is not compared, since a re-run of the same run legitimately stages
 * the candidate this gate is holding.
 */
export function isBuiltByRun(
  candidate: AtpmStagedVersion,
  repositoryFullName: string,
  runId: number,
): boolean {
  if (candidate.provenance.status !== "verified") return false;
  const { sourceRepository, runInvocation } = candidate.provenance.provenance;
  if (sourceRepository.toLowerCase() !== `https://github.com/${repositoryFullName}`.toLowerCase()) {
    return false;
  }
  if (!runInvocation) return false;
  let path: string;
  try {
    const url = new URL(runInvocation);
    if (url.hostname.toLowerCase() !== "github.com") return false;
    path = url.pathname;
  } catch {
    return false;
  }
  const expected = `/${repositoryFullName.toLowerCase()}/actions/runs/${runId}`;
  const actual = path.toLowerCase();
  return actual === expected || actual.startsWith(`${expected}/`);
}
