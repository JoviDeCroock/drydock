export interface PackageJsonSummary {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  implicitScripts?: Record<string, string>;
  gypfile?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
  bundleDependencies?: string[] | boolean;
  bundledDependencies?: string[] | boolean;
  files?: string[];
  bin?: string | Record<string, string>;
  main?: string;
  module?: string;
  types?: string;
  browser?: string;
  exports?: unknown;
}

export type DependencySection = "dependencies" | "optionalDependencies" | "peerDependencies";

export interface PackageJsonDiffEntry {
  key: string;
  status: "added" | "removed" | "modified";
  previous?: string;
  staged?: string;
  section?: DependencySection;
  // Added rows carry prior cross-section membership when it would otherwise be
  // invisible from the changed rows alone. The dependency rules use this to
  // distinguish a new declaration from a duplicate of already-installed code.
  previouslyDeclared?: true;
  previouslyInstalled?: true;
  previousInstalledSpec?: string;
  previousRequiredPeerSpec?: string;
  previousDeclaredSpecs?: string[];
  previousPeerOptional?: true;
  stagedPeerOptional?: true;
}

export interface PackageJsonDiff {
  name: string | null;
  // Whether a baseline manifest was diffed against, independent of whether that
  // manifest declared a version. The dependency delta rules gate on this rather
  // than previousVersion so a prior release that shipped a version-less manifest
  // cannot switch off the next release's added/major-bump checks.
  hasPreviousManifest: boolean;
  previousVersion: string | null;
  stagedVersion: string | null;
  scripts: PackageJsonDiffEntry[];
  dependencies: PackageJsonDiffEntry[];
  // Per-command diff of the `bin` map: npm links each entry into the consumer's
  // node_modules/.bin, so a newly added command is an install-path behavior
  // change that release review should surface (see diff.bin-added).
  bin: PackageJsonDiffEntry[];
  entrypointsChanged: boolean;
}

export function summarizePackageJsonDiff(
  previousPkg: PackageJsonSummary | null | undefined,
  stagedPkg: PackageJsonSummary | null | undefined,
): PackageJsonDiff {
  const changedScripts = diffObject(previousPkg?.scripts || {}, stagedPkg?.scripts || {});
  const changedDependencies = diffDependencySections(previousPkg, stagedPkg);
  return {
    name: stagedPkg?.name || previousPkg?.name || null,
    hasPreviousManifest: Boolean(previousPkg),
    previousVersion: previousPkg?.version || null,
    stagedVersion: stagedPkg?.version || null,
    scripts: changedScripts,
    dependencies: changedDependencies,
    bin: diffObject(normalizeBin(previousPkg), normalizeBin(stagedPkg)),
    entrypointsChanged:
      JSON.stringify([
        previousPkg?.bin,
        previousPkg?.main,
        previousPkg?.module,
        previousPkg?.types,
        previousPkg?.browser,
        previousPkg?.exports,
      ]) !==
      JSON.stringify([
        stagedPkg?.bin,
        stagedPkg?.main,
        stagedPkg?.module,
        stagedPkg?.types,
        stagedPkg?.browser,
        stagedPkg?.exports,
      ]),
  };
}

function diffDependencySections(
  previousPkg: PackageJsonSummary | null | undefined,
  stagedPkg: PackageJsonSummary | null | undefined,
): PackageJsonDiffEntry[] {
  const sectionEntries = (section: DependencySection) => {
    const previous = previousPkg?.[section] || {};
    const staged = stagedPkg?.[section] || {};
    const entries = diffObject(previous, staged);
    if (section === "peerDependencies") {
      for (const key of Object.keys(staged)) {
        if (!(key in previous) || previous[key] !== staged[key]) continue;
        if (isOptionalPeer(previousPkg, key) === isOptionalPeer(stagedPkg, key)) continue;
        entries.push({
          key,
          status: "modified",
          previous: previous[key],
          staged: staged[key],
        });
      }
    }

    return entries.map((entry) => {
      const previouslyDeclared = DEPENDENCY_SECTIONS.some(
        (candidate) => entry.key in (previousPkg?.[candidate] || {}),
      );
      const previouslyInstalled =
        INSTALLING_DEPENDENCY_SECTIONS.some(
          (candidate) => entry.key in (previousPkg?.[candidate] || {}),
        ) ||
        (entry.key in (previousPkg?.peerDependencies || {}) &&
          !isOptionalPeer(previousPkg, entry.key));
      const previousRequiredPeerSpec =
        previousPkg?.peerDependencies?.[entry.key] !== undefined &&
        !isOptionalPeer(previousPkg, entry.key)
          ? previousPkg.peerDependencies[entry.key]
          : undefined;
      const previousInstalledSpec =
        section === "optionalDependencies"
          ? (previousPkg?.optionalDependencies?.[entry.key] ??
            previousPkg?.dependencies?.[entry.key])
          : section === "peerDependencies"
            ? (previousPkg?.optionalDependencies?.[entry.key] ??
              previousPkg?.dependencies?.[entry.key])
            : previousRequiredPeerSpec !== undefined
              ? (previousPkg?.optionalDependencies?.[entry.key] ??
                previousPkg?.dependencies?.[entry.key])
              : undefined;
      const previousDeclaredSpecs =
        entry.status === "added" && section === "peerDependencies"
          ? DEPENDENCY_SECTIONS.flatMap((candidate) => {
              const spec = previousPkg?.[candidate]?.[entry.key];
              return spec === undefined ? [] : [spec];
            })
          : [];
      const previousPeerOptional =
        section === "peerDependencies" && isOptionalPeer(previousPkg, entry.key);
      const stagedPeerOptional =
        section === "peerDependencies" && isOptionalPeer(stagedPkg, entry.key);
      return {
        ...entry,
        section,
        ...(entry.status === "added" && previouslyDeclared
          ? { previouslyDeclared: true as const }
          : {}),
        ...(entry.status === "added" && previouslyInstalled
          ? { previouslyInstalled: true as const }
          : {}),
        ...((entry.status === "added" ||
          (section === "peerDependencies" &&
            entry.status === "modified" &&
            previousPeerOptional &&
            !stagedPeerOptional)) &&
        previousInstalledSpec !== undefined
          ? { previousInstalledSpec }
          : {}),
        ...(entry.status === "added" && previousRequiredPeerSpec !== undefined
          ? { previousRequiredPeerSpec }
          : {}),
        ...(previousDeclaredSpecs.length ? { previousDeclaredSpecs } : {}),
        ...(previousPeerOptional ? { previousPeerOptional: true as const } : {}),
        ...(stagedPeerOptional ? { stagedPeerOptional: true as const } : {}),
      };
    });
  };

  return [
    ...sectionEntries("dependencies"),
    ...sectionEntries("optionalDependencies"),
    ...sectionEntries("peerDependencies"),
  ].sort((a, b) => a.key.localeCompare(b.key) || a.section.localeCompare(b.section));
}

// npm tolerates insignificant surrounding whitespace in dependency specs. Keep
// relocation checks conservative: only an unchanged declaration is considered
// already reviewed; a different range may resolve different package bytes.
export function dependencySpecsEqual(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left.trim() === right.trim();
}

export function dependencyWasInstalledAtStagedSpec(entry: PackageJsonDiffEntry): boolean {
  if (!entry.previouslyInstalled) return false;
  const previousSpecs = [entry.previousInstalledSpec, entry.previousRequiredPeerSpec].filter(
    (spec): spec is string => spec !== undefined,
  );
  // Preserve compatibility with older/manually-created diff payloads that
  // carry the boolean but predate spec provenance.
  return (
    previousSpecs.length === 0 ||
    previousSpecs.some((spec) => dependencySpecsEqual(spec, entry.staged))
  );
}

function isOptionalPeer(pkg: PackageJsonSummary | null | undefined, key: string): boolean {
  return pkg?.peerDependenciesMeta?.[key]?.optional === true;
}

const DEPENDENCY_SECTIONS: DependencySection[] = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];
const INSTALLING_DEPENDENCY_SECTIONS: DependencySection[] = [
  "dependencies",
  "optionalDependencies",
];

// Normalize the two npm `bin` shapes to a command -> target map. A string `bin`
// installs one command named after the package (the unscoped part for scoped
// names), matching how npm derives the command. Non-string targets are dropped
// so a malformed manifest cannot crash the diff.
function normalizeBin(pkg: PackageJsonSummary | null | undefined): Record<string, string> {
  const bin = pkg?.bin;
  if (!bin) return {};
  if (typeof bin === "string") {
    const command = unscopedName(pkg?.name) ?? "(package)";
    return { [command]: bin };
  }
  const out: Record<string, string> = {};
  for (const [command, target] of Object.entries(bin)) {
    if (typeof target === "string") out[command] = target;
  }
  return out;
}

function unscopedName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const slash = name.lastIndexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

function diffObject(
  before: Record<string, string>,
  after: Record<string, string>,
): PackageJsonDiffEntry[] {
  const out: PackageJsonDiffEntry[] = [];
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (!(key in before)) out.push({ key, status: "added", staged: after[key] });
    else if (!(key in after)) out.push({ key, status: "removed", previous: before[key] });
    else if (before[key] !== after[key])
      out.push({ key, status: "modified", previous: before[key], staged: after[key] });
  }
  return out;
}
