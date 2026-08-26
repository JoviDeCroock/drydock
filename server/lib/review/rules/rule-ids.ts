// The deterministic rule manifest: everything about a rule except its match
// logic lives on its entry here — the dot-namespaced ID and how the risk
// roll-up treats it. `computeRisk` (review/index.ts) and release memory
// (risk.ts) derive their rule sets from this manifest, so reclassifying a rule
// is a one-line edit. Match logic stays in the family modules under rules/.
//
// `test/detection-rule-coverage.test.mjs` machine-checks the manifest: every
// rule needs a security-corpus fixture asserting its ID (or an explicit
// exception there) and an entry in the docs/security-detection-corpus.md rule
// inventory.
export interface DeterministicRuleSpec {
  /** Dot-namespaced rule ID; the segment before the first dot is the family. */
  id: string;
  /**
   * How `computeRisk` scores findings from this rule.
   *
   * - `anchor`: severity maps straight to risk and sets a floor.
   * - `capability`: the code.* capability signals (process/network/eval/
   *   credential). These over- and under-detect under a pure max-severity
   *   roll-up — a lone capability is weak evidence, but several together are
   *   the collect-and-exfiltrate shape — so they score by co-occurrence.
   * - `weak-lone-capability`: a capability that is not evidence of risk on its
   *   own and de-escalates to low unless it co-occurs with another capability
   *   or is obfuscated.
   */
  risk: "anchor" | "capability" | "weak-lone-capability";
  /**
   * Evidence of active compromise rather than a package capability: release
   * memory never discounts these findings as previously-approved context, even
   * when a prior approved release carried the same finding.
   */
  standingDanger?: true;
}

export const DETERMINISTIC_RULES = {
  installScriptPreinstall: {
    id: "install-script.preinstall",
    risk: "anchor",
    standingDanger: true,
  },
  installScript: { id: "install-script.lifecycle", risk: "anchor", standingDanger: true },
  // Process execution is the weak-on-its-own capability: legitimate build and
  // CLI tooling routinely shells out (the `legit-build-childprocess` benign
  // hard negative), so alone it is not evidence of risk. It escalates only
  // when it co-occurs with another capability.
  codeProcessExecution: { id: "code.process-execution", risk: "weak-lone-capability" },
  // Deliberately NOT weak, and a standing danger. It used to live inside
  // process-execution, which meant a release adding
  // `execSync('curl … | bash')` scored as one weak capability and rolled up to
  // `low` — the whole shell-mediated dropper class read as benign build
  // tooling. Spawning `cc` and spawning `curl … | bash` are not the same
  // evidence.
  codeRemoteShell: { id: "code.remote-shell", risk: "capability", standingDanger: true },
  codeNetworkAccess: { id: "code.network-access", risk: "capability" },
  codeDynamicEvaluation: { id: "code.dynamic-evaluation", risk: "capability" },
  codeCredentialAccess: { id: "code.credential-access", risk: "capability" },
  fileSecretContent: { id: "file.secret-content", risk: "anchor", standingDanger: true },
  filePromptInjection: { id: "file.prompt-injection", risk: "anchor" },
  fileReviewManipulation: {
    id: "file.review-manipulation",
    risk: "anchor",
    standingDanger: true,
  },
  fileLargeBinary: { id: "file.large-binary", risk: "anchor" },
  fileNativeArtifact: { id: "file.native-artifact", risk: "anchor" },
  fileOutsideFilesList: { id: "file.outside-files-list", risk: "anchor" },
  installScriptImplicitNodeGyp: {
    id: "install-script.implicit-node-gyp",
    risk: "anchor",
    standingDanger: true,
  },
  installScriptGypCommandSubstitution: {
    id: "install-script.gyp-command-substitution",
    risk: "anchor",
    standingDanger: true,
  },
  packageJsonParseFailed: { id: "package-json.parse-failed", risk: "anchor" },
  packageJsonEntrypointMissing: { id: "package-json.entrypoint-missing", risk: "anchor" },
  diffCredentialFileAdded: { id: "diff.credential-file-added", risk: "anchor" },
  diffLargeNewFile: { id: "diff.large-new-file", risk: "anchor" },
  diffBinAdded: { id: "diff.bin-added", risk: "anchor" },
  dependencyUnusualSpec: { id: "dependency.unusual-spec", risk: "anchor" },
  dependencyOptionalAdded: { id: "dependency.optional-added", risk: "anchor" },
  dependencyAdded: { id: "dependency.added", risk: "anchor" },
  dependencyMajorBump: { id: "dependency.major-bump", risk: "anchor" },
  stageMetadataMismatch: { id: "stage.metadata-mismatch", risk: "anchor" },
  stageTarballDigestMismatch: { id: "stage.tarball-digest-mismatch", risk: "anchor" },
  atpmProvenanceMissing: { id: "atpm.provenance-missing", risk: "anchor" },
  atpmProvenanceInvalid: { id: "atpm.provenance-invalid", risk: "anchor" },
  atpmProvenanceSubjectMismatch: { id: "atpm.provenance-subject-mismatch", risk: "anchor" },
  atpmProvenancePublisherMismatch: { id: "atpm.provenance-publisher-mismatch", risk: "anchor" },
  atpmTrustedPublishingLost: { id: "atpm.trusted-publishing-lost", risk: "anchor" },
  tarSuspiciousEntry: { id: "tar.suspicious-entry", risk: "anchor", standingDanger: true },
  // Anchors, not capabilities: the propagation rules are already gated on
  // install-time reachability, so each one is standalone evidence rather than a
  // signal that needs a second capability beside it to mean anything.
  propagationRegistryPublish: {
    id: "propagation.registry-publish",
    risk: "anchor",
    standingDanger: true,
  },
  propagationPackageMutation: {
    id: "propagation.package-mutation",
    risk: "anchor",
    standingDanger: true,
  },
  releaseSourceDrift: { id: "release.source-drift", risk: "anchor" },
} as const satisfies Record<string, DeterministicRuleSpec>;

export type DeterministicRuleKey = keyof typeof DETERMINISTIC_RULES;

export const DETERMINISTIC_RULE_IDS = Object.fromEntries(
  Object.entries(DETERMINISTIC_RULES).map(([key, spec]) => [key, spec.id]),
) as { [K in DeterministicRuleKey]: (typeof DETERMINISTIC_RULES)[K]["id"] };

export function deterministicRuleIds(
  predicate: (spec: DeterministicRuleSpec) => boolean,
): Set<string> {
  const specs: DeterministicRuleSpec[] = Object.values(DETERMINISTIC_RULES);
  return new Set(specs.filter(predicate).map((spec) => spec.id));
}
