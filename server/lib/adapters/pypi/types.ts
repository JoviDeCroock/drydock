import type { DiffEntry, FileRecord, Finding, RiskLevel } from "../../review";

export const PYPI_RELEASE_MANIFEST_SCHEMA = "drydock.release-artifacts.v1";
export const PYPI_RULES_VERSION = "0.2.0";

export const PYPI_RULE_IDS = {
  metadataMissing: "pypi.metadata-missing",
  metadataMismatch: "pypi.metadata-mismatch",
  wheelRecordMissing: "pypi.wheel-record-missing",
  recordMismatch: "pypi.record-mismatch",
  pthExecution: "pypi.pth-execution",
  startupHook: "pypi.startup-hook",
  setupInstallCommand: "pypi.setup-install-command",
  unusualDependency: "pypi.unusual-dependency",
  nativeArtifact: "pypi.native-artifact",
} as const;

export const PYPI_PROJECT_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
export const SAFE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._!+-]{0,127}$/;
export const SHA256_RE = /^[a-f0-9]{64}$/i;
export const PYPI_ARTIFACT_LIMIT = 20;

export type PyPiArtifactKind = "wheel" | "sdist";

export interface PyPiReleaseManifestArtifact {
  path: string;
  sha256: string;
  url?: string;
  kind: PyPiArtifactKind;
}

export interface PyPiReleaseManifest {
  schema: typeof PYPI_RELEASE_MANIFEST_SCHEMA;
  ecosystem: "pypi";
  package: string;
  version: string;
  artifacts: PyPiReleaseManifestArtifact[];
}

export interface PyPiArtifactInput {
  path: string;
  files: FileRecord[];
}

export interface PyPiArtifactSummary {
  path: string;
  kind: PyPiArtifactKind;
  metadataPath: string | null;
  name: string | null;
  version: string | null;
  requiresDist: string[];
  wheel: {
    recordPath: string | null;
    tags: string[];
    rootIsPurelib: boolean | null;
  } | null;
}

export interface PyPiPreparedArtifact extends PyPiArtifactInput {
  kind: PyPiArtifactKind;
  summary: PyPiArtifactSummary;
}

export interface PyPiReleaseCandidateReview {
  ecosystem: "pypi";
  manifest: PyPiReleaseManifest;
  package: {
    name: string | null;
    version: string | null;
  };
  artifactCount: number;
  fileCount: number;
  previousFileCount: number;
  artifacts: PyPiArtifactSummary[];
  diff: DiffEntry[];
  ruleFindings: Finding[];
  risk: RiskLevel;
}

export interface PyPiAdapterInput {
  manifest: PyPiReleaseManifest;
  artifacts: PyPiArtifactInput[];
  previousArtifacts?: PyPiArtifactInput[];
  metadata?: PyPiProjectMetadata;
}

export interface PyPiAdapterDetails {
  manifest: PyPiReleaseManifest;
  artifacts: PyPiArtifactSummary[];
  preparedArtifacts: PyPiPreparedArtifact[];
}

export interface PyPiProjectMetadata {
  info?: { name?: string; version?: string };
  releases?: Record<string, PyPiReleaseFile[]>;
  urls?: PyPiReleaseFile[];
}

export interface PyPiReleaseFile {
  filename?: string;
  packagetype?: string;
  url?: string;
  size?: number;
  upload_time_iso_8601?: string;
  digests?: { sha256?: string };
  yanked?: boolean;
}

export type PyPiBaselineSelectionSource = "latest-published" | "upload-time" | "none";

export interface PyPiBaselineSelection {
  version: string | null;
  source: PyPiBaselineSelectionSource;
  reason: string;
}

export interface PyPiRemoteArtifact {
  filename: string;
  url: string;
  sha256: string | null;
  packagetype: string | null;
  kind: PyPiArtifactKind;
  size: number | null;
}
