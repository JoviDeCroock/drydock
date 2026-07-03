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
}

// Files plus an ecosystem-normalized "manifest summary" pulled from a fetched
// artifact. PackageJsonSummary is reused as the manifest carrier today because
// it is the only ecosystem; future adapters can widen this if needed.
export interface AcquiredArtifact {
  files: FileRecord[];
  manifest: PackageJsonSummary | null;
  suspiciousTarEntries?: TarSuspiciousEntry[];
}

// Adapter-shaped staged metadata gathered alongside the staged artifact.
// Opaque to the pipeline — the adapter is the only thing that interprets it.
export type StagedDetails = unknown;

export type ReleaseProvenanceArtifactKind = "tarball" | "wheel" | "sdist" | "gem";

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
  ecosystem: "npm" | "pypi" | "rubygems";
  mode: "workflow_gate";
  artifacts: ReleaseProvenanceArtifact[];
}

export type BaselineSelectionSource =
  | "dist-tag"
  | "semver-predecessor"
  | "highest-published"
  | "latest-published"
  | "upload-time"
  | "none";

export interface BaselineInfo {
  version: string | null;
  tag: string | null;
  source: BaselineSelectionSource;
  distTagVersion: string | null;
  reason: string;
}

export interface AdapterRunFindingsArgs {
  staged: AcquiredArtifact;
  baseline: AcquiredArtifact | null;
  details: StagedDetails;
  fileDiff: DiffEntry[];
  manifestDiff: PackageJsonDiff;
  stagedManifestText: string | null;
}

export interface AdapterDescribeArgs<TInput> {
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
}
