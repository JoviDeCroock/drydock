import { type AppDb, type WorkspaceSession } from "../../db/client";
import type {
  CodePatternSet,
  DiffEntry,
  FileRecord,
  Finding,
  PackageJsonDiff,
  PackageJsonSummary,
} from "../review";
import type { SafeScanError, ScanErrorCode } from "../scan/errors";
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

  /** Validate registry coordinates before a staged admission can reserve a package. */
  stagedClaimIdentity?(input: {
    registryUrl?: string | null;
    packageName?: string | null;
    version?: string | null;
  }): { registryUrl: string; packageName: string; version: string } | null;

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

  /**
   * Ask the registry what became of a staged release whose bytes could not be
   * acquired, so the failure is not blamed on the credential when the release
   * itself moved on. Advisory: `null` leaves the classification untouched.
   */
  refineAcquisitionFailure?(
    ctx: AcquisitionFailureContext,
    failure: SafeScanError,
  ): Promise<RefinedAcquisitionFailure | null>;
}

interface AcquisitionFailureContext {
  env: Cloudflare.Env;
  db: AppDb;
  scanId: string;
  organizationId: string;
}

interface RefinedAcquisitionFailure {
  /** Replacement failure, or `null` when the registry status explains nothing. */
  failure: { code: ScanErrorCode; message: string } | null;
  /** The registry lifecycle status observed while refining. */
  registryStatus: string | null;
  /** True when that status can no longer change and is safe to persist on the failed scan. */
  registryStatusTerminal: boolean;
}

/**
 * A `PackageAdapter` with its input and broker types erased. Registries and
 * orchestrators hold adapters of every ecosystem side by side, so they cannot
 * name one ecosystem's `TInput`/`TBroker`; `parseInput` re-establishes the
 * concrete input at the boundary.
 */
export type AnyPackageAdapter = PackageAdapter<unknown, AdapterBroker>;

/**
 * The one place the erasure cast lives. `PackageAdapter` is contravariant in
 * `TInput` through `describe`/`acquireStaged`, so a concrete adapter does not
 * assign to the erased shape without help.
 */
export function erasePackageAdapter<TInput, TBroker extends AdapterBroker>(
  adapter: PackageAdapter<TInput, TBroker>,
): AnyPackageAdapter {
  return adapter as unknown as AnyPackageAdapter;
}
