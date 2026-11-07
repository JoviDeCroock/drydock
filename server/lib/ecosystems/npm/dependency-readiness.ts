/**
 * Dependency readiness: can a consumer install this release's runtime
 * dependencies the moment it goes public?
 *
 * A release-correctness notice, never a security finding. It does not feed
 * risk, findings, the report, or a decision; the decision view computes it on
 * load because the answer changes after the scan (a sibling stage is approved,
 * a dependency is published) while the reviewed bytes do not. Every lookup
 * failure is "could not check", never a reason to hold a release.
 *
 * The manifest is package bytes: names and specs here are hostile data. They
 * only select registry packument reads on the organization's own registry
 * (the same read the scan pipeline already makes for the package itself),
 * are bounded by `MAX_CHECKED_TARGETS` cache reads and `MAX_REGISTRY_READS`
 * registry reads per check, and are rendered as text.
 */
import { mapWithConcurrency } from "../../platform/concurrency";
import { isRecord } from "../../platform/guards";
import { scanEcosystem } from "../../public-feed";
import { unusualDependencySpecKind } from "../../review/dependency-specs";
import type { PackageJsonSummary } from "../../review/serialize";
import {
  maxSatisfyingVersion,
  parseSemverRange,
  rangeSatisfiedBy,
  type SemverRange,
} from "../semver-range";
import { isValidLegacyNpmPackageName } from "./registry";

const DECISION_SOURCES = new Set(["manual", "auto_discovery", "workflow_gate"]);

/**
 * A completed npm review that a maintainer still decides on: a staged
 * release or a held workflow-gate deployment. Published-pair and other
 * ecosystems' scans have no approve control for this to sit beside.
 */
export function dependencyReadinessAppliesToScan(scan: {
  status: string;
  source: string;
  summaryJson: unknown;
}): boolean {
  return (
    scan.status === "complete" &&
    DECISION_SOURCES.has(scan.source) &&
    scanEcosystem(scan.source, scan.summaryJson) === "npm"
  );
}

// Bounded per request: a manifest declaring hundreds of dependencies cannot
// turn one page load into hundreds of registry reads. Every target is first
// asked of the cache; only cache misses (then revalidations of a cached "not
// yet") spend the registry budget. The client hands back the previous check's
// `nextOffset`, so the next check reads the next batch even while the cache
// still hides the last one's writes (KV keeps a miss for up to a minute).
// Changed specs go first, so a first check covers what this release changed.
const MAX_REGISTRY_READS = 40;
// Targets past this are never read (not even from the cache) and are reported
// as beyond the check rather than "not checked yet", which a retry would never
// fix.
const MAX_CHECKED_TARGETS = 300;
const DEPENDENCY_LOOKUP_CONCURRENCY = 6;
const CACHE_LOOKUP_CONCURRENCY = 12;
// A ceiling, not a start cutoff: lookups still unstarted when it runs out are
// reported unchecked and reads in flight are abandoned as failed, so a slow
// registry costs the reader seconds, not the Worker's request lifetime.
const DEPENDENCY_LOOKUP_BUDGET_MS = 10_000;
const MAX_DECLARED_DEPENDENCIES = 1_000;

/**
 * `peerDependencies` are checked (npm 7+ installs non-optional peers, so an
 * unresolvable peer range fails the consumer's install) but labeled, so the
 * reader can weigh a peer the consumer may already provide. Optional peers are
 * never installed by npm and are skipped. `devDependencies` never install.
 */
type DependencyReadinessSection = "dependencies" | "optionalDependencies" | "peerDependencies";

type ClassifiedSpec =
  | {
      kind: "registry";
      target: string;
      range: SemverRange | null;
      tag: string | null;
      /** The literal `*` or empty spec, which npm resolves to `latest` even when it is a prerelease. */
      latestWildcard: boolean;
    }
  | { kind: "local" }
  | { kind: "remote" }
  | { kind: "invalid" };

interface PlannedRequirement {
  name: string;
  spec: string;
  section: DependencyReadinessSection;
  changed: boolean;
  bundled: boolean;
  classified: ClassifiedSpec;
}

export interface DependencyReadinessPlan {
  requirements: PlannedRequirement[];
}

export interface ReleaseSibling {
  name: string;
  version: string;
}

/** A stage this organization holds for a dependency, from its own review rows. */
export interface StagedDependencyCandidate {
  scanId: string;
  packageName: string;
  version: string;
  decision: string | null;
  registryVersionStatus: string | null;
}

export type PackageVersionsLookup =
  | { status: "found"; versions: string[]; distTags: Record<string, string> }
  | { status: "not-found" }
  /** The registry document is past what one check reads; retrying cannot help. */
  | { status: "too-large" }
  | { status: "error" };

type DependencyReadinessIssueKind =
  /** Not public yet, and this organization holds a stage that satisfies it. */
  | "staged"
  /** No public version satisfies the spec, and nothing staged here does. */
  | "unpublished"
  /** `workspace:`, `catalog:`, `file:`, or a path: no consumer can resolve it. */
  | "local-spec"
  /** Could not be checked; never a verdict. */
  | "unchecked";

type DependencyUncheckedReason =
  /** The registry read failed; a retry may succeed. */
  | "lookup-failed"
  /** Not reached within this request's read or time budget; the next check reaches it. */
  | "lookup-skipped"
  /** Past `MAX_CHECKED_TARGETS`; no retry reaches it. */
  | "lookup-limit"
  /** Its registry document is too large to read; no retry reaches it. */
  | "too-large"
  | "unsupported-spec";

export interface DependencyReadinessIssue {
  name: string;
  spec: string;
  section: DependencyReadinessSection;
  kind: DependencyReadinessIssueKind;
  /** The registry package an `npm:` alias resolves to, when it differs from `name`. */
  target?: string;
  reason?: DependencyUncheckedReason;
  /** For `unpublished`: whether the registry knows the package at all. */
  packageFound?: boolean;
  staged?: {
    scanId: string;
    version: string;
    decision: string | null;
    registryVersionStatus: string | null;
  };
}

export interface DependencyReadinessReport {
  status: "checked";
  /** Declared runtime dependencies considered (excluding optional peers). */
  declared: number;
  /** Specs that install from somewhere other than the registry (git, URL); not checked. */
  notRegistry: number;
  /** Satisfied by another package in the same gated release. */
  satisfiedByRelease: number;
  /**
   * Whether registry reads used the organization's credential. A gate review
   * without a usable npm connection reads anonymously, so a private package it
   * cannot see may still install for consumers who have access.
   */
  credentialed: boolean;
  issues: DependencyReadinessIssue[];
  /**
   * Present when some dependency was not reached: where the next check should
   * resume its registry reads. A hint the server clamps, never authority.
   */
  nextOffset?: number;
}

/** `GET /api/v1/scans/:id/dependency-readiness`. */
export type DependencyReadinessResponse =
  | DependencyReadinessReport
  | { status: "not-applicable" }
  | {
      status: "unavailable";
      reason: "report-unavailable" | "npm-connection-unavailable" | "npm-connection-changed";
    };

// Prototype-free, so a dependency named `constructor` or `toString` is looked
// up as itself rather than shadowed by Object.prototype.
function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!isRecord(value)) return out;
  for (const [key, spec] of Object.entries(value)) {
    if (typeof spec === "string") out[key] = spec;
  }
  return out;
}

function isPathSpec(spec: string): boolean {
  return (
    /^(?:\.{1,2}(?:[/\\]|$)|~[/\\]|[/\\]|[a-zA-Z]:[/\\])/.test(spec) ||
    /\.(?:tgz|tar|tar\.gz)$/i.test(spec)
  );
}

function classifyRegistrySpec(target: string, spec: string): ClassifiedSpec {
  if (!isValidLegacyNpmPackageName(target)) return { kind: "invalid" };
  const trimmed = spec.trim();
  const latestWildcard = trimmed === "" || trimmed === "*";
  const range = parseSemverRange(trimmed);
  if (range) return { kind: "registry", target, range, tag: null, latestWildcard };
  // npm reads any other URL-safe spec as a dist-tag (`latest`, `next`).
  if (/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(trimmed)) {
    return { kind: "registry", target, range: null, tag: trimmed, latestWildcard: false };
  }
  return { kind: "invalid" };
}

/** How npm would resolve one `dependencies` value, following npm-package-arg's order. */
export function classifyDependencySpec(name: string, spec: string): ClassifiedSpec {
  const trimmed = spec.trim();
  const unusual = unusualDependencySpecKind(trimmed);
  if (unusual === "npm alias") {
    const rest = trimmed.slice(4);
    const at = rest.indexOf("@", rest.startsWith("@") ? 1 : 0);
    const target = at < 0 ? rest : rest.slice(0, at);
    const range = at < 0 ? "" : rest.slice(at + 1);
    if (unusualDependencySpecKind(range)) return { kind: "invalid" };
    return classifyRegistrySpec(target, range);
  }
  if (unusual === "local file" || unusual === "workspace-protocol") return { kind: "local" };
  if (unusual) return { kind: "remote" };
  if (isPathSpec(trimmed)) return { kind: "local" };
  // No semver range contains `/`: `owner/repo` (and `git@host:owner/repo`) is
  // npm's GitHub shorthand.
  if (trimmed.includes("/")) return { kind: "remote" };
  return classifyRegistrySpec(name, trimmed);
}

function changedKey(section: string, name: string) {
  return `${section}\u0000${name}`;
}

/** Names with a top-level `node_modules/<name>/package.json` in the tarball. */
export function packedDependencyNames(paths: Iterable<string>): Set<string> {
  const names = new Set<string>();
  for (const path of paths) {
    const match = /^node_modules\/((?:@[^/]+\/)?[^/@][^/]*)\/package\.json$/.exec(path);
    if (match) names.add(match[1]);
  }
  return names;
}

/**
 * Dependencies the consumer gets from the tarball itself: packed under
 * `node_modules/` AND declared in `bundleDependencies` (`true` bundles every
 * `dependencies` entry). npm installs a packed directory the manifest does not
 * declare from the registry like any other dependency, so the packed path
 * alone proves nothing. `rawManifest` is the tarball's parsed `package.json`;
 * without it nothing counts as bundled.
 */
export function bundledDependencyNames(
  packed: ReadonlySet<string>,
  rawManifest: unknown,
): Set<string> {
  const names = new Set<string>();
  if (!packed.size || !isRecord(rawManifest)) return names;
  const declared = rawManifest.bundleDependencies ?? rawManifest.bundledDependencies;
  const roots =
    declared === true
      ? Object.keys(isRecord(rawManifest.dependencies) ? rawManifest.dependencies : {})
      : Array.isArray(declared)
        ? declared.filter((name): name is string => typeof name === "string")
        : [];
  for (const name of roots) if (packed.has(name)) names.add(name);
  return names;
}

export function planDependencyReadiness(
  manifest: PackageJsonSummary | null | undefined,
  options: {
    changed?: Iterable<{ key: string; section?: string; status: string }>;
    bundled?: ReadonlySet<string>;
  } = {},
): DependencyReadinessPlan {
  const dependencies = stringMap(manifest?.dependencies);
  const optional = stringMap(manifest?.optionalDependencies);
  const peers = stringMap(manifest?.peerDependencies);
  const peerMeta: Record<string, unknown> = isRecord(manifest?.peerDependenciesMeta)
    ? manifest.peerDependenciesMeta
    : {};
  const has = (map: object, name: string) => Object.hasOwn(map, name);
  const changed = new Set<string>();
  for (const entry of options.changed ?? []) {
    if (entry.status !== "removed" && entry.section)
      changed.add(changedKey(entry.section, entry.key));
  }

  const entries: Array<[DependencyReadinessSection, string, string]> = [];
  // npm lets an optionalDependencies entry replace a same-named dependency.
  for (const [name, spec] of Object.entries(dependencies)) {
    if (!has(optional, name)) entries.push(["dependencies", name, spec]);
  }
  for (const [name, spec] of Object.entries(optional))
    entries.push(["optionalDependencies", name, spec]);
  for (const [name, spec] of Object.entries(peers)) {
    if (has(dependencies, name) || has(optional, name)) continue;
    const meta = has(peerMeta, name) ? peerMeta[name] : undefined;
    if (isRecord(meta) && meta.optional === true) continue;
    entries.push(["peerDependencies", name, spec]);
  }

  // An oversized manifest keeps what this release changed first, then the
  // declaration order; the kept entries are reported in declaration order.
  const isChanged = ([section, name]: (typeof entries)[number]) =>
    changed.has(changedKey(section, name));
  const kept =
    entries.length <= MAX_DECLARED_DEPENDENCIES
      ? entries
      : entries
          .map((entry, index) => ({ entry, index }))
          .sort((a, b) => Number(isChanged(b.entry)) - Number(isChanged(a.entry)))
          .slice(0, MAX_DECLARED_DEPENDENCIES)
          .sort((a, b) => a.index - b.index)
          .map(({ entry }) => entry);

  return {
    requirements: kept.map((entry) => {
      const [section, name, spec] = entry;
      return {
        name,
        spec,
        section,
        changed: isChanged(entry),
        bundled: options.bundled?.has(name) ?? false,
        classified: classifyDependencySpec(name, spec),
      };
    }),
  };
}

/** The registry packages a plan reads, de-duplicated. */
export function dependencyReadinessTargets(plan: DependencyReadinessPlan): string[] {
  const targets = new Set<string>();
  for (const req of plan.requirements) {
    if (!req.bundled && req.classified.kind === "registry") targets.add(req.classified.target);
  }
  return [...targets];
}

type Registry = Extract<ClassifiedSpec, { kind: "registry" }>;

function siblingSatisfies(spec: Registry, siblings: readonly ReleaseSibling[]): boolean {
  if (!spec.range) return false;
  const range = spec.range;
  return siblings.some((s) => s.name === spec.target && rangeSatisfiedBy(range, s.version));
}

function bestStagedCandidate(
  spec: Registry,
  candidates: readonly StagedDependencyCandidate[],
): StagedDependencyCandidate | null {
  if (!spec.range) return null;
  // A stage npm blocked or deleted (rejected, or removed) will never install,
  // so it is never offered as the fix; `published` stays, it already installs.
  const usable = candidates.filter(
    (c) =>
      c.packageName === spec.target &&
      c.registryVersionStatus !== "blocked" &&
      c.registryVersionStatus !== "deleted",
  );
  const version = maxSatisfyingVersion(
    usable.map((c) => c.version),
    spec.range,
  );
  return version ? (usable.find((c) => c.version === version) ?? null) : null;
}

function lookupSatisfies(spec: Registry, lookup: PackageVersionsLookup): boolean {
  if (lookup.status !== "found") return false;
  if (spec.tag) {
    const tagged = lookup.distTags[spec.tag];
    return Boolean(tagged && lookup.versions.includes(tagged));
  }
  if (!spec.range) return false;
  // npm-pick-manifest resolves the literal `*` (and `""`) to `latest` even when
  // it is a prerelease. Only the literal: `x`, `>=0.0.0`, or `* || 2.0.0-rc.1`
  // also match every stable version but never select a prerelease `latest`.
  const latest = lookup.distTags.latest;
  if (spec.latestWildcard && latest && lookup.versions.includes(latest)) return true;
  return maxSatisfyingVersion(lookup.versions, spec.range) !== null;
}

// Satisfied without asking the registry: by a package in the same gated
// release, or by a stage npm has since reported published (fresher than a
// cached packument).
function presatisfied(
  spec: Registry,
  siblings: readonly ReleaseSibling[],
  candidates: readonly StagedDependencyCandidate[],
): "release" | "published" | null {
  if (siblingSatisfies(spec, siblings)) return "release";
  return bestStagedCandidate(spec, candidates)?.registryVersionStatus === "published"
    ? "published"
    : null;
}

/**
 * Registry reads in priority order (changed specs, then dependencies,
 * optional, peers), skipping packages the release or a published stage
 * already satisfies.
 */
export function dependencyLookupQueue(
  plan: DependencyReadinessPlan,
  siblings: readonly ReleaseSibling[],
  candidates: readonly StagedDependencyCandidate[],
): string[] {
  const sectionOrder: Record<DependencyReadinessSection, number> = {
    dependencies: 0,
    optionalDependencies: 1,
    peerDependencies: 2,
  };
  const pending = plan.requirements
    .filter(
      (req): req is PlannedRequirement & { classified: Registry } =>
        !req.bundled &&
        req.classified.kind === "registry" &&
        presatisfied(req.classified, siblings, candidates) === null,
    )
    .sort(
      (a, b) =>
        Number(b.changed) - Number(a.changed) ||
        sectionOrder[a.section] - sectionOrder[b.section] ||
        a.name.localeCompare(b.name),
    );
  return [...new Set(pending.map((req) => req.classified.target))];
}

export interface DependencyLookupOptions {
  maxRegistryReads?: number;
  maxTargets?: number;
  concurrency?: number;
  budgetMs?: number;
  /** Queue position to start the registry reads from (the previous check's `nextOffset`). */
  offset?: number;
  now?: () => number;
}

/** Where the lookups come from: a cache that never reaches the registry, and a registry batch. */
export interface DependencyLookupSource {
  cached(name: string): Promise<PackageVersionsLookup | null>;
  /** A name missing from the result was not reached within `budgetMs`. */
  fetch(
    names: string[],
    options: { concurrency: number; budgetMs: number },
  ): Promise<Array<{ name: string; lookup: PackageVersionsLookup }>>;
}

export interface DependencyLookupResults {
  answers: Map<string, PackageVersionsLookup>;
  /** Targets past `MAX_CHECKED_TARGETS`, never read. */
  beyondLimit: Set<string>;
  /** Where the next check should resume, or null when every target was reached. */
  nextOffset: number | null;
}

/** A client-supplied resume position, clamped to something the queue can use. */
export function clampLookupOffset(value: unknown): number {
  const parsed = typeof value === "string" && /^\d{1,4}$/.test(value) ? Number(value) : 0;
  return parsed < MAX_CHECKED_TARGETS ? parsed : 0;
}

/**
 * Runs the lookups in two passes. The cache pass asks every target of the
 * cache and costs no registry request. The registry pass then spends the read
 * budget on targets with no answer, rotated to start at `offset`, and only
 * then re-reads cached negative answers (a packument that leaves some spec
 * unsatisfied, or "no such package"): a satisfying answer cannot go stale (npm
 * versions are immutable), but "not published yet" is exactly the answer that
 * changes minutes after a sibling stage is approved. A cached answer the budget
 * cannot re-read is still an answer (at most one cache TTL old).
 *
 * The rotation is what lets a release with more dependencies than one check's
 * budget finish: KV keeps a miss for up to a minute, so the previous check's
 * writes may still read as misses, and without the offset the next check would
 * spend its budget on exactly those again. Failed reads are not cached, and the
 * rotation moves past them too.
 */
export async function runDependencyLookups(
  plan: DependencyReadinessPlan,
  queue: readonly string[],
  source: DependencyLookupSource,
  options: DependencyLookupOptions = {},
): Promise<DependencyLookupResults> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? DEPENDENCY_LOOKUP_BUDGET_MS);
  const concurrency = options.concurrency ?? DEPENDENCY_LOOKUP_CONCURRENCY;
  const specsByTarget = new Map<string, Registry[]>();
  for (const req of plan.requirements) {
    if (req.bundled || req.classified.kind !== "registry") continue;
    const list = specsByTarget.get(req.classified.target) ?? [];
    list.push(req.classified);
    specsByTarget.set(req.classified.target, list);
  }
  const maxTargets = options.maxTargets ?? MAX_CHECKED_TARGETS;
  const targets = queue.slice(0, maxTargets);
  const beyondLimit = new Set(queue.slice(maxTargets));
  const answers = new Map<string, PackageVersionsLookup>();

  await mapWithConcurrency(
    targets,
    Math.max(concurrency, CACHE_LOOKUP_CONCURRENCY),
    async (name) => {
      if (now() > deadline) return;
      try {
        const cached = await source.cached(name);
        if (cached && cached.status !== "error") answers.set(name, cached);
      } catch {
        // A cache failure is a miss.
      }
    },
  );

  const start = targets.length ? (options.offset ?? 0) % targets.length : 0;
  const rotated = [...targets.slice(start), ...targets.slice(0, start)];
  const misses = rotated.filter((name) => !answers.has(name));
  const stale = rotated.filter((name) => {
    const answer = answers.get(name);
    if (answer?.status === "not-found") return true;
    return (
      answer?.status === "found" &&
      (specsByTarget.get(name) ?? []).some((spec) => !lookupSatisfies(spec, answer))
    );
  });
  const reads = [...misses, ...stale].slice(0, options.maxRegistryReads ?? MAX_REGISTRY_READS);
  const remaining = deadline - now();
  // A rejected batch (a crashed or dropped broker call) failed every read in
  // it: "could not check", never "not reached", or the next check would stall
  // on the same offset without a failure ever being reported.
  const fetched =
    reads.length && remaining > 0
      ? await source
          .fetch(reads, { concurrency, budgetMs: remaining })
          .catch(() => reads.map((name) => ({ name, lookup: { status: "error" } as const })))
      : [];
  for (const { name, lookup } of fetched) {
    // A failed re-read keeps the cached answer it was revalidating.
    if (lookup.status !== "error" || !answers.has(name)) answers.set(name, lookup);
  }

  // Resume after the furthest miss this check reached, in rotation order.
  const missed = new Set(misses);
  const reached = new Set(fetched.map(({ name }) => name));
  let lastReached = -1;
  rotated.forEach((name, index) => {
    if (reached.has(name) && missed.has(name)) lastReached = index;
  });
  const unanswered = targets.some((name) => !answers.has(name));
  const nextOffset = unanswered ? (start + lastReached + 1) % targets.length : null;
  return { answers, beyondLimit, nextOffset };
}

export function evaluateDependencyReadiness(input: {
  plan: DependencyReadinessPlan;
  siblings: readonly ReleaseSibling[];
  candidates: readonly StagedDependencyCandidate[];
  lookups: ReadonlyMap<string, PackageVersionsLookup>;
  beyondLimit?: ReadonlySet<string>;
  nextOffset?: number | null;
  credentialed: boolean;
}): DependencyReadinessReport {
  const issues: DependencyReadinessIssue[] = [];
  let notRegistry = 0;
  let satisfiedByRelease = 0;
  for (const req of input.plan.requirements) {
    if (req.bundled) continue;
    const base = { name: req.name, spec: req.spec, section: req.section };
    const spec = req.classified;
    if (spec.kind === "remote") {
      notRegistry += 1;
      continue;
    }
    if (spec.kind === "local") {
      issues.push({ ...base, kind: "local-spec" });
      continue;
    }
    if (spec.kind === "invalid") {
      issues.push({ ...base, kind: "unchecked", reason: "unsupported-spec" });
      continue;
    }
    const target = spec.target !== req.name ? { target: spec.target } : {};
    const pre = presatisfied(spec, input.siblings, input.candidates);
    if (pre === "release") satisfiedByRelease += 1;
    if (pre) continue;
    const lookup = input.lookups.get(spec.target);
    if (!lookup) {
      const reason = input.beyondLimit?.has(spec.target) ? "lookup-limit" : "lookup-skipped";
      issues.push({ ...base, ...target, kind: "unchecked", reason });
      continue;
    }
    if (lookup.status === "error" || lookup.status === "too-large") {
      const reason = lookup.status === "error" ? "lookup-failed" : "too-large";
      issues.push({ ...base, ...target, kind: "unchecked", reason });
      continue;
    }
    if (lookupSatisfies(spec, lookup)) continue;
    const staged = bestStagedCandidate(spec, input.candidates);
    if (staged) {
      issues.push({
        ...base,
        ...target,
        kind: "staged",
        staged: {
          scanId: staged.scanId,
          version: staged.version,
          decision: staged.decision,
          registryVersionStatus: staged.registryVersionStatus,
        },
      });
      continue;
    }
    issues.push({
      ...base,
      ...target,
      kind: "unpublished",
      packageFound: lookup.status === "found",
    });
  }
  return {
    status: "checked",
    declared: input.plan.requirements.length,
    notRegistry,
    satisfiedByRelease,
    credentialed: input.credentialed,
    issues,
    ...(typeof input.nextOffset === "number" &&
    issues.some((issue) => issue.reason === "lookup-skipped")
      ? { nextOffset: input.nextOffset }
      : {}),
  };
}
