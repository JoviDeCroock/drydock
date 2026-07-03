import type { DiffEntry, FileRecord, Finding, RiskLevel } from "../../review";
import type { TarSuspiciousEntry } from "../../tar-parser.js";

export const CRATES_RELEASE_MANIFEST_SCHEMA = "drydock.release-artifacts.v1";
export const CRATES_RULES_VERSION = "0.1.0";

export const CRATES_RULE_IDS = {
  metadataMissing: "crates.metadata-missing",
  metadataMismatch: "crates.metadata-mismatch",
  buildScriptAdded: "crates.build-script-added",
  buildScriptChanged: "crates.build-script-changed",
  procMacroIntroduced: "crates.proc-macro-introduced",
  linksChanged: "crates.links-changed",
  nonRegistryDependency: "crates.non-registry-dependency",
} as const;

// crates.io package names: ASCII alphanumeric, `-`, `_`; must start with a
// letter; max 64 characters.
export const CRATE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const SAFE_VERSION_RE = /^[0-9][A-Za-z0-9.+-]{0,127}$/;
export const SHA256_RE = /^[a-f0-9]{64}$/i;
export const CRATES_ARTIFACT_LIMIT = 20;

export type CratesArtifactKind = "crate";

export interface CratesReleaseManifestArtifact {
  path: string;
  sha256: string;
  kind: CratesArtifactKind;
}

export interface CratesReleaseManifest {
  schema: typeof CRATES_RELEASE_MANIFEST_SCHEMA;
  ecosystem: "crates";
  package: string;
  version: string;
  artifacts: CratesReleaseManifestArtifact[];
}

export interface CratesArtifactInput {
  path: string;
  files: FileRecord[];
  suspiciousEntries?: TarSuspiciousEntry[];
}

export interface CratesNonRegistryDependency {
  name: string;
  source: "git" | "path";
  section: string;
}

// Cargo.toml facts the deterministic rules key off. Parsed from the crate's
// normalized `Cargo.toml` text sample with a line-oriented reader — never by
// evaluating package bytes.
export interface CratesManifestSummary {
  name: string | null;
  version: string | null;
  links: string | null;
  /** `build = false` disables the build script; a string names a custom path. */
  buildValue: string | boolean | null;
  procMacro: boolean;
  nonRegistryDependencies: CratesNonRegistryDependency[];
}

export interface CratesArtifactSummary {
  path: string;
  kind: CratesArtifactKind;
  manifestPath: string | null;
  manifest: CratesManifestSummary;
  /** Path of the effective build script inside the crate, when present. */
  buildScriptPath: string | null;
}

export interface CratesPreparedArtifact extends CratesArtifactInput {
  kind: CratesArtifactKind;
  summary: CratesArtifactSummary;
}

export interface CratesAdapterInput {
  manifest: CratesReleaseManifest;
  artifacts: CratesArtifactInput[];
  previousArtifacts?: CratesArtifactInput[];
  metadata?: CratesIndexEntry[];
}

export interface CratesAdapterDetails {
  manifest: CratesReleaseManifest;
  artifacts: CratesArtifactSummary[];
  preparedArtifacts: CratesPreparedArtifact[];
}

/** One line of the crates.io sparse index file for a crate. */
export interface CratesIndexEntry {
  vers?: string;
  cksum?: string;
  yanked?: boolean;
}

export interface CratesReleaseCandidateReview {
  ecosystem: "crates";
  manifest: CratesReleaseManifest;
  package: {
    name: string | null;
    version: string | null;
  };
  fileCount: number;
  previousFileCount: number;
  artifacts: CratesArtifactSummary[];
  diff: DiffEntry[];
  ruleFindings: Finding[];
  risk: RiskLevel;
}
