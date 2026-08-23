import type { AdapterBroker, PackageAdapter } from "../ecosystems/package-adapter";
import type { FileRecord, PackageJsonSummary } from "../review";
import type { TarSuspiciousEntry } from "../tar-parser.js";

export type WorkflowArtifactKind = string;
type WorkflowSandboxFormat = "tgz" | "zip" | "zip-buffered" | "vsix";

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
  /**
   * Optional stable suffix for the internal scan stage id when two candidates
   * may share the same display package name. The adapter must derive it from
   * reviewed artifact identity, never from an untrusted outer filename alone.
   */
  scanKey?: string;
  pipelineInput: Record<string, unknown>;
  package: { name: string; version: string };
}

export interface WorkflowGateAdapter {
  readonly ecosystem: string;
  readonly artifactName: string;

  readonly shardedArtifactNames?: boolean;
  readonly packageAdapter: PackageAdapter<unknown, AdapterBroker>;

  classifyArtifact(path: string): WorkflowArtifactKind | null;

  classifyArtifactForAutoDetection?(path: string): WorkflowArtifactKind | null;

  detectArtifact(contents: ArchiveContents): WorkflowArtifactKind | null;

  readonly sandboxFormat?: (kind: WorkflowArtifactKind) => WorkflowSandboxFormat;

  // Artifacts contain parsed evidence only; no installation token reaches adapters.
  prepareReleaseCandidates(artifacts: ParsedGateArtifact[]): PreparedReleaseCandidate[];

  narrowParsedArtifact?(
    artifact: ParsedGateArtifact,
    retainedSamples: Map<string, string>,
  ): ParsedGateArtifact;
}
