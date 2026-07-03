import type { DiffEntry, FileRecord, Finding, RiskLevel } from "../../review";
import type { TarSuspiciousEntry } from "../../tar-parser.js";

export const COMPOSER_RELEASE_MANIFEST_SCHEMA = "drydock.release-artifacts.v1";
export const COMPOSER_RULES_VERSION = "0.1.0";

export const COMPOSER_RULE_IDS = {
  manifestMissing: "composer.manifest-missing",
  manifestMismatch: "composer.manifest-mismatch",
  composerPlugin: "composer.plugin",
  pluginApiRequirement: "composer.plugin-api-requirement",
  allowPlugins: "composer.allow-plugins",
  autoloadFiles: "composer.autoload-files",
  binEntry: "composer.bin-entry",
  customRepository: "composer.custom-repository",
  packageShadowing: "composer.package-shadowing",
  unstableStability: "composer.unstable-stability",
  sourceInstall: "composer.source-install",
} as const;

// Composer package names are `vendor/package`, lowercase, per the composer.json
// schema (https://getcomposer.org/schema.json `name` pattern).
export const COMPOSER_PACKAGE_NAME_RE =
  /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]|-{1,2})?[a-z0-9]+)*$/;
export const SAFE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._!+-]{0,127}$/;
export const SHA256_RE = /^[a-f0-9]{64}$/i;

// `composer archive` produces exactly one archive per package; a release
// candidate manifest therefore carries a single artifact, which also keeps the
// staged-vs-baseline file diff stable (no per-artifact namespacing needed).
export const COMPOSER_ARTIFACT_LIMIT = 1;

// A workflow may legitimately archive a package whose composer.json omits
// `version` (Packagist derives it from the VCS tag). Identity fails closed on
// the required `name`; the version falls back to this placeholder so the
// review can still proceed with a latest-published baseline.
export const COMPOSER_UNVERSIONED = "0.0.0-unversioned";

export type ComposerArtifactKind = "zip" | "tar";

export interface ComposerReleaseManifestArtifact {
  path: string;
  sha256: string;
  kind: ComposerArtifactKind;
}

export interface ComposerReleaseManifest {
  schema: typeof COMPOSER_RELEASE_MANIFEST_SCHEMA;
  ecosystem: "composer";
  package: string;
  version: string;
  artifacts: ComposerReleaseManifestArtifact[];
}

export interface ComposerArtifactInput {
  path: string;
  files: FileRecord[];
  suspiciousEntries?: TarSuspiciousEntry[];
}

export interface ComposerRepositoryEntry {
  type: string | null;
  url: string | null;
}

// Security-relevant projection of a root composer.json. Parsed from the file's
// textSample; a missing or unparseable composer.json yields null identity and
// fails closed at the gate.
export interface ComposerJsonSummary {
  path: string | null;
  name: string | null;
  version: string | null;
  type: string | null;
  requireComposerPluginApi: string | null;
  pluginClass: string | null;
  // true = allow all plugins; string keys are per-plugin allow entries.
  allowPluginsAll: boolean;
  allowPlugins: string[];
  autoloadFiles: string[];
  bin: string[];
  repositories: ComposerRepositoryEntry[];
  replace: string[];
  provide: string[];
  minimumStability: string | null;
  preferStable: boolean | null;
  preferredInstallSource: boolean;
  secureHttpDisabled: boolean;
}

export interface ComposerPreparedArtifact extends ComposerArtifactInput {
  kind: ComposerArtifactKind;
  summary: ComposerJsonSummary;
}

export interface ComposerReleaseCandidateReview {
  ecosystem: "composer";
  manifest: ComposerReleaseManifest;
  package: {
    name: string | null;
    version: string | null;
  };
  artifactCount: number;
  fileCount: number;
  previousFileCount: number;
  artifacts: ComposerJsonSummary[];
  diff: DiffEntry[];
  ruleFindings: Finding[];
  risk: RiskLevel;
}

export interface ComposerAdapterInput {
  manifest: ComposerReleaseManifest;
  artifacts: ComposerArtifactInput[];
  previousArtifacts?: ComposerArtifactInput[];
  metadata?: ComposerPackageMetadata;
}

export interface ComposerAdapterDetails {
  manifest: ComposerReleaseManifest;
  artifacts: ComposerJsonSummary[];
  preparedArtifacts: ComposerPreparedArtifact[];
}

// Packagist Composer v2 metadata (`https://repo.packagist.org/p2/<name>.json`).
export interface ComposerPackageMetadata {
  packages?: Record<string, ComposerPackageRelease[]>;
}

export interface ComposerPackageRelease {
  version?: string;
  version_normalized?: string;
  time?: string;
  dist?: {
    type?: string;
    url?: string;
    shasum?: string;
  };
}

export type ComposerBaselineSelectionSource = "latest-published" | "upload-time" | "none";

export interface ComposerBaselineSelection {
  version: string | null;
  source: ComposerBaselineSelectionSource;
  reason: string;
}

export interface ComposerRemoteArtifact {
  version: string;
  url: string;
  kind: ComposerArtifactKind;
  sha1: string | null;
}
