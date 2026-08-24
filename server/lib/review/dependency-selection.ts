import type { FileRecord, PackageJsonSummary } from "./";
import { unusualDependencySpecKind } from "./dependency-specs";
import {
  dependencySpecsEqual,
  dependencyWasInstalledAtStagedSpec,
  type DependencySection,
  type PackageJsonDiff,
  type PackageJsonDiffEntry,
} from "./serialize";

export type DependencyDeclarationKind = "exact" | "range" | "tag" | "unusual";

export interface AddedDependency {
  name: string;
  section: DependencySection;
  spec: string;
  declarationKind: DependencyDeclarationKind;
}

export interface DependencySelectionOptions {
  /** A missing manifest is an acquisition gap rather than a true first release. */
  includeWithoutBaseline?: boolean;
  /** Needed to distinguish registry dependencies from bytes bundled in the parent tarball. */
  stagedManifest?: PackageJsonSummary | null;
  stagedFiles?: FileRecord[];
}

/** Newly introduced dependencies whose bytes must be acquired from a registry. */
export function selectAddedDependencies(
  manifestDiff: PackageJsonDiff,
  options: DependencySelectionOptions = {},
): AddedDependency[] {
  return selectIntroducedDependencies(manifestDiff, options).filter(
    (dependency) => !isBundledInStagedArtifact(dependency, options),
  );
}

/** Newly introduced dependencies whose exact bytes are embedded in the parent artifact. */
export function selectBundledAddedDependencies(
  manifestDiff: PackageJsonDiff,
  options: DependencySelectionOptions = {},
): AddedDependency[] {
  return selectIntroducedDependencies(manifestDiff, options).filter((dependency) =>
    isBundledInStagedArtifact(dependency, options),
  );
}

function selectIntroducedDependencies(
  manifestDiff: PackageJsonDiff,
  options: DependencySelectionOptions,
): AddedDependency[] {
  if (!manifestDiff.hasPreviousManifest && !options.includeWithoutBaseline) return [];

  const relocated = new Map<string, string[]>();
  for (const entry of manifestDiff.dependencies) {
    if (entry.status !== "removed" || !isInstallingSection(entry.section)) continue;
    const specs = relocated.get(entry.key) ?? [];
    if (entry.previous !== undefined) specs.push(entry.previous);
    relocated.set(entry.key, specs);
  }

  const byName = new Map<string, AddedDependency>();
  for (const entry of manifestDiff.dependencies) {
    if (entry.staged === undefined || !introducesInstalledCode(entry, relocated)) continue;
    const candidate: AddedDependency = {
      name: entry.key,
      section: entry.section ?? "dependencies",
      spec: entry.staged,
      declarationKind: dependencyDeclarationKind(entry.staged),
    };
    const existing = byName.get(entry.key);
    if (!existing || sectionRank(candidate.section) < sectionRank(existing.section)) {
      byName.set(entry.key, candidate);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function isBundledInStagedArtifact(
  entry: Pick<AddedDependency, "name" | "section">,
  options: DependencySelectionOptions,
): boolean {
  if (!isInstallingSection(entry.section)) return false;
  const manifest = options.stagedManifest;
  const declarations = [manifest?.bundleDependencies, manifest?.bundledDependencies];
  const declared = declarations.some(
    (value) => value === true || (Array.isArray(value) && value.includes(entry.name)),
  );
  if (!declared) return false;

  const packageJsonPath = `node_modules/${entry.name}/package.json`;
  const packageJson = (options.stagedFiles ?? []).find((file) => file.path === packageJsonPath);
  // The child manifest's presence proves which bytes consumers receive, even
  // when its body is unreadable or its claimed identity is invalid. The
  // bundled inspector validates that identity and reports a visible coverage
  // gap; routing this declaration to the registry would review different bytes.
  return Boolean(packageJson);
}

function introducesInstalledCode(
  entry: PackageJsonDiffEntry,
  relocated: Map<string, string[]>,
): boolean {
  if (
    entry.section === "peerDependencies" &&
    entry.status === "modified" &&
    entry.previousPeerOptional &&
    !entry.stagedPeerOptional
  ) {
    return !dependencySpecsEqual(entry.previousInstalledSpec, entry.staged);
  }
  if (entry.status !== "added") return false;
  const relocatedSpecs = relocated.get(entry.key);
  const wasInstalledAtStagedSpec = relocatedSpecs?.length
    ? relocatedSpecs.some((spec) => dependencySpecsEqual(spec, entry.staged))
    : dependencyWasInstalledAtStagedSpec(entry);
  if (wasInstalledAtStagedSpec) return false;
  if (isInstallingSection(entry.section)) return true;
  return entry.section === "peerDependencies" && !entry.stagedPeerOptional;
}

function isInstallingSection(section: DependencySection | undefined): boolean {
  return section === "dependencies" || section === "optionalDependencies";
}

const INSTALLING_SECTIONS: DependencySection[] = ["optionalDependencies", "dependencies"];

function sectionRank(section: DependencySection): number {
  const rank = INSTALLING_SECTIONS.indexOf(section);
  return rank === -1 ? 2 : rank;
}

/** Classify npm declarations before consulting registry-controlled dist-tags. */
export function dependencyDeclarationKind(spec: string): DependencyDeclarationKind {
  const trimmed = spec.trim();
  if (unusualDependencySpecKind(trimmed)) return "unusual";
  if (/^(?:=\s*)?v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed)) return "exact";
  // npm's range grammar accepts v-prefixed partials (`v1`, `v1.2`, `v1.x`).
  // They must reach the bounded range resolver before a registry-controlled
  // dist-tag with the same spelling gets a chance to redirect the review.
  if (/^v\d+(?:\.(?:\d+|x|X|\*)){0,2}$/.test(trimmed)) return "range";
  if (trimmed !== "x" && trimmed !== "X" && /^[A-Za-z][\w.-]*$/.test(trimmed)) return "tag";
  return "range";
}
