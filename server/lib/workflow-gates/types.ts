import type { AdapterBroker, PackageAdapter } from "../adapters/types";
import type { FileRecord, PackageJsonSummary } from "../review";
import type { TarSuspiciousEntry } from "../tar-parser.js";

/**
 * Ecosystem-defined classification of a bundle entry. PyPI uses
 * `"wheel" | "sdist"`; npm uses `"tarball"`; other ecosystems pick their own
 * opaque kinds. The shared fetch layer only cares whether `classifyArtifact`
 * returns a kind (the entry is reviewable) or `null` (ignored).
 */
export type WorkflowArtifactKind = string;

/**
 * A reviewable bundle entry after the shared router has parsed its bytes in the
 * credentials-free sandbox and resolved its ecosystem.
 *
 * Parsing is shared (every ecosystem's archive is read by the same tar/zip
 * sandbox), so the adapter receives the already-parsed `files`/`packageJson`
 * instead of raw bytes. The `sha256` is the digest the control plane recomputed
 * from the downloaded artifact bytes — it is the reviewed tarball's digest,
 * bound to the immutable GitHub Actions artifact.
 */
export interface ParsedGateArtifact {
  path: string;
  sha256: string;
  ecosystem: string;
  kind: WorkflowArtifactKind;
  files: FileRecord[];
  /** npm tarballs surface their `package.json`; PyPI/rubygems artifacts are `null`. */
  packageJson: PackageJsonSummary | null;
  /** `.gem` artifacts surface the raw Gem::Specification YAML; others are absent. */
  gemMetadata?: string | null;
  suspiciousEntries?: TarSuspiciousEntry[];
}

/** The parsed contents an adapter inspects to content-detect an ambiguous archive. */
export interface ArchiveContents {
  files: FileRecord[];
  packageJson: PackageJsonSummary | null;
}

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
 *    artifacts, by path (used to keep/drop entries and to pick the adapter for a
 *    pinned target).
 *  - `detectArtifact` — content-based ecosystem detection for an archive whose
 *    extension is ambiguous across ecosystems (an npm `.tgz` is byte- and
 *    name-indistinguishable from a PyPI sdist `.tar.gz`). Auto-detect targets
 *    use this on the parsed contents instead of the path.
 *  - `prepareReleaseCandidates` — split the ecosystem's already-parsed artifacts
 *    into one candidate per distinct package (grouping by package identity),
 *    rejecting a group whose artifacts disagree on the identity they carry.
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
   * Decide whether a bundle entry is a reviewable artifact by path. Returning a
   * kind keeps the entry (the kind is opaque to the shared fetcher); returning
   * `null` ignores it (checksums, READMEs, …) so it never reaches the review.
   *
   * A path can be claimed by more than one ecosystem (npm and PyPI both produce
   * `.tgz`); the auto-detect classifier resolves that ambiguity by content via
   * `detectArtifact` once the bytes are parsed.
   */
  classifyArtifact(path: string): WorkflowArtifactKind | null;

  /**
   * Content-based detection for an archive whose extension alone cannot decide
   * the ecosystem. Returning a kind claims the parsed archive for this
   * ecosystem; returning `null` defers to another adapter. npm claims an archive
   * that contains a root `package.json`; PyPI claims an sdist that contains a
   * `PKG-INFO`.
   */
  detectArtifact(contents: ArchiveContents): WorkflowArtifactKind | null;

  /**
   * Split this ecosystem's already-parsed artifacts into one prepared candidate
   * per distinct package. `artifacts` has already been narrowed to this
   * ecosystem and parsed in the credentials-free sandbox by the shared router,
   * so the adapter only groups them by package identity and synthesizes each
   * group's pipeline input.
   *
   * Trust boundary: the installation token is already gone — each artifact holds
   * only parsed file records plus the SHA-256 the control plane recomputed from
   * the downloaded bytes. The adapter must throw `WorkflowArtifactError` when a
   * group cannot be trusted (missing or inconsistent artifact identity) so the
   * shared runner fail-closes the deployment.
   */
  prepareReleaseCandidates(artifacts: ParsedGateArtifact[]): PreparedReleaseCandidate[];
}
