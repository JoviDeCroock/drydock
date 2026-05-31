export interface PackageJsonSummary {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  implicitScripts?: Record<string, string>;
  gypfile?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  files?: string[];
  bin?: string | Record<string, string>;
  main?: string;
  module?: string;
  types?: string;
  exports?: unknown;
}

export type DependencySection = "dependencies" | "optionalDependencies" | "peerDependencies";

export interface PackageJsonDiffEntry {
  key: string;
  status: "added" | "removed" | "modified";
  previous?: string;
  staged?: string;
  section?: DependencySection;
}

export interface PackageJsonDiff {
  name: string | null;
  previousVersion: string | null;
  stagedVersion: string | null;
  scripts: PackageJsonDiffEntry[];
  dependencies: PackageJsonDiffEntry[];
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
    previousVersion: previousPkg?.version || null,
    stagedVersion: stagedPkg?.version || null,
    scripts: changedScripts,
    dependencies: changedDependencies,
    entrypointsChanged:
      JSON.stringify([
        previousPkg?.bin,
        previousPkg?.main,
        previousPkg?.module,
        previousPkg?.types,
        previousPkg?.exports,
      ]) !==
      JSON.stringify([
        stagedPkg?.bin,
        stagedPkg?.main,
        stagedPkg?.module,
        stagedPkg?.types,
        stagedPkg?.exports,
      ]),
  };
}

function diffDependencySections(
  previousPkg: PackageJsonSummary | null | undefined,
  stagedPkg: PackageJsonSummary | null | undefined,
): PackageJsonDiffEntry[] {
  const sectionEntries = (section: DependencySection) =>
    diffObject(previousPkg?.[section] || {}, stagedPkg?.[section] || {}).map((entry) => ({
      ...entry,
      section,
    }));

  return [
    ...sectionEntries("dependencies"),
    ...sectionEntries("optionalDependencies"),
    ...sectionEntries("peerDependencies"),
  ].sort((a, b) => a.key.localeCompare(b.key) || a.section.localeCompare(b.section));
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
