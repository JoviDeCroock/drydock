import type { ResolvedReleaseBundle } from "../github-app";
import type { AdapterBroker, PackageAdapter } from "../adapters/types";

/**
 * Ecosystem-defined classification of a bundle entry. PyPI uses
 * `"wheel" | "sdist"`; other ecosystems pick their own opaque kinds. The shared
 * fetch layer only cares whether `classifyArtifact` returns a kind (the entry is
 * reviewable) or `null` (ignored).
 */
export type WorkflowArtifactKind = string;

/**
 * Result of turning a verified artifact bundle into the input the scan pipeline
 * runs against, plus the derived package identity.
 *
 * `pipelineInput` is spread into `runScanPipeline` options, so its keys must
 * match what `packageAdapter.parseInput` expects (for PyPI: `manifest` +
 * `artifacts`). The shared runner never interprets it.
 */
export interface PreparedReleaseCandidate {
  pipelineInput: Record<string, unknown>;
  package: { name: string; version: string };
}

/**
 * Per-ecosystem behavior for a GitHub deployment-protection workflow gate.
 *
 * The shared runner (`workflow-gate-job.ts` + `workflow-gates/prepare.ts`) owns
 * everything GitHub-shaped: loading the gate row, fetching + bounded ZIP parsing
 * of the Actions artifact bundle, SHA-256 digest recomputation, scan
 * persistence, the approve/reject callback, idempotent re-delivery, and audit
 * events. An adapter only describes the ecosystem's artifact semantics and
 * review wiring:
 *
 *  - `artifactName` — the GitHub Actions artifact the bundle is downloaded from.
 *  - `classifyArtifact` — which bundle entries are reviewable artifacts.
 *  - `prepareReleaseCandidate` — derive package identity + pipeline input from
 *    the verified bundle, rejecting a bundle whose artifacts disagree on the
 *    package identity they carry.
 *  - `packageAdapter` — the deterministic review/baseline/findings adapter the
 *    shared pipeline runs (see `server/lib/adapters/types.ts`); risk-to-decision
 *    mapping stays shared in `recommendationForReleaseRisk`.
 */
export interface WorkflowGateAdapter {
  /** Stable ecosystem id; matches `github_release_targets.ecosystem`. */
  readonly ecosystem: string;

  /** Default GitHub Actions artifact name the release bundle is downloaded from. */
  readonly artifactName: string;

  /** Review adapter driven by `runScanPipeline` for this ecosystem. */
  readonly packageAdapter: PackageAdapter<unknown, AdapterBroker>;

  /**
   * Decide whether a bundle entry is a reviewable artifact. Returning a kind
   * keeps the entry (the kind is opaque to the shared fetcher); returning `null`
   * ignores it (checksums, READMEs, …) so it never reaches the review.
   */
  classifyArtifact(path: string): WorkflowArtifactKind | null;

  /**
   * Turn the verified bundle into the scan-pipeline input and derived identity.
   *
   * Trust boundary: the installation token is already gone — `bundle` holds only
   * artifact bytes whose SHA-256 was recomputed in the control plane. The
   * adapter parses those bytes through the credentials-free sandbox. It must
   * throw `WorkflowArtifactError` when the bundle cannot be trusted (missing or
   * inconsistent artifact identity) so the shared runner fail-closes the
   * deployment.
   */
  prepareReleaseCandidate(
    env: Cloudflare.Env,
    ctx: ExecutionContext,
    args: { bundle: ResolvedReleaseBundle },
  ): Promise<PreparedReleaseCandidate>;
}
