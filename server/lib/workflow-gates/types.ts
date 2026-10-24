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
  /**
   * The beta detonation sandbox (`server/lib/detonation`) can run this
   * ecosystem's reviewed gate artifacts, so the gate runner requests an
   * advisory run once a review is attached. Setting it also needs a run plan
   * for the ecosystem in `server/lib/detonation/job.ts` (only PyPI has one);
   * otherwise each run is requested and then skipped.
   */
  readonly detonatesReviewedPackages?: boolean;
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
}
