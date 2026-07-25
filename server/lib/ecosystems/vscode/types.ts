import type { DiffEntry, FileRecord, Finding, RiskLevel } from "../../review";
import type { TarSuspiciousEntry } from "../../tar-parser.js";

export const VSCODE_RELEASE_MANIFEST_SCHEMA = "drydock.release-artifacts.v1";
export const VSCODE_RULES_VERSION = "0.1.0";

export const VSCODE_RULE_IDS = {
  metadataMismatch: "vscode.metadata-mismatch",
  broadActivation: "vscode.broad-activation",
  startupRemoteCommand: "vscode.startup-remote-command",
  startupWasmLoader: "vscode.startup-wasm-loader",
  undeclaredConfigurationRead: "vscode.undeclared-configuration-read",
  extensionDependency: "vscode.extension-dependency",
} as const;

type VscodeArtifactKind = "vsix";

interface VscodeReleaseManifestArtifact {
  path: string;
  sha256: string;
  kind: VscodeArtifactKind;
}

export interface VscodeReleaseManifest {
  schema: typeof VSCODE_RELEASE_MANIFEST_SCHEMA;
  ecosystem: "vscode";
  package: string;
  version: string;
  artifacts: VscodeReleaseManifestArtifact[];
}

export interface VscodeArtifactInput {
  path: string;
  sha256: string;
  files: FileRecord[];
  suspiciousEntries?: TarSuspiciousEntry[];
}

export interface VscodeAdapterInput {
  manifest: VscodeReleaseManifest;
  artifact: VscodeArtifactInput;
  previousArtifact?: VscodeArtifactInput;
}

export interface VscodeExtensionManifest {
  name: string;
  publisher: string;
  version: string;
  displayName: string | null;
  description: string | null;
  main: string | null;
  browser: string | null;
  activationEvents: string[];
  extensionDependencies: string[];
  extensionPack: string[];
  configurationProperties: string[];
  enginesVscode: string | null;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  files: string[] | undefined;
}

export interface VscodeAdapterDetails {
  manifest: VscodeReleaseManifest;
  artifact: {
    path: string;
    sha256: string;
    extensionId: string;
    packageJsonPath: string;
    activationEvents: string[];
    main: string | null;
    browser: string | null;
    extensionDependencies: string[];
    extensionPack: string[];
    configurationProperties: string[];
    enginesVscode: string | null;
  };
}

export interface VscodeReleaseCandidateReview {
  ecosystem: "vscode";
  manifest: VscodeReleaseManifest;
  package: {
    name: string | null;
    version: string | null;
  };
  fileCount: number;
  previousFileCount: number;
  diff: DiffEntry[];
  ruleFindings: Finding[];
  risk: RiskLevel;
}
