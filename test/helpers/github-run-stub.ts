/**
 * GitHub Actions run doubles for workflow-gate tests: `GET /actions/runs/{id}`
 * and the run's artifact listing, so the review binding and the approval
 * re-check see a known attempt and artifact set.
 */

export interface StubRunArtifact {
  id: number;
  name: string;
  sizeInBytes: number | null;
  digest: string | null;
}

/** The binding a seeded, already-reviewed gate carries, matching `stubRunState` defaults. */
export const SEEDED_REVIEW_ARTIFACTS: StubRunArtifact[] = [
  { id: 88888, name: "pypi-release-candidate", sizeInBytes: 512, digest: "sha256:seeded" },
];

export function seededReviewBinding(artifacts: StubRunArtifact[] = SEEDED_REVIEW_ARTIFACTS) {
  return {
    runAttempt: 1,
    reviewedArtifactsJson: { artifactName: null, artifactNamePrefix: null, artifacts },
  };
}

/** Answers `GET /repos/:owner/:repo/actions/runs/:id`, or null for any other URL. */
export function githubRunResponse(request: Request, runAttempt = 1): Response | null {
  const match = new URL(request.url).pathname.match(/\/actions\/runs\/(\d+)$/);
  if (!match || request.method !== "GET") return null;
  return Response.json({ id: Number(match[1]), run_attempt: runAttempt });
}

/**
 * Answers the run lookup and the run's artifact listing with the given state;
 * null for any other URL. Defaults match `seededReviewBinding()`.
 */
export function githubRunStateResponse(
  request: Request,
  state: { runAttempt?: number; artifacts?: StubRunArtifact[] } = {},
): Response | null {
  const run = githubRunResponse(request, state.runAttempt ?? 1);
  if (run) return run;
  if (!/\/actions\/runs\/\d+\/artifacts$/.test(new URL(request.url).pathname)) return null;
  const artifacts = state.artifacts ?? SEEDED_REVIEW_ARTIFACTS;
  return Response.json({
    total_count: artifacts.length,
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      size_in_bytes: artifact.sizeInBytes,
      digest: artifact.digest,
      expired: false,
    })),
  });
}
