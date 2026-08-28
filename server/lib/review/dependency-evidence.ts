// Dependency-artifact review: the ecosystem-free half.
//
// Drydock reviews the exact bytes of the release in front of it. A release that
// *adds a dependency* moves third-party code into every consumer install
// without any of those bytes appearing in the reviewed artifact — the
// arrayref → proc-macro1 shape, where a compromised parent added a dependency
// whose build script downloaded the payload (issue #595).
//
// This module owns everything that does not depend on which registry the
// dependency lives in:
//
//   - `selectAddedDependencies` — which manifest-diff rows are newly introduced
//     code a consumer install would actually fetch;
//   - `assessDependencyArtifact` — what the fetched bytes do, expressed as
//     separate execution and risk observations rather than a safety verdict;
//   - `dependencyEvidenceFindings` — the bounded, path-namespaced findings the
//     review packet shows and the risk roll-up scores.
//
// Resolution and fetching are ecosystem work and live in the adapter (see
// `lib/ecosystems/npm/dependency-artifacts.ts`).
//
// Honesty rules this module enforces, per issue #595:
//   - a review-time resolution is a *snapshot*, never permanent provenance;
//   - a range-based declaration keeps its range exposure visible;
//   - a dependency that could not be inspected fails visibly into manual
//     review instead of silently reading as clean.

import { type DependencySection, type PackageJsonDiff } from "./serialize";
import type { Finding } from "./";
import { DETERMINISTIC_RULE_IDS, DETERMINISTIC_RULES_VERSION } from "./rules";
import { isRecord } from "../platform/guards";
import { classifyDependencyInstallRisk, hasObservedInstallRisk } from "./dependency-analysis";
import {
  dependencyDeclarationKind,
  selectAddedDependencies,
  type AddedDependency,
  type DependencySelectionOptions,
} from "./dependency-selection";

export { assessDependencyArtifact, classifyDependencyInstallRisk } from "./dependency-analysis";
export {
  dependencyDeclarationKind,
  selectAddedDependencies,
  selectBundledAddedDependencies,
} from "./dependency-selection";
export type { AddedDependency, DependencyDeclarationKind } from "./dependency-selection";

/**
 * Synthetic file-label prefix for a dependency finding. The cited path is
 * inside *another* package's artifact, so it is not a file in this release's
 * diff and must never become an open-in-the-workbench link.
 */
const DEPENDENCY_FINDING_FILE_PREFIX = "<dependency>";

/** True for the synthetic labels {@link dependencyFindingFile} produces. */
export function isDependencyFindingFile(file: string): boolean {
  return file.startsWith(DEPENDENCY_FINDING_FILE_PREFIX) || file.startsWith("dependency/");
}

function dependencyFindingFile(name: string, version: string | null, path?: string): string {
  const coordinate = version ? `${name}@${version}` : name;
  return `${DEPENDENCY_FINDING_FILE_PREFIX}${coordinate}${path ? `:${path}` : ""}`;
}

/**
 * How firmly the declaration pins the version coordinate a consumer resolves.
 *
 * `exact` rules out a different version but does not cryptographically pin the
 * artifact bytes: custom registries can mutate a version in place. Everything
 * else additionally admits a version that did not exist at review time.
 */
type DependencyEvidenceStatus = "inspected" | "uninspectable";

/**
 * Why an added dependency has no reviewed bytes. Each value is a distinct
 * operator- and reviewer-facing story, and every one of them is a *gap*, never
 * a pass.
 */
export type DependencyUninspectableReason =
  | "unresolvable-spec"
  | "no-matching-version"
  | "metadata-unavailable"
  | "artifact-unavailable"
  | "artifact-too-large"
  | "artifact-unparseable"
  | "artifact-ambiguous"
  | "artifact-truncated"
  | "manifest-unavailable"
  | "budget-exhausted"
  | "review-failed";

export interface DependencyDigest {
  algorithm: string;
  value: string;
}

/** One automatic (install/build-time) execution entrypoint of a dependency. */
export interface DependencyExecutionEntrypoint {
  kind: "script" | "node-gyp";
  name: string;
}

export interface DependencyInstallObservation {
  execution: "observed" | "not-observed" | "unknown";
  risk: "observed" | "not-observed" | "unknown";
  /** A computed loader/process/shell edge can select a package path the static graph cannot name. */
  dynamicInstallTarget?: true;
}

export type DependencyInspectionOutcome =
  | "inspected"
  | "unresolved-spec"
  | "not-found"
  | "no-matching-version"
  | "metadata-unavailable"
  | "fetch-failed"
  | "too-large"
  | "count-capped"
  | "time-capped";

/** Durable, ecosystem-neutral evidence for one selected dependency artifact. */
export interface DependencyEvidence {
  name: string;
  section: DependencySection;
  declaredSpec: string;
  path: string;
  outcome: DependencyInspectionOutcome;
  outcomeDetail: string;
  resolution: {
    kind: "exact" | "range" | "dist-tag";
    version: string;
    tarballUrl: string;
    registryIntegrity: string | null;
    resolvedAt: string;
  } | null;
  artifact: {
    sha256: string;
    sha512: string;
    fileCount: number;
    totalBytes: number;
    integrityMatched: boolean | null;
  } | null;
  entrypoints: {
    lifecycleScripts: string[];
    hasInstallLifecycle: boolean;
    gypfile: boolean;
    binCount: number;
  } | null;
  findingCount: number;
}

export interface AddedDependencyDeclaration {
  name: string;
  section: DependencySection;
  declaredSpec: string;
}

/** Collision-free identity for one manifest declaration across review surfaces. */
export function dependencyDeclarationKey(
  name: string,
  section: DependencySection,
  declaredSpec: string,
): string {
  return JSON.stringify([section, name, declaredSpec]);
}

/** The direct, newly installable declarations issue #595 puts in scope. */
export function selectAddedDependencyDeclarations(
  manifestDiff: PackageJsonDiff,
): AddedDependencyDeclaration[] {
  if (!manifestDiff.hasPreviousManifest) return [];
  const sectionOrder: DependencySection[] = [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ];
  return manifestDiff.dependencies
    .filter(
      (entry) =>
        entry.status === "added" &&
        entry.staged !== undefined &&
        !entry.previouslyInstalled &&
        (entry.section === "dependencies" ||
          entry.section === "optionalDependencies" ||
          (entry.section === "peerDependencies" && !entry.stagedPeerOptional)),
    )
    .map((entry) => ({
      name: entry.key,
      section: entry.section ?? "dependencies",
      declaredSpec: entry.staged as string,
    }))
    .sort(
      (a, b) =>
        sectionOrder.indexOf(a.section) - sectionOrder.indexOf(b.section) ||
        a.name.localeCompare(b.name),
    );
}

/** Direct declarations whose bytes must come from the registry, not the parent artifact. */
export function selectAddedRegistryDependencyDeclarations(
  manifestDiff: PackageJsonDiff,
  options: DependencySelectionOptions = {},
): AddedDependencyDeclaration[] {
  const registryNames = new Set(
    selectAddedDependencies(manifestDiff, options).map((dependency) => dependency.name),
  );
  return selectAddedDependencyDeclarations(manifestDiff).filter(
    (dependency) => dependency.section === "peerDependencies" || registryNames.has(dependency.name),
  );
}

/**
 * The durable record for one newly introduced dependency.
 *
 * Persisted with the scan so a later unpublish cannot erase the review: the
 * declaration, the version selected at review time, the digest the registry
 * advertised, the digest recomputed from the bytes actually fetched, and the
 * install observations all survive the artifact disappearing.
 */
export interface ReviewedDependencyEvidence {
  name: string;
  /** Manifest section that introduced it (this is the graph edge's label). */
  section: DependencySection;
  declaredSpec: string;
  declarationKind: AddedDependency["declarationKind"];
  status: DependencyEvidenceStatus;
  /** Set only when `status === "uninspectable"`. */
  reason: DependencyUninspectableReason | null;
  /** The version selected at review time. A snapshot, not provenance. */
  resolvedVersion: string | null;
  /** Registry host the artifact was resolved from, for provenance context. */
  registryHost: string | null;
  /** HTTP(S) origin only. Registry-controlled paths may themselves carry signed credentials. */
  artifactOrigin: string | null;
  /** Digest the registry advertised for the resolved version. */
  declaredDigest: DependencyDigest | null;
  /** Digest recomputed from the bytes Drydock actually fetched and parsed. */
  reviewedDigest: DependencyDigest | null;
  /**
   * `true` when the two digests above exist and agree; `false` when they
   * disagree; `null` when one was missing, which is unverified, never a match.
   */
  digestVerified: boolean | null;
  fileCount: number | null;
  automaticExecution: DependencyExecutionEntrypoint[];
  /** Deterministic rule IDs observed inside the dependency artifact. */
  capabilities: string[];
  /**
   * Capabilities an automatic execution entrypoint can statically reach. A
   * subset of `capabilities`; empty when nothing runs on install.
   */
  installReachableCapabilities: string[];
  /** Observations stay separate from completeness and gate policy. */
  observation: DependencyInstallObservation;
}

export interface DependencyReview {
  /**
   * `not-applicable` — this release added no installable direct dependency.
   * `complete` — every selected dependency's bytes were fully inspected.
   * `partial` — at least one dependency was uninspectable or omitted.
   */
  status: "not-applicable" | "complete" | "partial";
  selectedCount: number;
  inspectedCount: number;
  uninspectableCount: number;
  /** Selected dependencies omitted from `dependencies` to bound persisted evidence. */
  omittedCount?: number;
  dependencies: ReviewedDependencyEvidence[];
  /** Ephemeral adapter output consumed by the pipeline before persistence. */
  evidence?: DependencyEvidence[];
  /** Ephemeral deterministic findings produced while dependency bytes are live. */
  findings?: Finding[];
}

export const EMPTY_DEPENDENCY_REVIEW: DependencyReview = {
  status: "not-applicable",
  selectedCount: 0,
  inspectedCount: 0,
  uninspectableCount: 0,
  omittedCount: 0,
  dependencies: [],
};

/** Merge exact embedded evidence with registry-fetched evidence under one report budget. */
export function mergeDependencyReviews(...reviews: DependencyReview[]): DependencyReview {
  const applicable = reviews.filter(
    (review) => review.status !== "not-applicable" || review.selectedCount > 0,
  );
  if (!applicable.length) return EMPTY_DEPENDENCY_REVIEW;

  const allDependencies = applicable.flatMap((review) => review.dependencies);
  const dependencies = allDependencies.slice(0, MAX_RECORDED_DEPENDENCIES);
  const overflowCount = allDependencies.length - dependencies.length;
  const omittedCount =
    applicable.reduce((total, review) => total + (review.omittedCount ?? 0), 0) + overflowCount;
  return {
    status:
      omittedCount > 0 ||
      applicable.some((review) => review.status === "partial" || review.uninspectableCount > 0)
        ? "partial"
        : "complete",
    selectedCount: applicable.reduce((total, review) => total + review.selectedCount, 0),
    inspectedCount: applicable.reduce((total, review) => total + review.inspectedCount, 0),
    uninspectableCount: applicable.reduce((total, review) => total + review.uninspectableCount, 0),
    omittedCount,
    dependencies,
  };
}

/**
 * How many newly added dependencies one release will fetch and parse.
 *
 * A release that adds thirty dependencies is a refactor, not the compromise
 * shape this feature exists for, and fetching thirty tarballs inside one
 * Worker invocation is neither affordable nor useful. Everything past the
 * budget is still counted in one aggregated uninspectable finding. Individual
 * records are capped separately so a hostile manifest cannot inflate the
 * persisted report without bound.
 */
export const MAX_INSPECTED_DEPENDENCIES = 8;

/** Maximum per-dependency records persisted for one release. */
export const MAX_RECORDED_DEPENDENCIES = 64;

/** Entries retained per dependency artifact. Well under the sandbox's own cap. */
export const DEPENDENCY_ARTIFACT_MAX_FILES = 800;

/**
 * Per-file text sample kept from a dependency artifact.
 *
 * Sits between the baseline budget and nothing: the dependency side is scanned
 * by the full rule set (so clipping is a detection cost, not free), but a
 * release can pull in several dependencies at once and none of their bodies are
 * persisted or rendered. 256 KiB keeps every ordinary install script and
 * entrypoint whole while bounding what a single vendored megabundle costs.
 */
export const DEPENDENCY_TEXT_SAMPLE_LIMIT = 256 * 1024;

/**
 * Replace the manifest-only "this dependency was not inspected" signal once
 * the dependency pass has a more precise terminal record for that declaration.
 */
export function reconcileDependencyReviewFindings<T extends Finding>(
  findings: T[],
  _review: DependencyReview,
): T[] {
  return findings;
}

/**
 * The parent-to-dependency path a reviewer reads, e.g.
 * `left-pad@1.4.0 → proc-macro1@0.1.0 → package.json#scripts.postinstall`.
 */
function dependencyPathLabel(
  parent: { name: string | null; version: string | null },
  evidence: ReviewedDependencyEvidence,
  entrypoint?: DependencyExecutionEntrypoint,
): string {
  const parentCoordinate = parent.name
    ? `${parent.name}${parent.version ? `@${parent.version}` : ""}`
    : "this release";
  const dependency = evidence.resolvedVersion
    ? `${evidence.name}@${evidence.resolvedVersion}`
    : `${evidence.name} (${evidence.declaredSpec})`;
  const tail = entrypoint
    ? entrypoint.kind === "script"
      ? ` → package.json#scripts.${entrypoint.name}`
      : ` → ${entrypoint.name}`
    : "";
  return `${parentCoordinate} → ${dependency}${tail}`;
}

/**
 * Project dependency evidence into the findings the review packet shows.
 *
 * Bounded on purpose — one policy finding per dependency plus at most one
 * aggregated capability finding — so a release that adds a dependency with a
 * hundred internal matches does not bury its own diff. The dependency's raw
 * findings stay on the evidence record for the report.
 *
 * Severity ladder, and why:
 *   - observed strong install-time risk → `critical`. This
 *     is the arrayref shape: adding the dependency runs a dropper on every
 *     consumer install. A release carrying it cannot be recommended for approval.
 *   - observed weak install-time risk → `high`. This covers
 *     both downloads and a process launch paired with a native executable.
 *   - unknown install-time risk → `high` for strong behavior and `medium` for
 *     network behavior. The capability is in the
 *     artifact and something runs on install; static reachability just could not
 *     draw the edge. Failing quiet here would be the wrong direction.
 *   - observed install execution with no observed risk → `medium`. Something runs on install, but nothing in
 *     it looks like a downloader.
 *   - no observed install execution → one `info` capability finding if the artifact has any capability
 *     at all, so "we looked, here is what it can do" is visible without a benign
 *     new dependency inflating the release's risk.
 *   - `uninspectable` → `medium`, which floors the release at manual review.
 */
export function dependencyEvidenceFindings(
  review: DependencyReview,
  parent: { name: string | null; version: string | null },
): Finding[] {
  const findings: Finding[] = [];
  const overBudget = review.dependencies.filter((entry) => entry.reason === "budget-exhausted");
  const reviewFailed = review.dependencies.filter((entry) => entry.reason === "review-failed");
  const omittedCount = review.omittedCount ?? 0;
  if (overBudget.length) {
    findings.push(
      aggregatedGapFinding(
        overBudget,
        overBudget.length + (reviewFailed.length ? 0 : omittedCount),
      ),
    );
  }
  if (reviewFailed.length) {
    findings.push(aggregatedGapFinding(reviewFailed, reviewFailed.length + omittedCount));
  }
  if (!overBudget.length && !reviewFailed.length && omittedCount) {
    findings.push(aggregatedGapFinding([], omittedCount));
  }
  for (const evidence of review.dependencies) {
    if (evidence.reason === "budget-exhausted" || evidence.reason === "review-failed") continue;
    // Integrity binds the review to the bytes the registry advertised. A
    // later parse/retention gap must not hide that critical failure merely
    // because the same evidence record is also uninspectable.
    if (evidence.digestVerified === false) {
      findings.push(integrityMismatchFinding(evidence, parent));
    }
    const entrypoint = evidence.automaticExecution[0];
    const path = dependencyPathLabel(parent, evidence, entrypoint);
    const classification =
      evidence.observation.execution === "observed"
        ? classifyDependencyInstallRisk(evidence)
        : null;
    if (classification) {
      // Two independent axes, because they answer different questions.
      // `proven` is "can the install hook actually reach this?" — static
      // reachability can miss a dynamic edge, so an unproven reach is demoted
      // rather than dropped. `strong` is "does this behavior have a benign
      // reading?" — a remote shell does not, an HTTPS download does.
      const { certainty, strong, nativeExecution, observedCapabilities: observed } = classification;
      const behaviors =
        describeCapabilities(observed) ||
        "install-time behavior Drydock flags as downloader-shaped";
      findings.push({
        severity: classification.severity,
        file: dependencyFindingFile(evidence.name, evidence.resolvedVersion, "package.json"),
        ruleId: DETERMINISTIC_RULE_IDS.dependencyInstallTimeCapability,
        evidence: `${path} → ${behaviors}`,
        reason: nativeExecution
          ? "this release introduces a dependency whose install-time path can invoke a native executable or load a native module; confirm that the binary and its install entrypoint are expected before approving, because every consumer install inherits that native execution"
          : !strong
            ? certainty === "observed"
              ? "this release introduces a dependency that fetches over the network while installing. That is how prebuilt-binary tooling works and also how a dropper works, and a scanner cannot tell them apart — confirm what it downloads and from where before approving, because after this release every consumer install makes that request"
              : "this release introduces a dependency that runs automatically on install and also contains network-capable code; Drydock could not statically prove the install hook reaches that code, so confirm whether it is an install-time download or unrelated package behavior before approving"
            : certainty === "observed"
              ? "this release introduces a dependency that runs automatically on install and whose install-time code path pipes remote code into a shell, evaluates assembled code, or reads credentials — the arrayref/proc-macro1 shape, where a compromised parent added a dependency whose build step fetched the payload; the dependency's own bytes were reviewed and are recorded with this scan"
              : "this release introduces a dependency that runs automatically on install and also carries remote-shell, credential-access, or dynamic-evaluation code; Drydock could not statically prove the install hook reaches it, so this is reported one step below a proven install-time path rather than dismissed",
      });
    } else if (evidence.status === "inspected" && evidence.observation.execution === "observed") {
      findings.push({
        severity: "medium",
        file: dependencyFindingFile(evidence.name, evidence.resolvedVersion, "package.json"),
        ruleId: DETERMINISTIC_RULE_IDS.dependencyInstallTimeCapability,
        evidence: `${path} runs ${evidence.automaticExecution.map((entry) => entry.name).join(", ")} on install`,
        reason:
          "a newly introduced dependency executes code on every consumer install; nothing in its install path matched a downloader or credential pattern, but the execution itself is new behavior this release adds to consumer machines",
      });
    } else if (evidence.status === "inspected" && describeCapabilities(evidence.capabilities)) {
      findings.push({
        severity: "info",
        file: dependencyFindingFile(evidence.name, evidence.resolvedVersion),
        ruleId: DETERMINISTIC_RULE_IDS.dependencyInstallTimeCapability,
        evidence: `${path} — ${describeCapabilities(evidence.capabilities)}`,
        reason:
          "recorded so the newly introduced dependency's reviewed contents are visible; nothing in it runs automatically on install, so being new is not by itself a reason to hold the release",
      });
    }
    // A completeness gap does not revoke what the retained bytes already
    // proved. Project both axes so unrelated truncation cannot downgrade a
    // critical install path to a generic manual-review floor.
    if (evidence.status === "uninspectable") {
      findings.push(uninspectableFinding(evidence, parent));
    }
  }
  // Same stamp every deterministic family carries, so a dependency finding can
  // be traced back to the ruleset that produced it exactly like any other.
  return findings.map((finding) => ({ ...finding, ruleVersion: DETERMINISTIC_RULES_VERSION }));
}

/**
 * One bounded finding for a whole-pass failure or dependency-budget overflow,
 * not one per entry: a refactor that adds many dependencies would otherwise
 * fill the packet with identical signals and inflate persisted evidence.
 */
function aggregatedGapFinding(skipped: ReviewedDependencyEvidence[], total: number): Finding {
  const shown = skipped.slice(0, 8);
  const names = shown.map((entry) => `${entry.name}@${entry.declaredSpec}`).join(", ");
  const suffix = total > shown.length ? `; ${total - shown.length} more omitted` : "";
  return {
    severity: "medium",
    file: DEPENDENCY_FINDING_FILE_PREFIX,
    ruleId: DETERMINISTIC_RULE_IDS.dependencyArtifactUnavailable,
    evidence: `${total} newly added ${total === 1 ? "dependency was" : "dependencies were"} not reviewed${names ? `: ${names}` : ""}${suffix}`,
    reason: UNINSPECTABLE_REASON_TEXT,
  };
}

function integrityMismatchFinding(
  evidence: ReviewedDependencyEvidence,
  parent: { name: string | null; version: string | null },
): Finding {
  return {
    severity: "critical",
    file: dependencyFindingFile(evidence.name, evidence.resolvedVersion),
    ruleId: DETERMINISTIC_RULE_IDS.dependencyArtifactUnavailable,
    evidence: `${dependencyPathLabel(parent, evidence)} — registry ${digestLabel(evidence.declaredDigest)} != reviewed ${digestLabel(evidence.reviewedDigest)}`,
    reason:
      "the dependency bytes Drydock reviewed do not match the digest the registry advertised, so the reviewed artifact cannot be trusted as the dependency consumers install; re-fetch and resolve the registry integrity failure before approving",
  };
}

function digestLabel(digest: DependencyDigest | null): string {
  return digest ? `${digest.algorithm}-${digest.value}` : "digest unavailable";
}

function uninspectableFinding(
  evidence: ReviewedDependencyEvidence,
  parent: { name: string | null; version: string | null },
): Finding {
  return {
    severity: "medium",
    file: dependencyFindingFile(evidence.name, evidence.resolvedVersion),
    ruleId: DETERMINISTIC_RULE_IDS.dependencyArtifactUnavailable,
    evidence: `${dependencyPathLabel(parent, evidence)} — ${UNINSPECTABLE_EVIDENCE[evidence.reason ?? "artifact-unavailable"]}`,
    reason: UNINSPECTABLE_REASON_TEXT,
  };
}

const UNINSPECTABLE_REASON_TEXT =
  "this release introduces a dependency whose own bytes Drydock could not review, so the release cannot be represented as fully reviewed; resolve the dependency by hand before approving";

const UNINSPECTABLE_EVIDENCE: Record<DependencyUninspectableReason, string> = {
  "unresolvable-spec":
    "the declared spec does not resolve to a registry version Drydock can fetch (git, URL, workspace protocol, or unsupported range grammar)",
  "no-matching-version": "no published version satisfies the declared spec",
  "metadata-unavailable":
    "the registry did not return metadata for this package to a credential-free request; a private or scoped-internal dependency needs manual review",
  "artifact-unavailable": "the dependency artifact could not be downloaded",
  "artifact-too-large": "the dependency artifact exceeded the scanner's size or entry limits",
  "artifact-unparseable": "the dependency artifact could not be parsed as a package archive",
  "artifact-ambiguous":
    "the dependency archive contains links, duplicate paths, or visually-confusable paths whose extraction cannot be represented as ordinary reviewed files",
  "artifact-truncated":
    "the dependency artifact contained a clipped or hash-only file body, so its bytes were not assessed as complete",
  "manifest-unavailable":
    "the dependency artifact has no readable root package.json, so install lifecycle behavior could not be assessed",
  "budget-exhausted":
    "this release adds more dependencies than one review fetches, so this one was recorded but not inspected",
  "review-failed":
    "the dependency review failed before Drydock could inspect this package; the release review remains incomplete",
};

/**
 * Fail visibly when an adapter-level dependency pass throws unexpectedly.
 * Records are capped, but selected/uninspectable counts preserve the full gap.
 */
export function failedDependencyReview(
  manifestDiff: PackageJsonDiff,
  options: DependencySelectionOptions = {},
): DependencyReview {
  const selected = selectAddedRegistryDependencyDeclarations(manifestDiff, options).map(
    (dependency) => ({
      name: dependency.name,
      section: dependency.section,
      spec: dependency.declaredSpec,
      declarationKind: dependencyDeclarationKind(dependency.declaredSpec),
    }),
  );
  if (!selected.length) return EMPTY_DEPENDENCY_REVIEW;
  const recorded = selected
    .slice(0, MAX_RECORDED_DEPENDENCIES)
    .map((dependency) => uninspectableEvidence(dependency, "review-failed"));
  return {
    status: "partial",
    selectedCount: selected.length,
    inspectedCount: 0,
    uninspectableCount: selected.length,
    omittedCount: selected.length - recorded.length,
    dependencies: recorded,
  };
}

function uninspectableEvidence(
  dependency: AddedDependency,
  reason: DependencyUninspectableReason,
): ReviewedDependencyEvidence {
  return {
    name: boundedText(dependency.name, 256),
    section: dependency.section,
    declaredSpec: boundedText(dependency.spec, 512),
    declarationKind: dependency.declarationKind,
    status: "uninspectable",
    reason,
    resolvedVersion: null,
    registryHost: null,
    artifactOrigin: null,
    declaredDigest: null,
    reviewedDigest: null,
    digestVerified: null,
    fileCount: null,
    automaticExecution: [],
    capabilities: [],
    installReachableCapabilities: [],
    observation: { execution: "unknown", risk: "unknown" },
  };
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

const CAPABILITY_LABELS: Record<string, string> = {
  [DETERMINISTIC_RULE_IDS.codeRemoteShell]: "shell command that fetches and executes remote code",
  [DETERMINISTIC_RULE_IDS.codeCredentialAccess]: "credential or environment access",
  [DETERMINISTIC_RULE_IDS.codeDynamicEvaluation]: "dynamic code evaluation",
  [DETERMINISTIC_RULE_IDS.codeNetworkAccess]: "network access",
  [DETERMINISTIC_RULE_IDS.codeProcessExecution]: "process execution",
  [DETERMINISTIC_RULE_IDS.fileSecretContent]: "embedded secret-shaped content",
  [DETERMINISTIC_RULE_IDS.fileNativeArtifact]: "native executable artifact",
  [DETERMINISTIC_RULE_IDS.fileLargeBinary]: "large binary payload",
};

/**
 * Human-facing summary of the capability rules that fired, or "" when none of
 * them is a capability a reviewer would act on.
 *
 * The empty string is load-bearing: a dependency whose only finding is
 * something like a manifest-shape rule has nothing to report, and an `info`
 * signal reading "no capability rules matched" is noise dressed as evidence.
 */
function describeCapabilities(capabilities: string[]): string {
  return capabilities
    .flatMap((ruleId) => (CAPABILITY_LABELS[ruleId] ? [CAPABILITY_LABELS[ruleId]] : []))
    .join(", ");
}

export function normalizeDependencyEvidence(value: unknown): DependencyEvidence[] | null {
  if (!Array.isArray(value) || value.length > MAX_RECORDED_DEPENDENCIES) return null;
  const evidence: DependencyEvidence[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    if (
      typeof entry.name !== "string" ||
      (entry.section !== "dependencies" &&
        entry.section !== "optionalDependencies" &&
        entry.section !== "peerDependencies") ||
      typeof entry.declaredSpec !== "string" ||
      typeof entry.path !== "string" ||
      !isDependencyInspectionOutcome(entry.outcome) ||
      typeof entry.outcomeDetail !== "string" ||
      typeof entry.findingCount !== "number"
    ) {
      return null;
    }
    const resolution = normalizeResolution(entry.resolution);
    const artifact = normalizeArtifact(entry.artifact);
    const entrypoints = normalizeEntrypoints(entry.entrypoints);
    if (resolution === undefined || artifact === undefined || entrypoints === undefined)
      return null;
    evidence.push({
      name: entry.name,
      section: entry.section,
      declaredSpec: entry.declaredSpec,
      path: entry.path,
      outcome: entry.outcome,
      outcomeDetail: entry.outcomeDetail,
      resolution,
      artifact,
      entrypoints,
      findingCount: entry.findingCount,
    });
  }
  return evidence;
}

function isDependencyInspectionOutcome(value: unknown): value is DependencyInspectionOutcome {
  return [
    "inspected",
    "unresolved-spec",
    "not-found",
    "no-matching-version",
    "metadata-unavailable",
    "fetch-failed",
    "too-large",
    "count-capped",
    "time-capped",
  ].includes(value as string);
}

function normalizeResolution(value: unknown): DependencyEvidence["resolution"] | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (
    (value.kind !== "exact" && value.kind !== "range" && value.kind !== "dist-tag") ||
    typeof value.version !== "string" ||
    typeof value.tarballUrl !== "string" ||
    (value.registryIntegrity !== null && typeof value.registryIntegrity !== "string") ||
    typeof value.resolvedAt !== "string"
  ) {
    return undefined;
  }
  try {
    const url = new URL(value.tarballUrl);
    const isPublicRegistry =
      url.protocol === "https:" && url.hostname.toLowerCase() === "registry.npmjs.org";
    const isLocalTestRegistry =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (url.username || url.password || (!isPublicRegistry && !isLocalTestRegistry))
      return undefined;
  } catch {
    return undefined;
  }
  return value as unknown as DependencyEvidence["resolution"];
}

function normalizeArtifact(value: unknown): DependencyEvidence["artifact"] | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (
    typeof value.sha256 !== "string" ||
    typeof value.sha512 !== "string" ||
    typeof value.fileCount !== "number" ||
    typeof value.totalBytes !== "number" ||
    (value.integrityMatched !== null && typeof value.integrityMatched !== "boolean")
  ) {
    return undefined;
  }
  return value as unknown as DependencyEvidence["artifact"];
}

function normalizeEntrypoints(value: unknown): DependencyEvidence["entrypoints"] | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !Array.isArray(value.lifecycleScripts)) return undefined;
  if (
    !value.lifecycleScripts.every((script) => typeof script === "string") ||
    typeof value.hasInstallLifecycle !== "boolean" ||
    typeof value.gypfile !== "boolean" ||
    typeof value.binCount !== "number"
  ) {
    return undefined;
  }
  return value as unknown as DependencyEvidence["entrypoints"];
}

/**
 * Re-validate a persisted dependency review read back from D1/R2.
 *
 * Persisted JSON is re-parsed rather than trusted: a report written before this
 * feature existed, or a malformed blob, must render as "no dependency review"
 * instead of half a record.
 */
export function normalizeDependencyReview(value: unknown): DependencyReview | null {
  if (!isRecord(value) || !Array.isArray(value.dependencies)) return null;
  const status =
    value.status === "complete" || value.status === "partial" || value.status === "not-applicable"
      ? value.status
      : null;
  if (!status) return null;
  const overflowCount = Math.max(0, value.dependencies.length - MAX_RECORDED_DEPENDENCIES);
  const dependencies: ReviewedDependencyEvidence[] = [];
  for (const entry of value.dependencies.slice(0, MAX_RECORDED_DEPENDENCIES)) {
    const normalized = normalizeReviewedDependencyEvidence(entry);
    // Dropping one registry-controlled row while retaining the raw complete
    // status/counts fabricates a clean review. Reject the blob as a unit.
    if (!normalized) return null;
    dependencies.push(normalized);
  }
  const omittedCount = (optionalCountOf(value.omittedCount) ?? 0) + overflowCount;
  const selectedCount = optionalCountOf(value.selectedCount) ?? dependencies.length + omittedCount;
  const retainedInspectedCount = dependencies.filter(
    (dependency) => dependency.status === "inspected",
  ).length;
  const retainedUninspectableCount = dependencies.length - retainedInspectedCount;
  const rawInspectedCount = optionalCountOf(value.inspectedCount);
  const rawUninspectableCount = optionalCountOf(value.uninspectableCount);
  const inspectedCount =
    rawInspectedCount ??
    (rawUninspectableCount === null
      ? retainedInspectedCount
      : selectedCount - rawUninspectableCount);
  const uninspectableCount = rawUninspectableCount ?? selectedCount - inspectedCount;
  if (
    selectedCount !== dependencies.length + omittedCount ||
    (selectedCount === 0 && status !== "not-applicable") ||
    inspectedCount < retainedInspectedCount ||
    uninspectableCount < retainedUninspectableCount ||
    inspectedCount + uninspectableCount !== selectedCount ||
    inspectedCount - retainedInspectedCount + (uninspectableCount - retainedUninspectableCount) !==
      omittedCount
  ) {
    return null;
  }
  return {
    status:
      selectedCount === 0
        ? "not-applicable"
        : omittedCount || uninspectableCount
          ? "partial"
          : "complete",
    selectedCount,
    inspectedCount,
    uninspectableCount,
    omittedCount,
    dependencies,
  };
}

/**
 * Persistable provenance for a fetched dependency artifact.
 *
 * Registry-controlled tarball URLs may carry credentials in userinfo, query,
 * fragments, or opaque same-origin path segments. None are needed to identify
 * the artifact in a report, and retaining them would turn a public export into
 * a credential disclosure. Keep only the HTTP(S) origin.
 */
export function sanitizeDependencyArtifactOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // Keep no registry-controlled path material. Signed download capabilities
    // are commonly placed in query/userinfo, but custom registries may put the
    // opaque credential in a same-origin path segment instead. The package
    // coordinate and reviewed digest already identify the artifact precisely.
    return boundedText(url.origin, 2_048);
  } catch {
    return null;
  }
}

function normalizeReviewedDependencyEvidence(value: unknown): ReviewedDependencyEvidence | null {
  if (!isRecord(value)) return null;
  const { name, declaredSpec } = value;
  if (typeof name !== "string" || typeof declaredSpec !== "string") return null;
  const status = value.status === "inspected" ? "inspected" : "uninspectable";
  const observation = dependencyInstallObservationOf(value, status);
  if (!observation) return null;
  return {
    name: boundedText(name, 256),
    section: sectionOf(value.section),
    declaredSpec: boundedText(declaredSpec, 512),
    declarationKind: kindOf(value.declarationKind),
    status,
    reason: reasonOf(value.reason),
    resolvedVersion: boundedStringOrNull(value.resolvedVersion, 256),
    registryHost: boundedStringOrNull(value.registryHost, 256),
    artifactOrigin: sanitizeDependencyArtifactOrigin(value.artifactOrigin ?? value.artifactUrl),
    declaredDigest: digestOf(value.declaredDigest),
    reviewedDigest: digestOf(value.reviewedDigest),
    digestVerified: typeof value.digestVerified === "boolean" ? value.digestVerified : null,
    fileCount:
      typeof value.fileCount === "number" ? Math.max(0, Math.floor(value.fileCount)) : null,
    automaticExecution: Array.isArray(value.automaticExecution)
      ? value.automaticExecution.slice(0, 32).flatMap((entry) => {
          if (!isRecord(entry) || typeof entry.name !== "string") return [];
          return [
            {
              kind: entry.kind === "node-gyp" ? "node-gyp" : "script",
              name: boundedText(entry.name, 512),
            },
          ];
        })
      : [],
    capabilities: stringList(value.capabilities),
    installReachableCapabilities: stringList(value.installReachableCapabilities),
    observation,
  };
}

function dependencyInstallObservationOf(
  value: Record<string, unknown>,
  status: DependencyEvidenceStatus,
): DependencyInstallObservation | null {
  if (isRecord(value.observation)) {
    const execution = observationOf(value.observation.execution);
    const risk = observationOf(value.observation.risk);
    if (execution && risk) {
      return {
        execution,
        risk,
        ...(value.observation.dynamicInstallTarget === true
          ? { dynamicInstallTarget: true as const }
          : {}),
      };
    }
  }
  if (status === "uninspectable") return { execution: "unknown", risk: "unknown" };

  // Backward compatibility for reports written before observations were split
  // from policy. An unproven legacy install-risk becomes unknown, not observed.
  if (value.verdict === "clean") return { execution: "not-observed", risk: "not-observed" };
  if (value.verdict === "install-execution") {
    return { execution: "observed", risk: "not-observed" };
  }
  if (value.verdict === "install-risk") {
    const reachable = stringList(value.installReachableCapabilities);
    return {
      execution: "observed",
      risk: hasObservedInstallRisk(reachable) ? "observed" : "unknown",
    };
  }
  return null;
}

function observationOf(value: unknown): DependencyInstallObservation["risk"] | null {
  return value === "observed" || value === "not-observed" || value === "unknown" ? value : null;
}

function sectionOf(value: unknown): DependencySection {
  return value === "optionalDependencies" || value === "peerDependencies" ? value : "dependencies";
}

function kindOf(value: unknown): AddedDependency["declarationKind"] {
  return value === "exact" || value === "tag" || value === "unusual" ? value : "range";
}

function reasonOf(value: unknown): DependencyUninspectableReason | null {
  return typeof value === "string" && value in UNINSPECTABLE_EVIDENCE
    ? (value as DependencyUninspectableReason)
    : null;
}

function digestOf(value: unknown): DependencyDigest | null {
  if (!isRecord(value)) return null;
  const { algorithm, value: digest } = value;
  if (typeof algorithm !== "string" || typeof digest !== "string") return null;
  return { algorithm: boundedText(algorithm, 32), value: boundedText(digest, 512) };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .slice(0, 128)
        .flatMap((entry) => (typeof entry === "string" ? [boundedText(entry, 256)] : []))
    : [];
}

function boundedStringOrNull(value: unknown, limit: number): string | null {
  return typeof value === "string" ? boundedText(value, limit) : null;
}

function optionalCountOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : null;
}
