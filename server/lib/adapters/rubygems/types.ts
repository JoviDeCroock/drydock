import type { DiffEntry, FileRecord, Finding, RiskLevel } from "../../review";
import type { TarSuspiciousEntry } from "../../tar-parser.js";
import type { GemspecDependency } from "./gemspec";

// Shared cross-ecosystem release-manifest schema (npm/PyPI use the same string);
// the `ecosystem` discriminator is what distinguishes a rubygems manifest.
export const RUBYGEMS_RELEASE_MANIFEST_SCHEMA = "drydock.release-artifacts.v1";
export const RUBYGEMS_RULES_VERSION = "0.1.0";

export const RUBYGEMS_RULE_IDS = {
  metadataMissing: "rubygems.metadata-missing",
  metadataMismatch: "rubygems.metadata-mismatch",
  nativeExtension: "rubygems.native-extension",
  extensionBuildHook: "rubygems.extension-build-hook",
  unexpectedPushHost: "rubygems.unexpected-push-host",
} as const;

// Gem names: a letter/digit start, then letters/digits/`._-`. RubyGems also caps
// the length; 100 mirrors our repo full-name caps and is well above any real gem.
export const GEM_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
// Gem::Version always starts with a digit; the rest is digits, dots, and
// pre-release segments (e.g. `1.2.0.pre.1`).
export const GEM_VERSION_RE = /^[0-9][0-9A-Za-z._-]{0,127}$/;
export const SHA256_RE = /^[a-f0-9]{64}$/i;
export const RUBYGEMS_ARTIFACT_LIMIT = 20;

// A reviewable `.gem` after the shared sandbox parse: the installed files plus
// the raw Gem::Specification YAML from the gem's `metadata.gz` member.
export interface RubyGemsArtifactInput {
  path: string;
  files: FileRecord[];
  gemMetadata: string | null;
  suspiciousEntries?: TarSuspiciousEntry[];
}

export interface RubyGemsReleaseManifestArtifact {
  path: string;
  sha256: string;
  url?: string;
}

export interface RubyGemsReleaseManifest {
  schema: typeof RUBYGEMS_RELEASE_MANIFEST_SCHEMA;
  ecosystem: "rubygems";
  package: string;
  version: string;
  artifacts: RubyGemsReleaseManifestArtifact[];
}

// Persisted-safe summary of one `.gem`'s gemspec (the volatile `files`/`date`/
// `rubygems_version` fields are deliberately dropped).
export interface GemArtifactSummary {
  path: string;
  platform: string;
  name: string | null;
  version: string | null;
  bindir: string | null;
  executables: string[];
  extensions: string[];
  requirePaths: string[];
  licenses: string[];
  requirements: string[];
  requiredRubyVersion: string | null;
  dependencies: GemspecDependency[];
  metadata: Record<string, string>;
  hasGemspec: boolean;
}

export interface RubyGemsPreparedArtifact extends RubyGemsArtifactInput {
  platform: string;
  summary: GemArtifactSummary;
}

export interface RubyGemsReleaseCandidateReview {
  ecosystem: "rubygems";
  manifest: RubyGemsReleaseManifest;
  package: {
    name: string | null;
    version: string | null;
  };
  artifactCount: number;
  fileCount: number;
  previousFileCount: number;
  artifacts: GemArtifactSummary[];
  diff: DiffEntry[];
  ruleFindings: Finding[];
  risk: RiskLevel;
}

export interface RubyGemsAdapterInput {
  manifest: RubyGemsReleaseManifest;
  artifacts: RubyGemsArtifactInput[];
  previousArtifacts?: RubyGemsArtifactInput[];
  versions?: RubyGemsVersion[];
}

export interface RubyGemsAdapterDetails {
  manifest: RubyGemsReleaseManifest;
  artifacts: GemArtifactSummary[];
  preparedArtifacts: RubyGemsPreparedArtifact[];
}

// A single entry from rubygems.org `GET /api/v1/versions/<gem>.json`.
export interface RubyGemsVersion {
  number?: string;
  platform?: string;
  prerelease?: boolean;
  created_at?: string;
  built_at?: string;
  sha?: string;
}

// Mirrors the shared BaselineSelectionSource values so the selection can flow
// straight into BaselineInfo.source.
export type RubyGemsBaselineSelectionSource = "latest-published" | "upload-time" | "none";

export interface RubyGemsBaselineSelection {
  version: string | null;
  source: RubyGemsBaselineSelectionSource;
  reason: string;
}

export interface RubyGemsRemoteArtifact {
  filename: string;
  url: string;
  platform: string;
  version: string;
}
