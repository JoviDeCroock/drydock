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

// The four `code.*` rules detect runtime *capabilities*: the package can spawn
// processes, reach the network, evaluate code at runtime, or read credentials.
// Individually these are weak signals — benign build tooling and application code
// use them constantly — so the literal max-severity roll-up both over-detected
// (a lone `child_process` in a build helper landed high) and under-detected (a
// chain of individually-medium capabilities never escalated). Risk roll-up scores
// these by co-occurrence instead: an isolated capability is not risk on its own,
// while a combination (read-env + network, or any code-evaluation primitive
// paired with another capability) is the collect→exfiltrate / dropper shape.
type CodeCapability = "process-execution" | "network" | "dynamic-evaluation" | "credential-access";

const CODE_CAPABILITY_BY_RULE: Record<string, CodeCapability> = {
  [DETERMINISTIC_RULE_IDS.codeProcessExecution]: "process-execution",
  [DETERMINISTIC_RULE_IDS.codeNetworkAccess]: "network",
  [DETERMINISTIC_RULE_IDS.codeDynamicEvaluation]: "dynamic-evaluation",
  [DETERMINISTIC_RULE_IDS.codeCredentialAccess]: "credential-access",
};

// High-confidence malware primitives: arbitrary command execution and runtime
// code evaluation/obfuscation are rare in benign *package* runtime code, so one
// of them alongside any other capability is enough to escalate to high. Network
// and credential reads are common in benign code, so two of those alone only
// reach medium.
const STRONG_CODE_CAPABILITIES = new Set<CodeCapability>([
  "process-execution",
  "dynamic-evaluation",
]);

function severityToRisk(severity: string | null | undefined): RiskLevel {
  switch (severity) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
      return "medium";
    default:
      return "low"; // "info" | "low" | unknown
  }
}

function scoreCodeCapabilities(capabilities: Set<CodeCapability>): RiskLevel {
  // An isolated capability is not risk by itself (the over-detection fix).
  if (capabilities.size <= 1) return "low";
  // Two capabilities only escalate to high when a high-confidence primitive is
  // involved; two common reads (network + credential) stay medium.
  if (capabilities.size === 2) {
    return [...capabilities].some((capability) => STRONG_CODE_CAPABILITIES.has(capability))
      ? "high"
      : "medium";
  }
  // Three or more co-occurring capabilities is the full collect→exfiltrate shape.
  return "high";
}

// Weighted multi-signal risk roll-up. Structural findings (install hooks, secrets,
// files-allowlist escapes, native artifacts, dependency specs, metadata, …) stay
// authoritative and floor the risk at their own severity, exactly as before. The
// noisy `code.*` capability findings are instead scored by co-occurrence. This
// changes only the risk *roll-up*; deterministic findings are emitted unchanged.
export function computeRisk(
  findings: Array<{ severity?: string | null; ruleId?: string | null }>,
): RiskLevel {
  let structuralFloor: RiskLevel = "low";
  const codeCapabilities = new Set<CodeCapability>();
  for (const finding of findings) {
    const capability = finding.ruleId ? CODE_CAPABILITY_BY_RULE[finding.ruleId] : undefined;
    // A code capability finding that is itself critical (not expected today) is
    // never downgraded: it floors at critical like any other authoritative signal.
    if (capability && finding.severity !== "critical") {
      codeCapabilities.add(capability);
      continue;
    }
    structuralFloor = combineRisk(structuralFloor, severityToRisk(finding.severity));
  }
  return combineRisk(structuralFloor, scoreCodeCapabilities(codeCapabilities));
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
