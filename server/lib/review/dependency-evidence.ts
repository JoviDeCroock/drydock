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
//   - `assessDependencyArtifact` — what the fetched bytes do, expressed as an
//     automatic-execution + capability verdict rather than a raw finding dump;
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

import type { DependencySection, PackageJsonDiff, PackageJsonDiffEntry } from "./serialize";
import type { FileRecord, Finding, PackageJsonSummary } from "./";
import { unusualDependencySpecKind } from "./dependency-specs";
import {
  DETERMINISTIC_RULE_IDS,
  DETERMINISTIC_RULES_VERSION,
  deterministicFindings,
  type DeterministicFindingOptions,
} from "./rules";
import { lifecycleReachablePaths, normalizeReachabilityPath } from "./rules/reachability";
import { normalizeStringRecord } from "../tar-parser.js";

/**
 * Synthetic file-label prefix for a dependency finding. The cited path is
 * inside *another* package's artifact, so it is not a file in this release's
 * diff and must never become an open-in-the-workbench link.
 */
const DEPENDENCY_FINDING_FILE_PREFIX = "<dependency>";

/** True for the synthetic labels {@link dependencyFindingFile} produces. */
export function isDependencyFindingFile(file: string): boolean {
  return file.startsWith(DEPENDENCY_FINDING_FILE_PREFIX);
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
type DependencyDeclarationKind = "exact" | "range" | "tag" | "unusual";

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
  | "artifact-truncated"
  | "budget-exhausted"
  | "review-failed";

type DependencyVerdict = "clean" | "install-execution" | "install-risk";

export interface DependencyDigest {
  algorithm: string;
  value: string;
}

/** One automatic (install/build-time) execution entrypoint of a dependency. */
interface DependencyExecutionEntrypoint {
  /** `script` for a package.json lifecycle hook, `node-gyp` for an implicit native build. */
  kind: "script" | "node-gyp";
  /** Lifecycle name (`preinstall`/`install`/`postinstall`) or the gyp file path. */
  name: string;
}

/**
 * The durable record for one newly introduced dependency.
 *
 * Persisted with the scan so a later unpublish cannot erase the review: the
 * declaration, the version selected at review time, the digest the registry
 * advertised, the digest recomputed from the bytes actually fetched, and the
 * verdict all survive the artifact disappearing.
 */
export interface DependencyEvidence {
  name: string;
  /** Manifest section that introduced it (this is the graph edge's label). */
  section: DependencySection;
  declaredSpec: string;
  declarationKind: DependencyDeclarationKind;
  status: DependencyEvidenceStatus;
  /** Set only when `status === "uninspectable"`. */
  reason: DependencyUninspectableReason | null;
  /** The version selected at review time. A snapshot, not provenance. */
  resolvedVersion: string | null;
  /** Registry host the artifact was resolved from, for provenance context. */
  registryHost: string | null;
  artifactUrl: string | null;
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
  verdict: DependencyVerdict;
}

export interface DependencyReview {
  /**
   * `not-applicable` — this release added no installable direct dependency.
   * `complete` — every selected dependency reached a terminal evidence record.
   * `partial` — a deadline, record cap, or unexpected failure stopped the pass.
   */
  status: "not-applicable" | "complete" | "partial";
  selectedCount: number;
  inspectedCount: number;
  uninspectableCount: number;
  /** Selected dependencies omitted from `dependencies` to bound persisted evidence. */
  omittedCount?: number;
  dependencies: DependencyEvidence[];
}

export const EMPTY_DEPENDENCY_REVIEW: DependencyReview = {
  status: "not-applicable",
  selectedCount: 0,
  inspectedCount: 0,
  uninspectableCount: 0,
  omittedCount: 0,
  dependencies: [],
};

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
export const MAX_INSPECTED_DEPENDENCIES = 6;

/** Maximum per-dependency records persisted for one release. */
export const MAX_RECORDED_DEPENDENCIES = 64;

/** Entries retained per dependency artifact. Well under the sandbox's own cap. */
export const DEPENDENCY_ARTIFACT_MAX_FILES = 600;

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

/** A manifest section whose contents a plain `npm install` downloads. */
// npm gives optionalDependencies precedence when the same key also appears in
// dependencies, so this order is also the effective-spec order.
const INSTALLING_SECTIONS: DependencySection[] = ["optionalDependencies", "dependencies"];

export interface AddedDependency {
  name: string;
  section: DependencySection;
  spec: string;
  declarationKind: DependencyDeclarationKind;
}

/**
 * Newly introduced direct dependencies whose code a consumer install pulls in.
 *
 * Included: `dependencies`, `optionalDependencies`, and *required* peers — npm
 * 7+ installs peers automatically, so a required peer added by this release or
 * changed from optional to required is third-party code that starts arriving
 * in consumer trees because of it.
 *
 * Excluded, deliberately:
 *   - `devDependencies`, which no consumer install fetches;
 *   - optional peers (`peerDependenciesMeta[name].optional`), which a consumer
 *     opts into rather than inherits;
 *   - keys that were already installed and merely moved between sections — a
 *     relocation ships no new code;
 *   - dependencies declared as bundled whose bytes are present in the staged
 *     artifact, because the parent review already covers those exact bytes;
 *   - every dependency of a first-ever release (no baseline manifest), where
 *     the whole list diffs as "added" and inspecting it would describe the
 *     package rather than the release.
 *
 * The same relocation and previously-installed signals the `dependency.added`
 * rule reads are reused here on purpose: a release must not be told "no new
 * dependency" by one surface and "new dependency" by the other.
 */
export interface DependencySelectionOptions {
  /** A missing manifest is an acquisition gap rather than a true first release. */
  includeWithoutBaseline?: boolean;
  /** Needed to distinguish registry dependencies from bytes bundled in the parent tarball. */
  stagedManifest?: PackageJsonSummary | null;
  stagedFiles?: FileRecord[];
}

export function selectAddedDependencies(
  manifestDiff: PackageJsonDiff,
  options: DependencySelectionOptions = {},
): AddedDependency[] {
  if (!manifestDiff.hasPreviousManifest && !options.includeWithoutBaseline) return [];

  const relocated = new Set<string>();
  for (const entry of manifestDiff.dependencies) {
    if (entry.status === "removed" && isInstallingSection(entry.section)) relocated.add(entry.key);
  }

  const byName = new Map<string, AddedDependency>();
  for (const entry of manifestDiff.dependencies) {
    if (entry.staged === undefined) continue;
    if (!introducesInstalledCode(entry, relocated)) continue;
    if (isBundledInStagedArtifact(entry, options)) continue;
    const candidate: AddedDependency = {
      name: entry.key,
      section: entry.section ?? "dependencies",
      spec: entry.staged,
      declarationKind: declarationKind(entry.staged),
    };
    // A key declared in more than one section is one dependency; keep the
    // installing declaration so the recorded edge is the one that fetches code.
    const existing = byName.get(entry.key);
    if (!existing || sectionRank(candidate.section) < sectionRank(existing.section)) {
      byName.set(entry.key, candidate);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function isBundledInStagedArtifact(
  entry: PackageJsonDiffEntry,
  options: DependencySelectionOptions,
): boolean {
  if (!isInstallingSection(entry.section)) return false;
  const manifest = options.stagedManifest;
  const declarations = [manifest?.bundleDependencies, manifest?.bundledDependencies];
  const declared = declarations.some(
    (value) => value === true || (Array.isArray(value) && value.includes(entry.key)),
  );
  if (!declared) return false;

  // Do not trust the manifest alone. A dependency is excluded only when its
  // package bytes are actually embedded in this release artifact.
  const prefix = `node_modules/${entry.key}/`;
  return (options.stagedFiles ?? []).some((file) => file.path.startsWith(prefix));
}

function introducesInstalledCode(entry: PackageJsonDiffEntry, relocated: Set<string>): boolean {
  if (
    entry.section === "peerDependencies" &&
    entry.status === "modified" &&
    entry.previousPeerOptional &&
    !entry.stagedPeerOptional
  ) {
    return true;
  }
  if (entry.status !== "added") return false;
  if (entry.previouslyInstalled || relocated.has(entry.key)) return false;
  if (isInstallingSection(entry.section)) return true;
  // A required peer newly *declared* by this release. `previouslyDeclared`
  // covers the peer that already existed in another section.
  return (
    entry.section === "peerDependencies" && !entry.stagedPeerOptional && !entry.previouslyDeclared
  );
}

function isInstallingSection(section: DependencySection | undefined): boolean {
  return section === "dependencies" || section === "optionalDependencies";
}

function sectionRank(section: DependencySection): number {
  return INSTALLING_SECTIONS.indexOf(section) === -1 ? 2 : INSTALLING_SECTIONS.indexOf(section);
}

/**
 * Classify how a spec pins its version. Only a fully exact spec earns `exact`;
 * everything else keeps the report honest about what a future install may
 * resolve.
 */
function declarationKind(spec: string): DependencyDeclarationKind {
  const trimmed = spec.trim();
  if (unusualDependencySpecKind(trimmed)) return "unusual";
  if (/^(?:=\s*)?v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed)) return "exact";
  // A dist-tag (`latest`, `next`) is a moving pointer, not a range: the bytes a
  // consumer installs can change without the manifest changing at all. A bare
  // `x`/`X` looks tag-shaped but is npm's any-version wildcard, so it stays a
  // range — mislabelling it would tell a reviewer the wrong thing about what
  // the declaration admits.
  if (trimmed !== "x" && trimmed !== "X" && /^[A-Za-z][\w.-]*$/.test(trimmed)) return "tag";
  return "range";
}

// Rule IDs that mean "installing this package runs code without anyone asking".
const AUTOMATIC_EXECUTION_RULE_IDS = new Set<string>([
  DETERMINISTIC_RULE_IDS.installScript,
  DETERMINISTIC_RULE_IDS.installScriptPreinstall,
  DETERMINISTIC_RULE_IDS.installScriptImplicitNodeGyp,
  DETERMINISTIC_RULE_IDS.installScriptGypCommandSubstitution,
]);

/**
 * Install-time behaviors with no benign reading.
 *
 * A package that pipes a remote script into a shell, reads credentials,
 * evaluates code it assembled, or ships an embedded secret is not doing any of
 * that as a build step. When one of these runs on install, the release is not
 * approvable without someone reading the dependency.
 */
const STRONG_INSTALL_DANGER_RULE_IDS = new Set<string>([
  DETERMINISTIC_RULE_IDS.codeRemoteShell,
  DETERMINISTIC_RULE_IDS.codeCredentialAccess,
  DETERMINISTIC_RULE_IDS.codeDynamicEvaluation,
  DETERMINISTIC_RULE_IDS.fileSecretContent,
]);

/**
 * Behaviors that turn automatic execution into something a reviewer has to
 * look at.
 *
 * Plain network access is in the set but scores a tier lower than the group
 * above, because it has two readings that look identical to a scanner:
 * `prebuild-install` / `node-pre-gyp` fetching a prebuilt binary, and a dropper
 * fetching a payload. Both are "this release starts downloading code on every
 * consumer install", which is worth a maintainer's attention the first time a
 * dependency is added — but calling it `critical` would spend the word on
 * `sharp` and leave nothing for the dropper.
 *
 * Process execution is deliberately absent entirely: prebuilt-binary packages
 * spawn `node-gyp` on install by design. It still contributes as a *capability*.
 */
const INSTALL_TIME_DANGER_RULE_IDS = new Set<string>([
  ...STRONG_INSTALL_DANGER_RULE_IDS,
  DETERMINISTIC_RULE_IDS.codeNetworkAccess,
]);

export interface DependencyArtifactAssessment {
  automaticExecution: DependencyExecutionEntrypoint[];
  capabilities: string[];
  installReachableCapabilities: string[];
  verdict: DependencyVerdict;
  /**
   * True when a danger capability exists in the artifact but no automatic
   * entrypoint provably reaches it. Reachability is a static over-approximation
   * that can miss a dynamic edge, so this state is reported one step below
   * proven reach rather than dismissed.
   */
  installReachUnproven: boolean;
  findings: Finding[];
}

/**
 * Run the deterministic rules over a fetched dependency artifact and reduce
 * them to a verdict about what installing it does.
 *
 * The rules are the same ones the reviewed release gets — a dependency's bytes
 * are no less hostile than the parent's — but the *roll-up* is different on
 * purpose. The parent's roll-up scores capability co-occurrence across a
 * release delta; here the question is narrower and sharper: does installing
 * this package run code, and does that code do something a downloader does?
 */
export function assessDependencyArtifact(
  files: FileRecord[],
  manifest: PackageJsonSummary | null,
  options: DeterministicFindingOptions = {},
): DependencyArtifactAssessment {
  const findings = deterministicFindings(files, [], manifest, options);
  const scripts = normalizeStringRecord(manifest?.scripts);
  const implicitScripts = normalizeStringRecord(manifest?.implicitScripts);

  const automaticExecution = executionEntrypoints(findings, scripts, implicitScripts);
  const capabilities = [
    ...new Set(findings.flatMap((finding) => (finding.ruleId ? [finding.ruleId] : []))),
  ].sort();

  const reachable = lifecycleReachablePaths(files, scripts, implicitScripts);
  // The manifest itself counts as install-reachable: `postinstall: "curl … | sh"`
  // is a dropper that never touches a packaged file, and its finding is filed
  // against package.json.
  const installReachable = (finding: Finding) =>
    finding.file === "package.json" ||
    finding.file.endsWith("/package.json") ||
    reachable.has(normalizeReachabilityPath(finding.file));

  const installReachableCapabilities = [
    ...new Set(
      findings.flatMap((finding) =>
        finding.ruleId && installReachable(finding) ? [finding.ruleId] : [],
      ),
    ),
  ].sort();

  const hasAutomaticExecution = automaticExecution.length > 0;
  const reachableDanger = installReachableCapabilities.some(
    (ruleId) =>
      INSTALL_TIME_DANGER_RULE_IDS.has(ruleId) || isNativeExecutionPair(ruleId, capabilities),
  );
  const anyDanger = capabilities.some((ruleId) => INSTALL_TIME_DANGER_RULE_IDS.has(ruleId));

  const verdict: DependencyVerdict = !hasAutomaticExecution
    ? "clean"
    : reachableDanger || anyDanger
      ? "install-risk"
      : "install-execution";

  return {
    automaticExecution,
    capabilities,
    installReachableCapabilities,
    verdict,
    installReachUnproven: hasAutomaticExecution && anyDanger && !reachableDanger,
    findings,
  };
}

// A native artifact is only an install-time execution concern when something
// runs on install to use it; on its own it is an ordinary prebuilt binary.
function isNativeExecutionPair(ruleId: string, capabilities: string[]): boolean {
  return (
    ruleId === DETERMINISTIC_RULE_IDS.fileNativeArtifact &&
    capabilities.includes(DETERMINISTIC_RULE_IDS.codeProcessExecution)
  );
}

function executionEntrypoints(
  findings: Finding[],
  scripts: Record<string, string>,
  implicitScripts: Record<string, string>,
): DependencyExecutionEntrypoint[] {
  const entrypoints: DependencyExecutionEntrypoint[] = [];
  for (const script of ["preinstall", "install", "postinstall"]) {
    if (!scripts[script] || implicitScripts[script] === scripts[script]) continue;
    entrypoints.push({ kind: "script", name: script });
  }
  for (const finding of findings) {
    if (!finding.ruleId || !AUTOMATIC_EXECUTION_RULE_IDS.has(finding.ruleId)) continue;
    if (finding.ruleId === DETERMINISTIC_RULE_IDS.installScript) continue;
    if (finding.ruleId === DETERMINISTIC_RULE_IDS.installScriptPreinstall) continue;
    entrypoints.push({ kind: "node-gyp", name: finding.file });
  }
  return entrypoints;
}

/**
 * The parent-to-dependency path a reviewer reads, e.g.
 * `left-pad@1.4.0 → proc-macro1@0.1.0 → package.json#scripts.postinstall`.
 */
function dependencyPathLabel(
  parent: { name: string | null; version: string | null },
  evidence: DependencyEvidence,
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
 * Bounded on purpose — one verdict finding per dependency plus at most one
 * aggregated capability finding — so a release that adds a dependency with a
 * hundred internal matches does not bury its own diff. The dependency's raw
 * findings stay on the evidence record for the report.
 *
 * Severity ladder, and why:
 *   - `install-risk` with a proven install-time reach → `critical`. This is the
 *     arrayref shape: adding the dependency runs a downloader on every consumer
 *     install. A release carrying it cannot be recommended for approval.
 *   - `install-risk` whose reach is unproven → `high`. The capability is in the
 *     artifact and something runs on install; static reachability just could not
 *     draw the edge. Failing quiet here would be the wrong direction.
 *   - `install-execution` → `medium`. Something runs on install, but nothing in
 *     it looks like a downloader.
 *   - `clean` → one `info` capability finding if the artifact has any capability
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
  for (const evidence of review.dependencies) {
    if (evidence.reason === "budget-exhausted" || evidence.reason === "review-failed") continue;
    if (evidence.status === "uninspectable") {
      findings.push(uninspectableFinding(evidence, parent));
      continue;
    }
    if (evidence.digestVerified === false) {
      findings.push(integrityMismatchFinding(evidence, parent));
    }
    const entrypoint = evidence.automaticExecution[0];
    const path = dependencyPathLabel(parent, evidence, entrypoint);
    if (evidence.verdict === "install-risk") {
      // Two independent axes, because they answer different questions.
      // `proven` is "can the install hook actually reach this?" — static
      // reachability can miss a dynamic edge, so an unproven reach is demoted
      // rather than dropped. `strong` is "does this behavior have a benign
      // reading?" — a remote shell does not, an HTTPS download does.
      const proven = evidence.installReachableCapabilities.some((ruleId) =>
        INSTALL_TIME_DANGER_RULE_IDS.has(ruleId),
      );
      const observed = proven ? evidence.installReachableCapabilities : evidence.capabilities;
      const strong = observed.some((ruleId) => STRONG_INSTALL_DANGER_RULE_IDS.has(ruleId));
      const behaviors =
        describeCapabilities(observed) ||
        "install-time behavior Drydock flags as downloader-shaped";
      findings.push({
        severity: strong ? (proven ? "critical" : "high") : proven ? "high" : "medium",
        file: dependencyFindingFile(evidence.name, evidence.resolvedVersion, "package.json"),
        ruleId: DETERMINISTIC_RULE_IDS.dependencyArtifactInstallRisk,
        evidence: `${path} → ${behaviors}`,
        reason: !strong
          ? "this release introduces a dependency that fetches over the network while installing. That is how prebuilt-binary tooling works and also how a dropper works, and a scanner cannot tell them apart — confirm what it downloads and from where before approving, because after this release every consumer install makes that request"
          : proven
            ? "this release introduces a dependency that runs automatically on install and whose install-time code path pipes remote code into a shell, evaluates assembled code, or reads credentials — the arrayref/proc-macro1 shape, where a compromised parent added a dependency whose build step fetched the payload; the dependency's own bytes were reviewed and are recorded with this scan"
            : "this release introduces a dependency that runs automatically on install and also carries remote-shell, credential-access, or dynamic-evaluation code; Drydock could not statically prove the install hook reaches it, so this is reported one step below a proven install-time path rather than dismissed",
      });
    } else if (evidence.verdict === "install-execution") {
      findings.push({
        severity: "medium",
        file: dependencyFindingFile(evidence.name, evidence.resolvedVersion, "package.json"),
        ruleId: DETERMINISTIC_RULE_IDS.dependencyArtifactInstallExecution,
        evidence: `${path} runs ${evidence.automaticExecution.map((entry) => entry.name).join(", ")} on install`,
        reason:
          "a newly introduced dependency executes code on every consumer install; nothing in its install path matched a downloader or credential pattern, but the execution itself is new behavior this release adds to consumer machines",
      });
    } else if (describeCapabilities(evidence.capabilities)) {
      findings.push({
        severity: "info",
        file: dependencyFindingFile(evidence.name, evidence.resolvedVersion),
        ruleId: DETERMINISTIC_RULE_IDS.dependencyArtifactCapability,
        evidence: `${path} — ${describeCapabilities(evidence.capabilities)}`,
        reason:
          "recorded so the newly introduced dependency's reviewed contents are visible; nothing in it runs automatically on install, so being new is not by itself a reason to hold the release",
      });
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
function aggregatedGapFinding(skipped: DependencyEvidence[], total: number): Finding {
  const shown = skipped.slice(0, 8);
  const names = shown.map((entry) => `${entry.name}@${entry.declaredSpec}`).join(", ");
  const suffix = total > shown.length ? `; ${total - shown.length} more omitted` : "";
  return {
    severity: "medium",
    file: DEPENDENCY_FINDING_FILE_PREFIX,
    ruleId: DETERMINISTIC_RULE_IDS.dependencyArtifactUninspectable,
    evidence: `${total} newly added ${total === 1 ? "dependency was" : "dependencies were"} not reviewed${names ? `: ${names}` : ""}${suffix}`,
    reason: UNINSPECTABLE_REASON_TEXT,
  };
}

function integrityMismatchFinding(
  evidence: DependencyEvidence,
  parent: { name: string | null; version: string | null },
): Finding {
  return {
    severity: "critical",
    file: dependencyFindingFile(evidence.name, evidence.resolvedVersion),
    ruleId: DETERMINISTIC_RULE_IDS.dependencyArtifactIntegrityMismatch,
    evidence: `${dependencyPathLabel(parent, evidence)} — registry ${digestLabel(evidence.declaredDigest)} != reviewed ${digestLabel(evidence.reviewedDigest)}`,
    reason:
      "the dependency bytes Drydock reviewed do not match the digest the registry advertised, so the reviewed artifact cannot be trusted as the dependency consumers install; re-fetch and resolve the registry integrity failure before approving",
  };
}

function digestLabel(digest: DependencyDigest | null): string {
  return digest ? `${digest.algorithm}-${digest.value}` : "digest unavailable";
}

function uninspectableFinding(
  evidence: DependencyEvidence,
  parent: { name: string | null; version: string | null },
): Finding {
  return {
    severity: "medium",
    file: dependencyFindingFile(evidence.name, evidence.resolvedVersion),
    ruleId: DETERMINISTIC_RULE_IDS.dependencyArtifactUninspectable,
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
  "artifact-truncated":
    "the dependency artifact contained a clipped or hash-only file body, so its bytes were not assessed as complete",
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
  const selected = selectAddedDependencies(manifestDiff, options);
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
): DependencyEvidence {
  return {
    name: boundedText(dependency.name, 256),
    section: dependency.section,
    declaredSpec: boundedText(dependency.spec, 512),
    declarationKind: dependency.declarationKind,
    status: "uninspectable",
    reason,
    resolvedVersion: null,
    registryHost: null,
    artifactUrl: null,
    declaredDigest: null,
    reviewedDigest: null,
    digestVerified: null,
    fileCount: null,
    automaticExecution: [],
    capabilities: [],
    installReachableCapabilities: [],
    verdict: "clean",
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
  const dependencies = value.dependencies.slice(0, MAX_RECORDED_DEPENDENCIES).flatMap((entry) => {
    const normalized = normalizeDependencyEvidence(entry);
    return normalized ? [normalized] : [];
  });
  return {
    status: overflowCount ? "partial" : status,
    selectedCount: countOf(value.selectedCount),
    inspectedCount: countOf(value.inspectedCount),
    uninspectableCount: countOf(value.uninspectableCount),
    omittedCount: countOf(value.omittedCount) + overflowCount,
    dependencies,
  };
}

function normalizeDependencyEvidence(value: unknown): DependencyEvidence | null {
  if (!isRecord(value)) return null;
  const { name, declaredSpec } = value;
  if (typeof name !== "string" || typeof declaredSpec !== "string") return null;
  const status = value.status === "inspected" ? "inspected" : "uninspectable";
  return {
    name: boundedText(name, 256),
    section: sectionOf(value.section),
    declaredSpec: boundedText(declaredSpec, 512),
    declarationKind: kindOf(value.declarationKind),
    status,
    reason: reasonOf(value.reason),
    resolvedVersion: boundedStringOrNull(value.resolvedVersion, 256),
    registryHost: boundedStringOrNull(value.registryHost, 256),
    artifactUrl: boundedStringOrNull(value.artifactUrl, 2_048),
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
    verdict:
      value.verdict === "install-risk" || value.verdict === "install-execution"
        ? value.verdict
        : "clean",
  };
}

function sectionOf(value: unknown): DependencySection {
  return value === "optionalDependencies" || value === "peerDependencies" ? value : "dependencies";
}

function kindOf(value: unknown): DependencyDeclarationKind {
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

function countOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
