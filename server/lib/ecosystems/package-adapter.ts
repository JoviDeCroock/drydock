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

export interface AdapterConnectionRef {
  organizationId: string;
  // Prevent connection edits from retargeting an already queued release.
  registryUrl?: string | null;
  /** Optional immutable credential generation selected by the caller. */
  connectionId?: string;
}

export interface AcquiredArtifact {
  files: FileRecord[];
  manifest: PackageJsonSummary | null;
  suspiciousTarEntries?: TarSuspiciousEntry[];
}

export type StagedDetails = unknown;

type ReleaseProvenanceArtifactKind = "tarball" | "wheel" | "sdist" | "vsix";

export interface ReleaseProvenanceArtifact {
  path: string;
  kind: ReleaseProvenanceArtifactKind;
  sha256: string;
}

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
  // Two already-public releases reviewed as a pair; the baseline is the
  // requested version, or the release immediately before the reviewed one.
  | "published-pair"
  | "none";

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

// Brokers keep decrypted credentials outside the orchestrator scope.
export interface AdapterBroker {
  dispose(): void | Promise<void>;
}

export interface PackageAdapter<TInput = unknown, TBroker extends AdapterBroker = AdapterBroker> {
  readonly id: string;
  readonly codePatternSet?: CodePatternSet;
  parseInput(raw: unknown): TInput;

  createBroker(ctx: AdapterContext, ref: AdapterConnectionRef): TBroker;

  acquireStaged(
    ctx: AdapterContext,
    input: TInput,
    broker: TBroker,
  ): Promise<{ artifact: AcquiredArtifact; details: StagedDetails }>;

  acquireBaseline(
    ctx: AdapterContext,
    input: TInput,
    broker: TBroker,
    staged: { artifact: AcquiredArtifact; details: StagedDetails },
  ): Promise<{ artifact: AcquiredArtifact | null; baseline: BaselineInfo }>;

  runFindings(args: AdapterRunFindingsArgs): Finding[];
  describe(args: AdapterDescribeArgs<TInput>): AdapterPackageSummary;
  summarizeDetails(details: StagedDetails): Record<string, unknown> | null;
  registryReleaseIdentity?(details: StagedDetails): { packageName: string; version: string } | null;
}
