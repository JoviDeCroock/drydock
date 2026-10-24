import type { PublicPackageDiff } from "../public-diff";
import { combineRisk } from "../review";
import { CONSUMER_INSTALL_LIFECYCLE_SCRIPTS } from "../review/rules/patterns";
import type { FindingSeverity, RiskLevel } from "../review/types";
import {
  DEFAULT_DEPENDENCY_REVIEW_POLICY,
  type BumpEvidence,
  type BumpFinding,
  type BumpVerdict,
  type DependencyReviewConclusion,
  type DependencyReviewPolicy,
  type HoldReason,
  type ReviewedBump,
  type UnreviewedReason,
} from "./types";

const MAX_EVIDENCE_FINDINGS = 5;
const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high", "critical"];
const SEVERITY_RANK: Record<FindingSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};
const INSTALL_HOOKS: ReadonlySet<string> = new Set(CONSUMER_INSTALL_LIFECYCLE_SCRIPTS);
// Same extension backstop as the PR comment workflow: the sandbox's magic-byte
// sniff (`native-*` flags) is primary, but a native file it can't sniff still
// counts.
const NATIVE_FILE = /\.(?:node|dll|so|dylib|exe|wasm)$/i;
const MINIFIED_CODE = /\.min\.(?:js|mjs|cjs)$/i;
// Binary bodies no rule reads, but that no runtime executes either. Anything
// else binary (archives, unknown extensions) counts as uninspected.
const INERT_BINARY =
  /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|icns|tiff?|woff2?|ttf|otf|eot|mp3|mp4|ogg|wav|webm|pdf)$/i;

/**
 * What a published release changed, reduced to the facts the policy reads.
 * Only release-delta findings count: context findings describe code the
 * previous version already shipped, which this bump does not introduce.
 */
export function extractBumpEvidence(diff: PublicPackageDiff): BumpEvidence {
  const changed = diff.diff.filter(
    (entry) => entry.status === "added" || entry.status === "modified",
  );
  const hooks = diff.packageJsonDiff.scripts.filter((entry) => INSTALL_HOOKS.has(entry.key));
  const findings: BumpFinding[] = diff.findings
    .filter((finding) => finding.releaseDelta)
    .map((finding) => ({
      severity: finding.severity,
      ruleId: finding.ruleId ?? null,
      file: finding.file,
      reason: finding.reason,
    }))
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  return {
    releaseRisk: diff.risk.releaseRisk,
    filesAdded: diff.diff.filter((entry) => entry.status === "added").length,
    filesRemoved: diff.diff.filter((entry) => entry.status === "removed").length,
    filesChanged: diff.diff.filter((entry) => entry.status === "modified").length,
    installScriptsAdded: hooks.filter((entry) => entry.status === "added").length,
    installScriptsChanged: hooks.filter((entry) => entry.status === "modified").length,
    nativeBinariesAdded: changed.filter((entry) => entry.status === "added" && isNative(entry))
      .length,
    dependenciesAdded: diff.packageJsonDiff.dependencies.filter(
      (entry) => entry.status === "added" && !entry.previouslyDeclared,
    ).length,
    binCommandsAdded: diff.packageJsonDiff.bin.filter((entry) => entry.status === "added").length,
    uninspectedFiles: changed.filter(isUninspected).length,
    coverageNotices: diff.notices?.length ?? 0,
    findings: findings.slice(0, MAX_EVIDENCE_FINDINGS),
    findingCount: findings.length,
  };
}

function isNative(entry: { path: string; flags: string[] }): boolean {
  return entry.flags.some((flag) => flag.startsWith("native-")) || NATIVE_FILE.test(entry.path);
}

function isUninspected(entry: { path: string; flags: string[] }): boolean {
  if (entry.flags.includes("content-skipped")) return true;
  if (entry.flags.includes("text-sample-skipped")) return MINIFIED_CODE.test(entry.path);
  if (entry.flags.includes("binary")) {
    // A native binary is its own hold reason; counting it again here would
    // only repeat it.
    if (isNative(entry)) return false;
    return !INERT_BINARY.test(entry.path);
  }
  return false;
}

export function evaluateBumpEvidence(
  evidence: BumpEvidence,
  policy: DependencyReviewPolicy,
): BumpVerdict {
  const reasons: HoldReason[] = [];
  if (policy.holdOnInstallScripts) {
    if (evidence.installScriptsAdded > 0) reasons.push("install-script-added");
    if (evidence.installScriptsChanged > 0) reasons.push("install-script-changed");
  }
  if (policy.holdOnNativeBinaries && evidence.nativeBinariesAdded > 0) {
    reasons.push("native-binary-added");
  }
  if (policy.holdOnNewDependencies && evidence.dependenciesAdded > 0) {
    reasons.push("dependency-added");
  }
  if (policy.holdOnNewBinCommands && evidence.binCommandsAdded > 0) {
    reasons.push("bin-command-added");
  }
  if (
    policy.holdAtReleaseRisk &&
    combineRisk(evidence.releaseRisk, policy.holdAtReleaseRisk) === evidence.releaseRisk
  ) {
    reasons.push("release-risk");
  }
  // `?? 0`: evidence persisted before coverage notices existed lacks the field.
  if (
    policy.holdOnUninspectedFiles &&
    (evidence.uninspectedFiles > 0 || (evidence.coverageNotices ?? 0) > 0)
  ) {
    reasons.push("uninspected-files");
  }
  return reasons.length > 0 ? { status: "hold", reasons, evidence } : { status: "clear", evidence };
}

export function unreviewedVerdict(
  reason: UnreviewedReason,
  policy: DependencyReviewPolicy,
): BumpVerdict {
  return policy.holdOnUnreviewed
    ? { status: "hold", reasons: ["unreviewed"], evidence: null, unreviewed: reason }
    : { status: "unreviewed", unreviewed: reason };
}

export function newPackageVerdict(policy: DependencyReviewPolicy): BumpVerdict {
  return policy.holdOnNewPackages
    ? { status: "hold", reasons: ["new-package"], evidence: null }
    : { status: "new-package" };
}

/**
 * The check's outcome. Any hold nobody approved keeps the check blocking;
 * `approved` means every hold was approved, which reads differently from a
 * PR where nothing needed approval.
 */
export function concludeDependencyReview(
  bumps: readonly ReviewedBump[],
): DependencyReviewConclusion {
  let approvedHold = false;
  for (const { verdict, approved } of bumps) {
    if (verdict.status !== "hold") continue;
    if (!approved) return "held";
    approvedHold = true;
  }
  return approvedHold ? "approved" : "clear";
}

/**
 * Settings are stored as JSON. A missing or invalid field falls back to its
 * default rather than failing the whole policy, so adding a field later
 * needs no migration and a hand-edited row can't switch every hold off.
 */
export function parseDependencyReviewPolicy(value: unknown): DependencyReviewPolicy {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const record = input as Record<string, unknown>;
  const flag = (key: keyof DependencyReviewPolicy): boolean => {
    const raw = record[key];
    return typeof raw === "boolean" ? raw : (DEFAULT_DEPENDENCY_REVIEW_POLICY[key] as boolean);
  };
  const risk = record.holdAtReleaseRisk;
  return {
    holdOnInstallScripts: flag("holdOnInstallScripts"),
    holdOnNativeBinaries: flag("holdOnNativeBinaries"),
    holdOnNewDependencies: flag("holdOnNewDependencies"),
    holdOnNewBinCommands: flag("holdOnNewBinCommands"),
    holdAtReleaseRisk:
      risk === null
        ? null
        : RISK_LEVELS.includes(risk as RiskLevel)
          ? (risk as RiskLevel)
          : DEFAULT_DEPENDENCY_REVIEW_POLICY.holdAtReleaseRisk,
    holdOnUninspectedFiles: flag("holdOnUninspectedFiles"),
    holdOnUnreviewed: flag("holdOnUnreviewed"),
    holdOnNewPackages: flag("holdOnNewPackages"),
  };
}
