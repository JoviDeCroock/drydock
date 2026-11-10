import type { PublicPackageDiff } from "../public-diff";
import { isInertAssetPath, isPackedArchivePath } from "../tar-parser.js";
import { combineRisk } from "../review";
import { CONSUMER_INSTALL_LIFECYCLE_SCRIPTS } from "../review/rules/patterns";
import type { FindingSeverity, RiskLevel } from "../review/types";
import { hasUnreadContent } from "./evidence";
import { canonicalPackageName } from "./lockfiles";
import {
  DEFAULT_DEPENDENCY_REVIEW_POLICY,
  MAX_PRIVATE_REGISTRIES,
  MAX_PRIVATE_SCOPES,
  MAX_PUBLIC_MIRRORS,
  MAX_UNREAD_MINIMUM_AGE_DAYS,
  type BumpEvidence,
  type BumpFinding,
  type BumpOutcome,
  type BumpVerdict,
  type DependencyBump,
  type DependencyEcosystem,
  type DependencyReviewConclusion,
  type DependencyReviewPolicy,
  type HoldReason,
  type NewDependencyCause,
  type ReviewedBump,
  type UnreviewedReason,
  type YoungPackage,
} from "./types";

export { hasUnreadContent };

const MAX_EVIDENCE_FINDINGS = 5;
// Evidence is stored per bump (progress and result); package-controlled text
// is cut well past what the check run or dashboard shows.
const MAX_EVIDENCE_TEXT = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
// Added dependency names kept per bump, by count and total length: they are
// stored with the evidence for every reviewed bump.
export const MAX_ADDED_DEPENDENCY_NAMES = 50;
const MAX_ADDED_DEPENDENCY_CHARS = 2_000;
// A package new to the lockfiles counts as young, for `dependency-added`, when
// it was first published fewer than this many days before the decision, or
// its installed version fewer than `YOUNG_VERSION_DAYS`. Measured on the
// replay (`pnpm run eval:dependency-review-replay`): of 52 npm packages that
// entered a lockfile through an added dependency, 8 were under 30 days old
// and 15 under 90; the worm pattern adds a dependency on a package created
// hours earlier, or on a fresh release of a dormant one.
export const YOUNG_PACKAGE_DAYS = 90;
export const YOUNG_VERSION_DAYS = 7;
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
  const added = diff.packageJsonDiff.dependencies.filter(
    (entry) => entry.status === "added" && !entry.previouslyDeclared,
  );
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
    dependenciesAdded: added.length,
    addedDependencies: addedDependencyNames(diff.ecosystem, added),
    binCommandsAdded: diff.packageJsonDiff.bin.filter((entry) => entry.status === "added").length,
    uninspectedFiles: changed.filter(isUninspected).length,
    coverageNotices: diff.notices?.length ?? 0,
    findings: findings.slice(0, MAX_EVIDENCE_FINDINGS),
    findingCount: findings.length,
  };
}

/**
 * A dependency name as the lockfiles key packages (PyPI: PEP 503; npm: as
 * written, case included), or null when it is not a valid package name for
 * the ecosystem. Names come from package.json or Requires-Dist, so they are
 * untrusted text.
 */
export function dependencyNameKey(ecosystem: string, name: string): string | null {
  return ecosystem === "npm" || ecosystem === "pypi" ? canonicalPackageName(ecosystem, name) : null;
}

function addedDependencyNames(
  ecosystem: string,
  added: ReadonlyArray<{ key: string }>,
): NonNullable<BumpEvidence["addedDependencies"]> {
  const names = new Set<string>();
  let chars = 0;
  let complete = true;
  for (const { key } of added) {
    const name = dependencyNameKey(ecosystem, key);
    if (name === null) complete = false;
    else if (names.has(name)) continue;
    else if (
      names.size < MAX_ADDED_DEPENDENCY_NAMES &&
      chars + name.length <= MAX_ADDED_DEPENDENCY_CHARS
    ) {
      names.add(name);
      chars += name.length;
    } else complete = false;
  }
  return { names: [...names].sort(), complete };
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
  scope?: NewDependencyScope,
): BumpVerdict {
  const reasons: HoldReason[] = [];
  let newDependency: NewDependencyCause | undefined;
  if (policy.holdOnInstallScripts) {
    if (evidence.installScriptsAdded > 0) reasons.push("install-script-added");
    if (evidence.installScriptsChanged > 0) reasons.push("install-script-changed");
  }
  if (policy.holdOnNativeBinaries && evidence.nativeBinariesAdded > 0) {
    reasons.push("native-binary-added");
  }
  if (policy.holdOnNewDependencies && evidence.dependenciesAdded > 0) {
    const held = newDependencyHold(evidence, scope);
    if (held) reasons.push("dependency-added");
    if (held && held !== "unscoped") newDependency = held;
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
  if (policy.holdOnUninspectedFiles && hasUnreadContent(evidence, unreadOptions(policy))) {
    reasons.push("uninspected-files");
  }
  if (reasons.length === 0) return { status: "clear", evidence };
  return newDependency
    ? { status: "hold", reasons, evidence, newDependency }
    : { status: "hold", reasons, evidence };
}

/**
 * What `dependency-added` reads beyond the bump's own evidence: its ecosystem,
 * whether its lockfile pins the whole tree, and the review's young new
 * packages in that ecosystem. Built for every bump by `newDependencyScopes`.
 */
export interface NewDependencyScope {
  ecosystem: DependencyEcosystem;
  lockfilePinsTree: boolean;
  // By `dependencyNameKey`.
  youngNewPackages: ReadonlyMap<string, YoungPackage>;
}

/**
 * Whether an added dependency holds, and why. The lockfile shows exactly what
 * enters the tree: an added dependency that resolves to a package already
 * there, or to a new version of one (its own diffed bump), or that is not
 * installed at all (an optional peer, a PyPI extra) brings nothing unread.
 * Only a package new to the lockfiles arrives with no diff, and the dangerous
 * one is also young. Without a scope, names, or a lockfile that pins the
 * whole tree, nothing can be matched, so any added dependency holds. A young
 * version's hold is not an age hold: no recheck lifts it once the version
 * ages; it holds until approved or re-run.
 */
function newDependencyHold(
  evidence: BumpEvidence,
  scope: NewDependencyScope | undefined,
): NewDependencyCause | "unscoped" | null {
  // A caller without the review's context: every added dependency holds.
  if (!scope) return "unscoped";
  if (!scope.lockfilePinsTree) return { cause: "lockfile-unpinned" };
  const added = evidence.addedDependencies;
  if (!added || !added.complete) return { cause: "unmatched" };
  for (const raw of added.names) {
    const name = dependencyNameKey(scope.ecosystem, raw);
    if (name === null) return { cause: "unmatched" };
    const young = scope.youngNewPackages.get(name);
    if (young) return { cause: "young-package", name, ...young };
  }
  return null;
}

/**
 * Why a new package counts as young at `nowMs`, or null when its age vouches
 * for it: first published at least `YOUNG_PACKAGE_DAYS` and its installed
 * version at least `YOUNG_VERSION_DAYS` before. Anything other than a plain
 * `new-package` outcome with both times known is young.
 */
function youngNewPackage(outcome: BumpOutcome, nowMs: number): YoungPackage | null {
  if (outcome.kind !== "new-package") return { why: "no-verdict" };
  if (outcome.pastReviewLimit) return { why: "age-unknown" };
  const first = outcome.firstPublishedAt;
  const version = outcome.publishedAt;
  const firstMs = first ? Date.parse(first) : Number.NaN;
  const versionMs = version ? Date.parse(version) : Number.NaN;
  if (!first || !version || !Number.isFinite(firstMs) || !Number.isFinite(versionMs)) {
    return { why: "age-unknown" };
  }
  if (nowMs - firstMs < YOUNG_PACKAGE_DAYS * DAY_MS) return { why: "first-published", at: first };
  if (nowMs - versionMs < YOUNG_VERSION_DAYS * DAY_MS) {
    return { why: "version-published", at: version };
  }
  return null;
}

/** Whether a bump is a package new to its lockfile (not a re-pin of one it had). */
function isNewPackageBump(bump: Pick<DependencyBump, "fromVersion" | "repinned">): boolean {
  return bump.fromVersion === null && !bump.repinned;
}

/**
 * One `NewDependencyScope` per bump, from the whole review: every package
 * new to any of the PR's lockfiles that `youngNewPackage` counts as young,
 * per ecosystem by normalized name. Pure, so a replay builds the same.
 */
export function newDependencyScopes(
  bumps: readonly DependencyBump[],
  outcomes: readonly BumpOutcome[],
  nowMs: number,
): NewDependencyScope[] {
  const young: Record<DependencyEcosystem, Map<string, YoungPackage>> = {
    npm: new Map(),
    pypi: new Map(),
  };
  bumps.forEach((bump, index) => {
    if (!isNewPackageBump(bump)) return;
    const name = dependencyNameKey(bump.ecosystem, bump.name);
    const why = youngNewPackage(outcomes[index], nowMs);
    if (name !== null && why && !young[bump.ecosystem].has(name)) {
      young[bump.ecosystem].set(name, why);
    }
  });
  return bumps.map((bump) => ({
    ecosystem: bump.ecosystem,
    lockfilePinsTree: bump.lockfilePinsTree === true,
    youngNewPackages: young[bump.ecosystem],
  }));
}

// An added native binary the policy holds as a capability is not also unread.
function unreadOptions(policy: DependencyReviewPolicy) {
  return { nativeAddedHeld: policy.holdOnNativeBinaries };
}

// No publish time could vouch for these bytes: a git ref, URL, or tarball, or a
// pin that is not the public release's.
function hasNoPublishTime(reason: UnreviewedReason): boolean {
  return reason === "remote-source" || reason === "unverified-pin";
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
 * bump is exempt (its versions are not public), a remote source or an
 * unverified pin has no publish time to look up, and a switch that already
 * holds the bump wins.
 */
export function needsReleaseAge(outcome: BumpOutcome, policy: DependencyReviewPolicy): boolean {
  if (policy.unreadMinimumAgeDays === null) return false;
  switch (outcome.kind) {
    case "diffed":
      // `dependency-added` may not hold once the whole review is known, so
      // it never stands in for the age lookup here.
      return (
        hasUnreadContent(outcome.evidence, unreadOptions(policy)) &&
        evaluateBumpEvidence(outcome.evidence, { ...policy, holdOnNewDependencies: false })
          .status === "clear"
      );
    case "unreviewed":
      return (
        !policy.holdOnUnreviewed &&
        outcome.reason !== "private-source" &&
        !hasNoPublishTime(outcome.reason)
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
 * the diff already holds gets no age reason on top. A bump past the review
 * limit (`pastReviewLimit`) had no publish time looked up, so it holds as
 * unknown and says why. `scope` is this bump's entry from
 * `newDependencyScopes`; without it any added dependency holds. Pure: `nowMs`
 * is the clock.
 */
export function decideBump(
  outcome: BumpOutcome,
  policy: DependencyReviewPolicy,
  nowMs: number,
  scope?: NewDependencyScope,
): BumpVerdict {
  switch (outcome.kind) {
    case "diffed": {
      const verdict = evaluateBumpEvidence(outcome.evidence, policy, scope);
      if (
        verdict.status !== "clear" ||
        !hasUnreadContent(outcome.evidence, unreadOptions(policy))
      ) {
        return verdict;
      }
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
      const age = ageHold(policy, hasNoPublishTime(reason) ? null : outcome.publishedAt, nowMs);
      return age
        ? {
            status: "hold",
            reasons: ["too-new"],
            evidence: null,
            unreviewed: reason,
            ...age,
            ...unchecked(outcome, age),
          }
        : { status: "unreviewed", unreviewed: reason };
    }
    case "new-package": {
      if (policy.holdOnNewPackages) {
        return { status: "hold", reasons: ["new-package"], evidence: null };
      }
      const age = ageHold(policy, outcome.publishedAt, nowMs);
      return age
        ? {
            status: "hold",
            reasons: ["too-new"],
            evidence: null,
            ...age,
            ...unchecked(outcome, age),
          }
        : { status: "new-package" };
    }
  }
}

function unchecked(
  outcome: { pastReviewLimit?: true },
  age: { passesAt?: string },
): { pastReviewLimit?: true } {
  return outcome.pastReviewLimit && !age.passesAt ? { pastReviewLimit: true } : {};
}

/**
 * Every policy field bump collection reads: which registries are mirrors,
 * which are the organization's own, and which npm scopes never leave it.
 * `collectBumps` takes only this, so a field classification starts reading
 * must be added here, and with it to `collectionPolicyKey`, which decides
 * whether a stored collection still holds.
 */
export type CollectionPolicy = Pick<
  DependencyReviewPolicy,
  "publicMirrors" | "privateRegistries" | "privateScopes"
>;

export function collectionPolicy(policy: CollectionPolicy): CollectionPolicy {
  return {
    publicMirrors: policy.publicMirrors ?? [],
    privateRegistries: policy.privateRegistries ?? [],
    privateScopes: policy.privateScopes ?? [],
  };
}

/** Equal for two policies exactly when collection would classify every bump alike. */
export function collectionPolicyKey(policy: CollectionPolicy): string {
  return JSON.stringify(collectionPolicy(policy));
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
    publicMirrors: parseRegistryPrefixes(record.publicMirrors, MAX_PUBLIC_MIRRORS),
    privateRegistries: parseRegistryPrefixes(record.privateRegistries, MAX_PRIVATE_REGISTRIES),
    privateScopes: parsePrivateScopes(record.privateScopes),
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

const MAX_REGISTRY_PREFIX_LENGTH = 200;

/**
 * Registry URL prefixes (`publicMirrors`, `privateRegistries`). A mirror
 * widens what is sent to the public registry and a private registry widens
 * what skips the age fallback, so an entry that is not a plain https URL is
 * dropped rather than repaired: no credentials, query, or fragment, and a
 * path that ends in `/` so `…/npm` cannot also match `…/npm-private`.
 */
function parseRegistryPrefixes(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const prefixes = new Set<string>();
  for (const entry of raw) {
    if (prefixes.size >= max) break;
    const prefix = registryPrefix(entry);
    if (prefix) prefixes.add(prefix);
  }
  return [...prefixes];
}

function registryPrefix(entry: unknown): string | null {
  if (typeof entry !== "string" || entry.length > MAX_REGISTRY_PREFIX_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(entry.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return null;
  }
  return `${url.origin}${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}`;
}

// npm's scope grammar: lowercase, URL-safe, not starting with `.` or `_`.
const NPM_SCOPE = /^@[a-z0-9~-][a-z0-9._~-]*$/;
const MAX_SCOPE_LENGTH = 214;

function privateScope(entry: unknown): string | null {
  if (typeof entry !== "string") return null;
  const scope = entry.trim().toLowerCase();
  return scope.length <= MAX_SCOPE_LENGTH && NPM_SCOPE.test(scope) ? scope : null;
}

function parsePrivateScopes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const scopes = new Set<string>();
  for (const entry of raw) {
    if (scopes.size >= MAX_PRIVATE_SCOPES) break;
    const scope = privateScope(entry);
    if (scope) scopes.add(scope);
  }
  return [...scopes];
}

function prefixListError(raw: unknown, max: number, what: string): string | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length > max || raw.some((entry) => !registryPrefix(entry))) {
    return `List up to ${max} ${what}, each starting with https:// and without a user name, password, query, or fragment.`;
  }
  return null;
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
  const listError =
    prefixListError(input.publicMirrors, MAX_PUBLIC_MIRRORS, "mirror URLs") ??
    prefixListError(input.privateRegistries, MAX_PRIVATE_REGISTRIES, "private registry URLs");
  if (listError) return listError;
  const scopes = input.privateScopes;
  if (
    scopes !== undefined &&
    (!Array.isArray(scopes) ||
      scopes.length > MAX_PRIVATE_SCOPES ||
      scopes.some((entry) => !privateScope(entry)))
  ) {
    return `List up to ${MAX_PRIVATE_SCOPES} npm scopes, each written like @your-company.`;
  }
  // One URL can't be both: a mirror's entries go to the public registry for
  // proof, a private registry's never leave it.
  const mirrors = parseRegistryPrefixes(input.publicMirrors, MAX_PUBLIC_MIRRORS);
  const registries = parseRegistryPrefixes(input.privateRegistries, MAX_PRIVATE_REGISTRIES);
  if (mirrors.some((m) => registries.some((r) => m.startsWith(r) || r.startsWith(m)))) {
    return "A URL can't be both a mirror and a private registry, or sit under one listed as the other.";
  }
  return null;
}
