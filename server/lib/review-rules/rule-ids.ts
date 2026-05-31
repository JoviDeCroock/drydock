export const DETERMINISTIC_RULE_IDS = {
  installScriptPreinstall: "install-script.preinstall",
  installScript: "install-script.lifecycle",
  codeProcessExecution: "code.process-execution",
  codeNetworkAccess: "code.network-access",
  codeDynamicEvaluation: "code.dynamic-evaluation",
  codeCredentialAccess: "code.credential-access",
  fileSecretContent: "file.secret-content",
  fileLargeBinary: "file.large-binary",
  fileNativeArtifact: "file.native-artifact",
  fileOutsideFilesList: "file.outside-files-list",
  installScriptImplicitNodeGyp: "install-script.implicit-node-gyp",
  packageJsonParseFailed: "package-json.parse-failed",
  diffCredentialFileAdded: "diff.credential-file-added",
  diffLargeNewFile: "diff.large-new-file",
  dependencyUnusualSpec: "dependency.unusual-spec",
  dependencyOptionalAdded: "dependency.optional-added",
  stageMetadataMismatch: "stage.metadata-mismatch",
  tarSuspiciousEntry: "tar.suspicious-entry",
} as const;

export type DeterministicRuleKey = keyof typeof DETERMINISTIC_RULE_IDS;
