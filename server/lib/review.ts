import type { TarSuspiciousEntry } from "./tar-parser.js";
import { DETERMINISTIC_RULE_IDS, DETERMINISTIC_RULES_VERSION } from "./review-rules";
import type { DiffEntry } from "./review-diff";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface FileRecord {
  path: string;
  size: number;
  sha256: string;
  textSample?: string;
  flags: string[];
}

export interface Finding {
  severity: "info" | "low" | "medium" | "high" | "critical";
  file: string;
  evidence: string;
  reason: string;
  line?: number;
  ruleId?: string;
  ruleVersion?: string;
  // True when a code.* capability matched only after constant-folding (the
  // identifier was assembled/obfuscated, e.g. `['chi','ld_pro','cess'].join('')`).
  // Obfuscating a capability is itself a malice signal, so the risk roll-up does
  // not de-escalate a lone obfuscated capability the way it does a plain one.
  obfuscated?: boolean;
}

export type FindingDiffStatus = DiffEntry["status"] | "unknown";

export interface FindingDiffAnnotation {
  diffStatus: FindingDiffStatus;
  releaseDelta: boolean;
}

export type CodePatternSet = "javascript" | "python";

export interface FindingAnnotationOptions {
  previousFiles?: Array<Pick<FileRecord, "path" | "textSample" | "flags">>;
  stagedFiles?: Array<Pick<FileRecord, "path" | "textSample" | "flags">>;
  persistedAnnotations?: Map<string, FindingDiffAnnotation>;
  codePatternSet?: CodePatternSet;
}

export { createPackageDiff } from "./review-diff";
export type { DiffEntry } from "./review-diff";
export { summarizePackageJsonDiff } from "./review-serialize";
export type {
  DependencySection,
  PackageJsonDiff,
  PackageJsonDiffEntry,
  PackageJsonSummary,
} from "./review-serialize";
export {
  DETERMINISTIC_RULE_IDS,
  DETERMINISTIC_RULES_VERSION,
  deterministicFindings,
  packageJsonDiffFindings,
  PYTHON_EXECUTION_CAPABILITY_PATTERNS,
} from "./review-rules";
export type { DeterministicFindingOptions } from "./review-rules";
export {
  annotateFindingsWithDiffStatus,
  isReleaseDeltaStatus,
  normalizeFindingDiffStatus,
} from "./review-diff-annotation";
export { redactFileRecords, redactFindings, redactJson, redactText } from "./review-redaction";

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

// The code.* capability rules (process/network/eval/credential). These are the
// signals that over- and under-detect under a pure max-severity roll-up: a lone
// capability is weak evidence, but several together are the collect-and-exfiltrate
// shape. computeRisk scores them by co-occurrence instead of by max severity.
const CODE_CAPABILITY_RULE_IDS = new Set<string>([
  DETERMINISTIC_RULE_IDS.codeProcessExecution,
  DETERMINISTIC_RULE_IDS.codeNetworkAccess,
  DETERMINISTIC_RULE_IDS.codeDynamicEvaluation,
  DETERMINISTIC_RULE_IDS.codeCredentialAccess,
]);
// Process execution is the weak-on-its-own capability: legitimate build and CLI
// tooling routinely shells out (the `legit-build-childprocess` benign hard
// negative), so alone it is not evidence of risk. It escalates only when it
// co-occurs with another capability.
const WEAK_LONE_CAPABILITY: string = DETERMINISTIC_RULE_IDS.codeProcessExecution;

function severityToRisk(severity: string | null | undefined): RiskLevel {
  if (severity === "critical") return "critical";
  if (severity === "high") return "high";
  if (severity === "medium") return "medium";
  return "low";
}

export function tarSuspiciousEntryFindings(
  entries: TarSuspiciousEntry[] | undefined | null,
): Finding[] {
  if (!entries || !entries.length) return [];
  return entries.map((entry) => ({
    severity: tarSuspiciousSeverity(entry),
    file: entry.path || "<unknown>",
    evidence: `${entry.kind}: ${entry.detail}`,
    reason: tarSuspiciousReason(entry),
    ruleId: DETERMINISTIC_RULE_IDS.tarSuspiciousEntry,
    ruleVersion: DETERMINISTIC_RULES_VERSION,
  }));
}

function tarSuspiciousSeverity(entry: TarSuspiciousEntry): Finding["severity"] {
  if (entry.kind === "non-regular") {
    return entry.detail.includes("(directory)") ? "info" : "high";
  }
  return "medium";
}

function tarSuspiciousReason(entry: TarSuspiciousEntry): string {
  switch (entry.kind) {
    case "non-regular":
      if (entry.detail.includes("(directory)")) {
        return "archive contains an explicit directory entry; npm pack normally emits regular file records, so this is recorded for provenance but does not by itself indicate executable or link behavior";
      }
      return "npm publish only emits regular files; symlinks, hardlinks, devices, FIFOs, directories, or reserved entries in a tarball indicate a hand-crafted archive that may target the consumer's filesystem on extract";
    case "duplicate":
      return "two entries share the same normalized path; last-write-wins extraction means a benign first entry can mask a malicious second";
    case "unicode-confusable":
      return "path contains zero-width or visually-confusable characters; the consumer's tar implementation may canonicalize this differently than the reviewer and let it bypass deterministic file checks";
  }
}

// Weighted multi-signal risk roll-up (issue #193). Risk is the max of two
// independent signals so that finding emission stays authoritative while the
// roll-up reflects capability co-occurrence rather than a single max severity:
//
//   - anchorRisk: the severity of authoritative findings (install hooks, secrets,
//     native artifacts, files-list escapes, metadata/dependency rules, …). These
//     are risky on their own, so their severity still sets a floor exactly as the
//     old max-severity roll-up did.
//   - codeRisk: a co-occurrence score over the code.* capability rules. A lone
//     capability is weak evidence — a single `child_process` in a build script is
//     the benign hard negative that used to land high — but two or more distinct
//     capabilities in one release escalate to high (collect-and-exfiltrate).
//
// This only changes how findings roll up into a level; the findings themselves
// are unchanged, so the deterministic-findings-are-authoritative boundary holds.
export function computeRisk(
  findings: Array<{ severity?: string | null; ruleId?: string | null; obfuscated?: boolean }>,
): RiskLevel {
  let anchorRisk: RiskLevel = "low";
  // Per-capability roll-up: max severity plus whether any matching finding was
  // obfuscated. A lone non-process capability keeps its own severity (e.g.
  // eval/atob on an added file stays high — obfuscation survives base64 wrapping
  // — while a modified-file network read stays medium).
  const capabilities = new Map<string, { risk: RiskLevel; obfuscated: boolean }>();
  for (const finding of findings) {
    const ruleId = finding.ruleId ?? undefined;
    const risk = severityToRisk(finding.severity);
    if (ruleId && CODE_CAPABILITY_RULE_IDS.has(ruleId)) {
      const prior = capabilities.get(ruleId);
      capabilities.set(ruleId, {
        risk: combineRisk(prior?.risk, risk),
        obfuscated: Boolean(prior?.obfuscated || finding.obfuscated),
      });
    } else {
      // Unknown/absent ruleId falls here too: without a capability label we
      // cannot safely de-escalate, so it anchors at its severity (fail toward
      // higher risk).
      anchorRisk = combineRisk(anchorRisk, risk);
    }
  }
  return combineRisk(anchorRisk, codeCapabilityRisk(capabilities));
}

function codeCapabilityRisk(
  capabilities: Map<string, { risk: RiskLevel; obfuscated: boolean }>,
): RiskLevel {
  if (capabilities.size === 0) return "low";
  // Two or more distinct capabilities co-occurring in one release is the
  // collect-and-exfiltrate shape: escalate even if each is individually weak.
  if (capabilities.size >= 2) return "high";
  const [[ruleId, { risk, obfuscated }]] = capabilities;
  // A lone plain process-execution is benign build/CLI tooling — de-escalate. But
  // an *obfuscated* lone capability is not isolated evidence: hiding the
  // identifier is a second, co-occurring malice signal, so keep its severity.
  if (obfuscated) return risk;
  return ruleId === WEAK_LONE_CAPABILITY ? "low" : risk;
}

export function combineRisk(...risks: Array<RiskLevel | null | undefined>): RiskLevel {
  return risks.reduce<RiskLevel>((highest, risk) => {
    if (!risk) return highest;
    return RISK_RANK[risk] > RISK_RANK[highest] ? risk : highest;
  }, "low");
}

export function normalizeRisk(value: unknown): RiskLevel {
  return value === "critical" || value === "high" || value === "medium" || value === "low"
    ? value
    : "medium";
}
