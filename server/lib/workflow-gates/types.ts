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
 * Result of turning one package's slice of a verified artifact bundle into the
 * input the scan pipeline runs against, plus the derived package identity.
 *
 * One bundle can yield several candidates: a monorepo publishes multiple
 * packages (and potentially several ecosystems) from one release, and each
 * package becomes its own candidate → its own scan against its own baseline.
 *
 * `pipelineInput` is spread into `runScanPipeline` options, so its keys must
 * match what `packageAdapter.parseInput` expects (for PyPI: `manifest` +
 * `artifacts`). The shared runner never interprets it.
 */
export interface PreparedReleaseCandidate {
  /** Ecosystem this package belongs to; matches a registered adapter id. */
  ecosystem: string;
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
 *  - `classifyArtifact` — which bundle entries are this ecosystem's reviewable
 *    artifacts.
 *  - `prepareReleaseCandidates` — split the ecosystem's slice of the verified
 *    bundle into one candidate per distinct package (grouping the bundle's
 *    artifacts by package identity), rejecting a group whose artifacts disagree
 *    on the identity they carry.
 *  - `packageAdapter` — the deterministic review/baseline/findings adapter the
 *    shared pipeline runs (see `server/lib/adapters/types.ts`); risk-to-decision
 *    mapping stays shared in `recommendationForReleaseRisk`.
 */
export interface WorkflowGateAdapter {
  /** Stable ecosystem id; matches `github_release_targets.ecosystem`. */
  readonly ecosystem: string;

  /** Suggested artifact name for workflows that choose to narrow discovery. */
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
   * Split this ecosystem's slice of the verified bundle into one prepared
   * candidate per distinct package. `bundle.artifacts` has already been narrowed
   * to entries this adapter's `classifyArtifact` kept, so the adapter only needs
   * to group them by package identity and synthesize each group's pipeline input.
   *
   * Trust boundary: the installation token is already gone — `bundle` holds only
   * artifact bytes whose SHA-256 was recomputed in the control plane. The
   * adapter parses those bytes through the credentials-free sandbox. It must
   * throw `WorkflowArtifactError` when a group cannot be trusted (missing or
   * inconsistent artifact identity) so the shared runner fail-closes the
   * deployment.
   */
  prepareReleaseCandidates(
    env: Cloudflare.Env,
    ctx: ExecutionContext,
    args: { bundle: ResolvedReleaseBundle },
  ): Promise<PreparedReleaseCandidate[]>;
}
