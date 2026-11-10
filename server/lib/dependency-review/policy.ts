import type { PublicPackageDiff } from "../public-diff";
import { isInertAssetPath, isPackedArchivePath } from "../tar-parser.js";
import { combineRisk } from "../review";
import { CONSUMER_INSTALL_LIFECYCLE_SCRIPTS } from "../review/rules/patterns";
import type { FindingSeverity, RiskLevel } from "../review/types";
import { hasUnreadContent } from "./evidence";
import {
  DEFAULT_DEPENDENCY_REVIEW_POLICY,
  MAX_PUBLIC_MIRRORS,
  MAX_UNREAD_MINIMUM_AGE_DAYS,
  type BumpEvidence,
  type BumpFinding,
  type BumpOutcome,
  type BumpVerdict,
  type DependencyReviewConclusion,
  type DependencyReviewPolicy,
  type HoldReason,
  type ReviewedBump,
} from "./types";

export { hasUnreadContent };

const MAX_EVIDENCE_FINDINGS = 5;
// Evidence is stored per bump (progress and result); package-controlled text
// is cut well past what the check run or dashboard shows.
const MAX_EVIDENCE_TEXT = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
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
      ruleId: finding.ruleId ? finding.ruleId.slice(0, MAX_EVIDENCE_TEXT) : null,
      file: finding.file.slice(0, MAX_EVIDENCE_TEXT),
      reason: finding.reason.slice(0, MAX_EVIDENCE_TEXT),
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
    nativeBinariesChanged: changed.filter((entry) => entry.status === "modified" && isNative(entry))
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
  // An archive or compressed body counts by name or content even when decoded:
  // the rules read its bytes, never what it packs.
  if (entry.flags.includes("packed") || entry.flags.includes("zip-trailer")) return true;
  if (entry.flags.includes("binary") && isPackedArchivePath(entry.path)) return true;
  // Any other binary body the parser decoded (`control-bytes`) is read by the
  // rules. An inert asset is read by none but run by no runtime either;
  // anything else binary counts as uninspected. A native binary is counted on
  // its own (`nativeBinariesAdded`, `nativeBinariesChanged`).
  if (entry.flags.includes("binary") && !entry.flags.includes("control-bytes")) {
    return !isNative(entry) && !isInertAssetPath(entry.path);
  }
  return false;
}

/** The capability holds a diff supports, before the age fallback. */
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
  if (policy.holdOnUninspectedFiles && hasUnreadContent(evidence)) {
    reasons.push("uninspected-files");
  }
  return reasons.length > 0 ? { status: "hold", reasons, evidence } : { status: "clear", evidence };
}

/**
 * The age fallback for a bump nothing vouched for: null once the target
 * version is `unreadMinimumAgeDays` old by its registry publish time (or the
 * fallback is off), otherwise the hold's `passesAt`, absent when the publish
 * time is unknown. Pure: the clock is `nowMs`, so a replay can set it.
 */
export function ageHold(
  policy: DependencyReviewPolicy,
  publishedAt: string | null | undefined,
  nowMs: number,
): { passesAt?: string } | null {
  const days = policy.unreadMinimumAgeDays;
  if (days === null) return null;
  const publishedMs = publishedAt ? Date.parse(publishedAt) : Number.NaN;
  if (!Number.isFinite(publishedMs)) return {};
  const passesAtMs = publishedMs + days * DAY_MS;
  return nowMs < passesAtMs ? { passesAt: new Date(passesAtMs).toISOString() } : null;
}

/**
 * Whether `decideBump` reads this outcome's publish time under `policy`, so
 * the review stage looks one up only where it matters. A private-registry
 * bump is exempt (its versions are not public), a remote source has no
 * publish time to look up, and a switch that already holds the bump wins.
 */
export function needsReleaseAge(outcome: BumpOutcome, policy: DependencyReviewPolicy): boolean {
  if (policy.unreadMinimumAgeDays === null) return false;
  switch (outcome.kind) {
    case "diffed":
      return (
        hasUnreadContent(outcome.evidence) &&
        evaluateBumpEvidence(outcome.evidence, policy).status === "clear"
      );
    case "unreviewed":
      return (
        !policy.holdOnUnreviewed &&
        outcome.reason !== "private-source" &&
        outcome.reason !== "remote-source"
      );
    case "new-package":
      return !policy.holdOnNewPackages;
  }
}

/**
 * One bump's verdict: the diff decides where there is evidence, and the age
 * fallback covers what nothing vouched for. The switches that hold such a
 * bump outright (`holdOnUnreviewed`, `holdOnNewPackages`,
 * `holdOnUninspectedFiles`) take precedence over the fallback, and a bump
 * the diff already holds gets no age reason on top. Pure: `nowMs` is the
 * clock.
 */
export function decideBump(
  outcome: BumpOutcome,
  policy: DependencyReviewPolicy,
  nowMs: number,
): BumpVerdict {
  switch (outcome.kind) {
    case "diffed": {
      const verdict = evaluateBumpEvidence(outcome.evidence, policy);
      if (verdict.status !== "clear" || !hasUnreadContent(outcome.evidence)) return verdict;
      const age = ageHold(policy, outcome.publishedAt, nowMs);
      return age
        ? { status: "hold", reasons: ["too-new"], evidence: outcome.evidence, ...age }
        : verdict;
    }
    case "unreviewed": {
      const reason = outcome.reason;
      if (policy.holdOnUnreviewed) {
        return { status: "hold", reasons: ["unreviewed"], evidence: null, unreviewed: reason };
      }
      if (reason === "private-source") return { status: "unreviewed", unreviewed: reason };
      // A git ref, URL, or tarball has no registry publish time to wait out.
      const age = ageHold(policy, reason === "remote-source" ? null : outcome.publishedAt, nowMs);
      return age
        ? { status: "hold", reasons: ["too-new"], evidence: null, unreviewed: reason, ...age }
        : { status: "unreviewed", unreviewed: reason };
    }
    case "new-package": {
      if (policy.holdOnNewPackages) {
        return { status: "hold", reasons: ["new-package"], evidence: null };
      }
      const age = ageHold(policy, outcome.publishedAt, nowMs);
      return age
        ? { status: "hold", reasons: ["too-new"], evidence: null, ...age }
        : { status: "new-package" };
    }
  }
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
    unreadMinimumAgeDays: parseMinimumAgeDays(record.unreadMinimumAgeDays),
    publicMirrors: parsePublicMirrors(record.publicMirrors),
  };
}

function parseMinimumAgeDays(raw: unknown): number | null {
  if (raw === null) return null;
  return typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw >= 1 &&
    raw <= MAX_UNREAD_MINIMUM_AGE_DAYS
    ? raw
    : DEFAULT_DEPENDENCY_REVIEW_POLICY.unreadMinimumAgeDays;
}

const MAX_MIRROR_PREFIX_LENGTH = 200;

/**
 * A mirror prefix widens what is sent to the public registry, so an entry that
 * is not a plain https URL is dropped rather than repaired: no credentials,
 * query, or fragment, and a path that ends in `/` so `…/npm` cannot also match
 * `…/npm-private`.
 */
function parsePublicMirrors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const mirrors = new Set<string>();
  for (const entry of raw) {
    if (mirrors.size >= MAX_PUBLIC_MIRRORS) break;
    if (typeof entry !== "string" || entry.length > MAX_MIRROR_PREFIX_LENGTH) continue;
    let url: URL;
    try {
      url = new URL(entry.trim());
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      continue;
    }
    mirrors.add(`${url.origin}${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}`);
  }
  return [...mirrors];
}

/**
 * Why the settings API refuses a policy, or null. The stored policy is parsed
 * leniently (`parseDependencyReviewPolicy`), but a person saving settings is
 * told when a value they typed would be replaced or dropped.
 */
export function dependencyReviewPolicyInputError(input: Record<string, unknown>): string | null {
  const age = input.unreadMinimumAgeDays;
  if (
    age !== undefined &&
    age !== null &&
    !(
      typeof age === "number" &&
      Number.isInteger(age) &&
      age >= 1 &&
      age <= MAX_UNREAD_MINIMUM_AGE_DAYS
    )
  ) {
    return `The minimum age for unread updates is a whole number of days from 1 to ${MAX_UNREAD_MINIMUM_AGE_DAYS}, or off.`;
  }
  const mirrors = input.publicMirrors;
  if (
    mirrors !== undefined &&
    (!Array.isArray(mirrors) ||
      mirrors.length > MAX_PUBLIC_MIRRORS ||
      mirrors.some((entry) => parsePublicMirrors([entry]).length !== 1))
  ) {
    return `List up to ${MAX_PUBLIC_MIRRORS} mirror URLs, each starting with https:// and without a user name, password, query, or fragment.`;
  }
  return null;
}
