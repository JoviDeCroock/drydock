import type { DiffEntry, FileRecord, Finding, RiskLevel } from "../../review";
import type { TarSuspiciousEntry } from "../../tar-parser.js";

export const RUBYGEMS_RELEASE_MANIFEST_SCHEMA = "drydock.release-artifacts.v1";
export const RUBYGEMS_RULES_VERSION = "0.1.0";

export const RUBYGEMS_RULE_IDS = {
  metadataMissing: "rubygems.metadata-missing",
  metadataMismatch: "rubygems.metadata-mismatch",
  extensionBuild: "rubygems.extension-build",
  extensionAdded: "rubygems.extension-added",
  extensionInstallCode: "rubygems.extension-install-code",
  suspiciousExtensionFile: "rubygems.suspicious-extension-file",
  nativeArtifact: "rubygems.native-artifact",
  executableAdded: "rubygems.executable-added",
  gitDependency: "rubygems.git-dependency",
} as const;

// RubyGems gem names: letters, digits, `.`, `-`, `_`, must start and end with
// an alphanumeric character (mirrors Gem::Specification::VALID_NAME_PATTERN's
// practical shape while rejecting leading/trailing separators).
export const RUBYGEMS_GEM_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
export const SAFE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const SHA256_RE = /^[a-f0-9]{64}$/i;
export const RUBYGEMS_ARTIFACT_LIMIT = 20;

export type RubygemsArtifactKind = "gem";

export interface RubygemsReleaseManifestArtifact {
  path: string;
  sha256: string;
  url?: string;
  kind: RubygemsArtifactKind;
}

export interface RubygemsReleaseManifest {
  schema: typeof RUBYGEMS_RELEASE_MANIFEST_SCHEMA;
  ecosystem: "rubygems";
  package: string;
  version: string;
  artifacts: RubygemsReleaseManifestArtifact[];
}

export interface RubygemsArtifactInput {
  path: string;
  files: FileRecord[];
  // Tar-parser findings (oversized content-skipped bodies, non-regular entries,
  // duplicates, confusable paths) for this artifact. Carried through so the gate
  // surfaces them as findings instead of dropping evidence the sandbox recorded.
  suspiciousEntries?: TarSuspiciousEntry[];
}

export interface RubygemsArtifactSummary {
  path: string;
  kind: RubygemsArtifactKind;
  metadataPath: string | null;
  name: string | null;
  version: string | null;
  platform: string | null;
  executables: string[];
  extensions: string[];
  dependencies: string[];
}

export interface RubygemsPreparedArtifact extends RubygemsArtifactInput {
  kind: RubygemsArtifactKind;
  summary: RubygemsArtifactSummary;
}

export interface RubygemsReleaseCandidateReview {
  ecosystem: "rubygems";
  manifest: RubygemsReleaseManifest;
  package: {
    name: string | null;
    version: string | null;
  };
  artifactCount: number;
  fileCount: number;
  previousFileCount: number;
  artifacts: RubygemsArtifactSummary[];
  diff: DiffEntry[];
  ruleFindings: Finding[];
  risk: RiskLevel;
}

export interface RubygemsAdapterInput {
  manifest: RubygemsReleaseManifest;
  artifacts: RubygemsArtifactInput[];
  previousArtifacts?: RubygemsArtifactInput[];
  metadata?: RubygemsVersionInfo[];
}

export interface RubygemsAdapterDetails {
  manifest: RubygemsReleaseManifest;
  artifacts: RubygemsArtifactSummary[];
  preparedArtifacts: RubygemsPreparedArtifact[];
}

// One entry of the RubyGems.org versions listing
// (`https://rubygems.org/api/v1/versions/{gem}.json`). Yanked versions are not
// present in that listing, so absence of a `yanked` field is expected.
export interface RubygemsVersionInfo {
  number?: string;
  platform?: string;
  created_at?: string;
  prerelease?: boolean;
  sha?: string;
}

export type RubygemsBaselineSelectionSource = "latest-published" | "upload-time" | "none";

export interface RubygemsBaselineSelection {
  version: string | null;
  source: RubygemsBaselineSelectionSource;
  reason: string;
}

export interface RubygemsRemoteArtifact {
  filename: string;
  url: string;
  sha256: string | null;
  platform: string;
  kind: RubygemsArtifactKind;
}
