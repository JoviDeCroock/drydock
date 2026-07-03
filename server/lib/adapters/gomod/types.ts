import type { DiffEntry, FileRecord, Finding, RiskLevel } from "../../review";
import type { TarSuspiciousEntry } from "../../tar-parser.js";

export const GO_RELEASE_MANIFEST_SCHEMA = "drydock.release-artifacts.v1";
export const GO_RULES_VERSION = "0.1.0";

export const GO_RULE_IDS = {
  metadataMissing: "go.metadata-missing",
  metadataMismatch: "go.metadata-mismatch",
  goGenerateAdded: "go.generate-directive-added",
  cgoIntroduced: "go.cgo-introduced",
  unsafeUsageAdded: "go.unsafe-usage-added",
  syscallUsageAdded: "go.syscall-usage-added",
  replaceDirective: "go.replace-directive",
} as const;

// Module paths: slash-separated segments of ASCII letters, digits, and
// `-._~`; the first segment must look like a domain (contain a dot).
export const GO_MODULE_PATH_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z0-9.-]+(?:\/[A-Za-z0-9._~-]+)*$/i;
// Canonical semver as Go requires for tagged module versions.
export const GO_VERSION_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;
export const SHA256_RE = /^[a-f0-9]{64}$/i;
export const GO_ARTIFACT_LIMIT = 20;

export type GoArtifactKind = "module";

export interface GoReleaseManifestArtifact {
  path: string;
  sha256: string;
  kind: GoArtifactKind;
}

export interface GoReleaseManifest {
  schema: typeof GO_RELEASE_MANIFEST_SCHEMA;
  ecosystem: "go";
  /** Module path, e.g. `github.com/user/repo`. */
  package: string;
  /** Canonical semver version, e.g. `v1.2.3`. */
  version: string;
  artifacts: GoReleaseManifestArtifact[];
}

export interface GoArtifactInput {
  path: string;
  files: FileRecord[];
  suspiciousEntries?: TarSuspiciousEntry[];
}

export interface GoModuleSummary {
  /** `module` line from go.mod. */
  modulePath: string | null;
  /** Module path + version parsed from the zip's `{module}@{version}/` root. */
  rootModulePath: string | null;
  rootVersion: string | null;
  replaceDirectives: string[];
}

export interface GoArtifactSummary {
  path: string;
  kind: GoArtifactKind;
  goModPath: string | null;
  module: GoModuleSummary;
}

export interface GoPreparedArtifact extends GoArtifactInput {
  kind: GoArtifactKind;
  summary: GoArtifactSummary;
}

export interface GoAdapterInput {
  manifest: GoReleaseManifest;
  artifacts: GoArtifactInput[];
  previousArtifacts?: GoArtifactInput[];
  /** Pre-fetched `proxy.golang.org` `@v/list` versions, for tests. */
  metadata?: string[];
}

export interface GoAdapterDetails {
  manifest: GoReleaseManifest;
  artifacts: GoArtifactSummary[];
  preparedArtifacts: GoPreparedArtifact[];
}

export interface GoReleaseCandidateReview {
  ecosystem: "go";
  manifest: GoReleaseManifest;
  package: {
    name: string | null;
    version: string | null;
  };
  fileCount: number;
  previousFileCount: number;
  artifacts: GoArtifactSummary[];
  diff: DiffEntry[];
  ruleFindings: Finding[];
  risk: RiskLevel;
}
