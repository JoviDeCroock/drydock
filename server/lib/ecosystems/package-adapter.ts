import { type AppDb, type WorkspaceSession } from "../../db/client";
import type {
  CodePatternSet,
  DiffEntry,
  FileRecord,
  Finding,
  PackageJsonDiff,
  PackageJsonSummary,
} from "../review";
import type { TarSuspiciousEntry } from "../tar-parser.js";
import type { EcosystemId } from "./labels";

export interface AdapterContext {
  env: Cloudflare.Env;
  executionCtx: ExecutionContext;
  db: AppDb;
  session: WorkspaceSession;
}

// Reference to a stored credential row owned by the host. The adapter resolves
// the underlying secret through its broker so the plaintext token never reaches
// the orchestrator scope.
export interface AdapterConnectionRef {
  organizationId: string;
  /**
   * Registry captured when a staged scan was created. Credential brokers must
   * fail closed if the organization's live connection no longer matches it,
   * rather than retargeting an already-queued release to another registry.
   */
  registryUrl?: string | null;
}

// Files plus an ecosystem-normalized "manifest summary" pulled from a fetched
// artifact. `PackageJsonSummary` is the shared manifest carrier across every
// ecosystem, not an npm-only shape: the PyPI adapter projects core metadata
// plus `Requires-Dist` into it, and the VS Code adapter projects the VSIX
// extension manifest, so diffing, manifest-change summaries, and the report
// renderer stay ecosystem-agnostic. New adapters normalize into this shape
// rather than widening it.
export interface AcquiredArtifact {
  files: FileRecord[];
  manifest: PackageJsonSummary | null;
  suspiciousTarEntries?: TarSuspiciousEntry[];
}

// Adapter-shaped staged metadata gathered alongside the staged artifact.
// Opaque to the pipeline — the adapter is the only thing that interprets it.
export type StagedDetails = unknown;

type ReleaseProvenanceArtifactKind = "tarball" | "wheel" | "sdist" | "vsix";

// One reviewed release artifact bound to the SHA-256 the control plane
// recomputed from its immutable bytes.
export interface ReleaseProvenanceArtifact {
  path: string;
  kind: ReleaseProvenanceArtifactKind;
  sha256: string;
}

// Byte-continuity record for a workflow-gate review: the exact artifacts Drydock
// reviewed and the digests it recomputed from the immutable GitHub Actions
// bytes. The publish job re-derives the same digests from the same artifact
// before upload, so the bytes reviewed are the bytes published. Rendered
// uniformly across ecosystems in the report "Provenance" section and surfaced in
// the report export so a maintainer's CI can verify against it.
export interface ReleaseProvenance {
  ecosystem: EcosystemId;
  mode: "workflow_gate";
  artifacts: ReleaseProvenanceArtifact[];
}

type BaselineSelectionSource =
  | "dist-tag"
  | "semver-predecessor"
  | "highest-published"
  | "latest-published"
  | "upload-time"
  | "none";

/**
 * Why a published baseline exists but was deliberately not downloaded. The diff
 * then reports every staged file as added, which is a *gap in the comparison*,
 * not a release delta: findings stay package context and the report says so
 * instead of recommending a block the evidence does not support.
 */
export type BaselineComparisonSkip = "baseline-too-large";

export interface BaselineInfo {
  version: string | null;
  tag: string | null;
  source: BaselineSelectionSource;
  distTagVersion: string | null;
  reason: string;
  comparisonSkipped?: BaselineComparisonSkip;
}

interface AdapterRunFindingsArgs {
  staged: AcquiredArtifact;
  baseline: AcquiredArtifact | null;
  details: StagedDetails;
  fileDiff: DiffEntry[];
  manifestDiff: PackageJsonDiff;
  stagedManifestText: string | null;
}

interface AdapterDescribeArgs<TInput> {
  input: TInput;
  staged: AcquiredArtifact;
  details: StagedDetails;
  baseline: BaselineInfo;
  previous: AcquiredArtifact | null;
}

export interface AdapterPackageSummary {
  name: string | null;
  stagedVersion: string | null;
  stagedTag: string | null;
  previousVersion: string | null;
}

// Broker is the only code path that holds a decrypted credential. The pipeline
// receives a broker handle from the adapter and passes it back into the
// adapter's acquire methods; it never touches the underlying secret.
export interface AdapterBroker {
  dispose(): void | Promise<void>;
}

export interface PackageAdapter<TInput = unknown, TBroker extends AdapterBroker = AdapterBroker> {
  /** Stable id used in persistence + logs. */
  readonly id: string;

  /** Code-pattern family used when classifying changed-line findings. */
  readonly codePatternSet?: CodePatternSet;

  /** Validate the route/queue payload into the adapter's typed input shape. */
  parseInput(raw: unknown): TInput;

  /**
   * Build the credential broker for this scan. The broker resolves and holds
   * the decrypted credential internally — callers must not request the secret
   * directly.
   */
  createBroker(ctx: AdapterContext, ref: AdapterConnectionRef): TBroker;

  /** Fetch the staged artifact + any ecosystem-specific staged metadata. */
  acquireStaged(
    ctx: AdapterContext,
    input: TInput,
    broker: TBroker,
  ): Promise<{ artifact: AcquiredArtifact; details: StagedDetails }>;

  /** Resolve + fetch the baseline artifact for diff (null if none exists). */
  acquireBaseline(
    ctx: AdapterContext,
    input: TInput,
    broker: TBroker,
    staged: { artifact: AcquiredArtifact; details: StagedDetails },
  ): Promise<{ artifact: AcquiredArtifact | null; baseline: BaselineInfo }>;

  /** Ecosystem-specific deterministic findings (script/dep/metadata rules). */
  runFindings(args: AdapterRunFindingsArgs): Finding[];

  /** Project the adapter's typed result into ScanResult.package. */
  describe(args: AdapterDescribeArgs<TInput>): AdapterPackageSummary;

  /** Opaque snapshot of staged details that's safe to persist in the report. */
  summarizeDetails(details: StagedDetails): Record<string, unknown> | null;

  /** Registry-control-plane identity recovered while acquiring the release. */
  registryReleaseIdentity?(details: StagedDetails): { packageName: string; version: string } | null;
}
