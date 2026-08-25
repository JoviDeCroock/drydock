import type { DiffEntry, FileRecord, Finding, RiskLevel } from "../../review";
import type { TarSuspiciousEntry } from "../../tar-parser.js";

export const BROWSER_RELEASE_MANIFEST_SCHEMA = "drydock.release-artifacts.v1";
export const BROWSER_RULES_VERSION = "0.12.0";

export const BROWSER_RULE_IDS = {
  metadataMismatch: "browser.metadata-mismatch",
  privilegedPermission: "browser.privileged-permission",
  broadHostAccess: "browser.broad-host-access",
  broadContentScript: "browser.broad-content-script",
  externallyConnectable: "browser.externally-connectable",
  unsafeExtensionCsp: "browser.unsafe-extension-csp",
} as const;

export type BrowserArtifactKind = "zip" | "xpi";

interface BrowserReleaseManifestArtifact {
  path: string;
  sha256: string;
  kind: BrowserArtifactKind;
}

export interface BrowserReleaseManifest {
  schema: typeof BROWSER_RELEASE_MANIFEST_SCHEMA;
  ecosystem: "browser";
  package: string;
  version: string;
  artifacts: BrowserReleaseManifestArtifact[];
}

export interface BrowserArtifactInput {
  path: string;
  sha256: string;
  files: FileRecord[];
  suspiciousEntries?: TarSuspiciousEntry[];
}

export interface BrowserAdapterInput {
  manifest: BrowserReleaseManifest;
  artifact: BrowserArtifactInput;
  previousArtifact?: BrowserArtifactInput;
}

export interface BrowserExtensionManifest {
  name: string;
  version: string;
  manifestVersion: 2 | 3;
  extensionId: string | null;
  permissions: string[];
  optionalPermissions: string[];
  hostPermissions: string[];
  optionalHostPermissions: string[];
  contentScriptMatches: string[];
  contentScriptEntrypoints: string[];
  userScriptEntrypoints: string[];
  externallyConnectableMatches: string[];
  externallyConnectableIds: string[];
  backgroundEntrypoints: string[];
  extensionPageEntrypoints: string[];
  contentSecurityPolicy: string | null;
}

export interface BrowserAdapterDetails {
  manifest: BrowserReleaseManifest;
  artifact: {
    path: string;
    sha256: string;
    kind: BrowserArtifactKind;
    extensionId: string | null;
    displayName: string;
    manifestPath: "manifest.json";
    manifestVersion: 2 | 3;
    permissions: string[];
    optionalPermissions: string[];
    hostPermissions: string[];
    optionalHostPermissions: string[];
    contentScriptMatches: string[];
    contentScriptEntrypoints: string[];
    userScriptEntrypoints: string[];
    externallyConnectableMatches: string[];
    externallyConnectableIds: string[];
    backgroundEntrypoints: string[];
    extensionPageEntrypoints: string[];
    contentSecurityPolicy: string | null;
  };
}

export interface BrowserReleaseCandidateReview {
  ecosystem: "browser";
  manifest: BrowserReleaseManifest;
  package: { name: string | null; version: string | null };
  fileCount: number;
  previousFileCount: number;
  diff: DiffEntry[];
  ruleFindings: Finding[];
  risk: RiskLevel;
}
