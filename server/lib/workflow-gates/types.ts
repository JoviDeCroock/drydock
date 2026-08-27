import type { AdapterBroker, PackageAdapter } from "../ecosystems/package-adapter";
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

export interface GateSetupTemplateInput {
  /** GitHub Environment the publish job runs in — already validated/normalized. */
  environmentName: string;
  /** Package/project/extension identity, used in the workflow name and comments. */
  packageName: string;
}

export interface GateSetupTemplate {
  /** Repository-relative path, always under `.github/workflows/`. */
  workflowPath: string;
  yaml: string;
  /** Ecosystem-specific hardening steps; surfaced in the UI and the setup PR body. */
  notes: string[];
}

export interface WorkflowGateAdapter {
  readonly ecosystem: string;
  readonly artifactName: string;

  readonly shardedArtifactNames?: boolean;
  readonly packageAdapter: PackageAdapter<unknown, AdapterBroker>;

  classifyArtifact(path: string): WorkflowArtifactKind | null;

  detectArtifact(contents: ArchiveContents): WorkflowArtifactKind | null;

  // Artifacts contain parsed evidence only; no installation token reaches adapters.
  prepareReleaseCandidates(artifacts: ParsedGateArtifact[]): PreparedReleaseCandidate[];

  narrowParsedArtifact?(
    artifact: ParsedGateArtifact,
    retainedSamples: Map<string, string>,
  ): ParsedGateArtifact;

  /**
   * The publish workflow the setup wizard generates and offers as a pull
   * request. Optional: an ecosystem without a canonical CI shape simply has no
   * template, and the wizard degrades to the documented manual steps.
   *
   * Inputs are pre-validated against a conservative identifier allowlist
   * (`assertGateSetupIdentity`), so implementations may interpolate them
   * directly into the emitted YAML.
   */
  gateSetupTemplate?(input: GateSetupTemplateInput): GateSetupTemplate;
}
