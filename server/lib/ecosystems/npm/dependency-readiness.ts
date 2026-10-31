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
 * are bounded by `MAX_DEPENDENCY_LOOKUPS`, and are rendered as text.
 */
import { mapWithConcurrency } from "../../platform/concurrency";
import { isRecord } from "../../platform/guards";
import { unusualDependencySpecKind } from "../../review/dependency-specs";
import type { PackageJsonSummary } from "../../review/serialize";
import {
  maxSatisfyingVersion,
  parseSemverRange,
  rangeSatisfiedBy,
  type SemverRange,
} from "../semver-range";
import { isValidLegacyNpmPackageName } from "./registry";

// Bounded per request: a manifest declaring hundreds of dependencies cannot
// turn one page load into hundreds of registry reads. Changed specs are looked
// up first, so a truncated check still covers what this release changed.
const MAX_DEPENDENCY_LOOKUPS = 40;
const DEPENDENCY_LOOKUP_CONCURRENCY = 6;
// Lookups still unstarted when the budget runs out are reported unchecked, so
// a slow registry costs the reader seconds, not the Worker's request lifetime.
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
  | { kind: "registry"; target: string; range: SemverRange | null; tag: string | null }
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
  | {
      status: "found";
      versions: string[];
      distTags: Record<string, string>;
      /** False when this answer was just read from the registry, so re-reading is pointless. */
      fromCache?: boolean;
    }
  | { status: "not-found" }
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

type DependencyUncheckedReason = "lookup-failed" | "lookup-skipped" | "unsupported-spec";

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
  const range = parseSemverRange(trimmed);
  if (range) return { kind: "registry", target, range, tag: null };
  // npm reads any other URL-safe spec as a dist-tag (`latest`, `next`).
  if (/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(trimmed)) {
    return { kind: "registry", target, range: null, tag: trimmed };
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

/** Top-level `node_modules/<name>/package.json` entries: dependencies the tarball bundles. */
export function bundledDependencyNames(paths: Iterable<string>): Set<string> {
  const names = new Set<string>();
  for (const path of paths) {
    const match = /^node_modules\/((?:@[^/]+\/)?[^/@][^/]*)\/package\.json$/.exec(path);
    if (match) names.add(match[1]);
  }
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

  return {
    requirements: entries.slice(0, MAX_DECLARED_DEPENDENCIES).map(([section, name, spec]) => ({
      name,
      spec,
      section,
      changed: changed.has(changedKey(section, name)),
      bundled: options.bundled?.has(name) ?? false,
      classified: classifyDependencySpec(name, spec),
    })),
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
  // npm-pick-manifest resolves `*` and `""` to `latest` even when it is a prerelease.
  if (spec.range.sets.length === 1 && spec.range.sets[0].length === 0 && lookup.distTags.latest) {
    return true;
  }
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
  maxLookups?: number;
  concurrency?: number;
  budgetMs?: number;
  now?: () => number;
}

/**
 * Runs the lookups. A cached packument that does not satisfy some spec is read
 * once more with `fresh: true`: a satisfying answer cannot go stale (npm
 * versions are immutable), but "not published yet" is exactly the answer that
 * changes minutes after a sibling stage is approved.
 */
export async function runDependencyLookups(
  plan: DependencyReadinessPlan,
  queue: readonly string[],
  lookup: (name: string, options: { fresh: boolean }) => Promise<PackageVersionsLookup>,
  options: DependencyLookupOptions = {},
): Promise<Map<string, PackageVersionsLookup>> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? DEPENDENCY_LOOKUP_BUDGET_MS);
  const specsByTarget = new Map<string, Registry[]>();
  for (const req of plan.requirements) {
    if (req.classified.kind !== "registry") continue;
    const list = specsByTarget.get(req.classified.target) ?? [];
    list.push(req.classified);
    specsByTarget.set(req.classified.target, list);
  }
  const safeLookup = async (name: string, fresh: boolean): Promise<PackageVersionsLookup> => {
    try {
      return await lookup(name, { fresh });
    } catch {
      return { status: "error" };
    }
  };
  const results = new Map<string, PackageVersionsLookup>();
  const capped = queue.slice(0, options.maxLookups ?? MAX_DEPENDENCY_LOOKUPS);
  await mapWithConcurrency(
    capped,
    options.concurrency ?? DEPENDENCY_LOOKUP_CONCURRENCY,
    async (name) => {
      if (now() > deadline) return;
      let result = await safeLookup(name, false);
      const specs = specsByTarget.get(name) ?? [];
      if (
        result.status === "found" &&
        result.fromCache !== false &&
        specs.some((spec) => !lookupSatisfies(spec, result))
      ) {
        if (now() <= deadline) {
          const fresh = await safeLookup(name, true);
          if (fresh.status === "found") result = fresh;
        }
      }
      results.set(name, result);
    },
  );
  return results;
}

export function evaluateDependencyReadiness(input: {
  plan: DependencyReadinessPlan;
  siblings: readonly ReleaseSibling[];
  candidates: readonly StagedDependencyCandidate[];
  lookups: ReadonlyMap<string, PackageVersionsLookup>;
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
      issues.push({ ...base, ...target, kind: "unchecked", reason: "lookup-skipped" });
      continue;
    }
    if (lookup.status === "error") {
      issues.push({ ...base, ...target, kind: "unchecked", reason: "lookup-failed" });
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
  };
}
