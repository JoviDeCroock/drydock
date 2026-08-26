import type { AppDb } from "../../db/client";
import type {
  AdapterBroker,
  PackageAdapter,
  ReleaseProvenanceArtifact,
} from "../ecosystems/package-adapter";
import type { FileRecord, PackageJsonSummary } from "../review";
import type { TarSuspiciousEntry } from "../tar-parser.js";

export type WorkflowArtifactKind = string;

export interface ParsedGateArtifact {
  path: string;
  sha256: string;
  ecosystem: string;
  kind: WorkflowArtifactKind;
  files: FileRecord[];
  packageJson: PackageJsonSummary | null;
  suspiciousEntries?: TarSuspiciousEntry[];
}

export interface ArchiveContents {
  files: FileRecord[];
  packageJson: PackageJsonSummary | null;
}

export interface PreparedReleaseCandidate {
  ecosystem: string;
  pipelineInput: Record<string, unknown>;
  package: { name: string; version: string };
}

export interface RegistryVerificationContext {
  env: Cloudflare.Env;
  executionCtx: ExecutionContext;
  db: AppDb;
  organizationId: string;
}

export interface RegistryVerificationInput {
  packageName: string;
  version: string;
  artifacts: ReleaseProvenanceArtifact[];
}

export type RegistryVerificationResult =
  | { status: "not_published" }
  | { status: "verified" }
  | {
      status: "mismatch";
      reviewedDigests: string[];
      publishedDigests: string[];
    };
export interface WorkflowGateAdapter {
  readonly ecosystem: string;
  readonly artifactName: string;

  readonly shardedArtifactNames?: boolean;
  readonly packageAdapter: PackageAdapter<unknown, AdapterBroker>;

  classifyArtifact(path: string): WorkflowArtifactKind | null;

  detectArtifact(contents: ArchiveContents): WorkflowArtifactKind | null;

  // Artifacts contain parsed evidence only; no installation token reaches adapters.
  prepareReleaseCandidates(artifacts: ParsedGateArtifact[]): PreparedReleaseCandidate[];

  /**
   * Compare a gate-reviewed release with the registry after the publish job is
   * released. Absence is temporary: the queue job and cron backstop retry it.
   * A mismatch is alarmed only after the shared publication grace period.
   */
  verifyPublishedRelease?(
    ctx: RegistryVerificationContext,
    input: RegistryVerificationInput,
  ): Promise<RegistryVerificationResult>;

  narrowParsedArtifact?(
    artifact: ParsedGateArtifact,
    retainedSamples: Map<string, string>,
  ): ParsedGateArtifact;
}
