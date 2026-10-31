import type { AnyPackageAdapter } from "../ecosystems/package-adapter";
import type { FileRecord, PackageJsonSummary } from "../review";
import type { TarSuspiciousEntry } from "../tar-parser.js";

export type WorkflowArtifactKind = string;

export interface ParsedGateArtifact {
  path: string;
  sha256: string;
  sha1: string;
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

export interface WorkflowGateAdapter {
  readonly ecosystem: string;
  readonly artifactName: string;

  readonly shardedArtifactNames?: boolean;
  readonly packageAdapter: AnyPackageAdapter;

  classifyArtifact(path: string): WorkflowArtifactKind | null;

  /**
   * Claim an extension-ambiguous archive (`.tgz` is both npm and sdist) by
   * content. Ecosystems whose artifacts have an unambiguous extension omit it.
   */
  detectArtifact?(contents: ArchiveContents): WorkflowArtifactKind | null;

  // Artifacts contain parsed evidence only; no installation token reaches adapters.
  prepareReleaseCandidates(artifacts: ParsedGateArtifact[]): PreparedReleaseCandidate[];

  narrowParsedArtifact?(
    artifact: ParsedGateArtifact,
    retainedSamples: Map<string, string>,
  ): ParsedGateArtifact;

  /**
   * Basenames of small non-distribution files this adapter reads from the
   * bundle (PyPI: `pypi-stage.json`). Collected bounded and handed to
   * `prepareStagedReleaseCandidates`; never parsed as release artifacts.
   */
  readonly sidecarFileNames?: readonly string[];

  /**
   * Review registry-held staged bytes named by a sidecar instead of (or bound
   * to) the bundle's own distributions. Runs only when this adapter's sidecars
   * are present; otherwise the gate calls `prepareReleaseCandidates` as before.
   * Failures throw `WorkflowArtifactError`, which rejects the deployment.
   */
  prepareStagedReleaseCandidates?(input: StagedReleaseInput): Promise<PreparedReleaseCandidate[]>;
}

export interface GateSidecarFile {
  path: string;
  bytes: Uint8Array;
}

export interface StagedReleaseInput {
  env: Cloudflare.Env;
  sidecars: GateSidecarFile[];
  /** This ecosystem's slice of the bundle's parsed distributions (may be empty). */
  artifacts: ParsedGateArtifact[];
  /** Parse fetched bytes through the same credentials-free sandbox router. */
  parse(file: GateStagedFile): Promise<ParsedGateArtifact>;
}

export interface GateStagedFile {
  path: string;
  bytes: Uint8Array;
  sha256: string;
  sha1: string;
  ecosystem: string;
  kind: WorkflowArtifactKind;
}
