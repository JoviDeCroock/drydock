import type { Finding, PackageJsonDiff } from "../review";
import type { DependencySection, PackageJsonDiffEntry } from "../review-serialize";
import {
  majorRangesAreSubset,
  specMajorRanges,
  unusualDependencySpecKind,
} from "../dependency-specs";
import { firstJsonPropertyLine, tag } from "./helpers";

// Dependency-change rules derived from the package.json diff: newly added
// optional dependencies, specs that resolve code outside normal semver ranges,
// newly added runtime/peer dependencies, and specs whose resolvable major
// version changed. Composed by ecosystem adapters rather than the file-scanning
// pass, so these are exposed through the index as `packageJsonDiffFindings`.
//
// Findings are resolved one-per-key by precedence so a dependency listed in
// several manifest sections (the common `dependencies` + `peerDependencies`
// pattern) cannot double-flag, and so a move between sections is not mistaken
// for newly shipped code.
export function dependencyDiffFindings(
  packageJsonDiff: PackageJsonDiff,
  stagedPackageJsonText?: string | null,
): Finding[] {
  // The delta rules (added / major-bump) need a baseline manifest to be a
  // delta at all: a first-ever publish (or a degraded baseline fetch) diffs
  // every dependency as added, and flagging the whole list would floor every
  // first release at medium risk. Gate on baseline-manifest presence rather
  // than its version string so a prior release that shipped a version-less
  // manifest cannot switch the next release's checks off. optional-added and
  // unusual-spec still fire without a baseline — they describe the staged
  // manifest itself, not the delta.
  const hasBaseline = packageJsonDiff.hasPreviousManifest;

  // Specs removed from an installing section (dependencies / optionalDependencies)
  // in this release. A key that was installed before and reappears in another
  // installing section is a relocation of already-shipped code, not a new
  // dependency. peerDependencies are excluded: the package does not install
  // them, so peer→dependencies genuinely starts shipping code.
  const removedInstalling = new Map<string, string[]>();
  const byKey = new Map<string, PackageJsonDiffEntry[]>();
  for (const entry of packageJsonDiff.dependencies) {
    if (entry.status === "removed") {
      if (isInstallingSection(entry.section)) {
        const specs = removedInstalling.get(entry.key) ?? [];
        specs.push(entry.previous ?? "");
        removedInstalling.set(entry.key, specs);
      }
      continue;
    }
    if (entry.status !== "added" && entry.status !== "modified") continue;
    const entries = byKey.get(entry.key) ?? [];
    entries.push(entry);
    byKey.set(entry.key, entries);
  }

  const findings: Finding[] = [];
  for (const key of [...byKey.keys()].sort()) {
    const finding = keyFinding(
      key,
      byKey.get(key)!,
      removedInstalling.get(key),
      hasBaseline,
      stagedPackageJsonText,
    );
    if (finding) findings.push(finding);
  }
  return findings;
}

function isInstallingSection(section: DependencySection | undefined): boolean {
  return section === "dependencies" || section === "optionalDependencies";
}

// At most one finding per dependency key, chosen by precedence:
//   unusual-spec (high) > optional-added (high) > added (medium) > major-bump (low)
function keyFinding(
  key: string,
  entries: PackageJsonDiffEntry[],
  removedInstallingSpecs: string[] | undefined,
  hasBaseline: boolean,
  stagedPackageJsonText?: string | null,
): Finding | null {
  const sorted = [...entries].sort((a, b) => sectionRank(a.section) - sectionRank(b.section));

  // An unusual spec in ANY changed section wins outright. npm 7+ installs peer
  // dependencies too, so a git/URL spec added under peerDependencies must not
  // hide behind a benign spec in a lower-ranked section and downgrade to the
  // medium added finding.
  for (const entry of sorted) {
    if (entry.staged === undefined) continue;
    const kind = unusualDependencySpecKind(entry.staged);
    if (!kind) continue;
    return tag("dependencyUnusualSpec", {
      severity: "high",
      file: "package.json",
      line: firstJsonPropertyLine(stagedPackageJsonText, key, entry.staged),
      evidence: `${key}: ${entry.staged}`,
      reason: `${kind} dependency specs resolve code outside normal npm semver ranges and can introduce unreviewed install-time behavior`,
    });
  }

  // Representative staged spec for the remaining rules: the entry in the
  // lowest-ordered section (dependencies < optionalDependencies <
  // peerDependencies). A key normally carries the same spec in every section
  // it appears in.
  const stagedSpec = sorted[0].staged;
  // undefined means the diff carries no staged spec at all; "" is a real spec
  // (npm treats it like "*") and keeps flowing through the rules below.
  if (stagedSpec === undefined) return null;

  const line = firstJsonPropertyLine(stagedPackageJsonText, key, stagedSpec);

  const addedEntries = entries.filter((entry) => entry.status === "added");
  const addedSections = addedEntries.map((entry) => entry.section);
  const addsInstallingSection = addedSections.some(isInstallingSection);
  const wasPreviouslyInstalled = addedEntries.some((entry) => entry.previouslyInstalled);
  const wasPreviouslyDeclared = addedEntries.some((entry) => entry.previouslyDeclared);
  // Legacy/manually-created diffs may not carry the cross-section flags, so
  // preserve the removed-row relocation fallback for those payloads.
  const relocation = (removedInstallingSpecs?.length ?? 0) > 0;
  const installsNewCode = addsInstallingSection && !wasPreviouslyInstalled && !relocation;
  const addsNewPeerRequirement =
    addedEntries.some(
      (entry) => entry.section === "peerDependencies" && !entry.stagedPeerOptional,
    ) &&
    !wasPreviouslyDeclared &&
    !relocation;

  if (installsNewCode && addedSections.includes("optionalDependencies")) {
    return tag("dependencyOptionalAdded", {
      severity: "high",
      file: "package.json",
      line,
      evidence: `${key}: ${stagedSpec}`,
      reason:
        "optional dependencies can execute install lifecycle hooks while failing softly on unsupported platforms, so newly added optional dependencies require manual review",
    });
  }

  if ((installsNewCode || addsNewPeerRequirement) && hasBaseline) {
    // dependencies installs into every consumer; a peer requirement is instead
    // something the consumer must supply, so the framing differs.
    return tag("dependencyAdded", {
      severity: "medium",
      file: "package.json",
      line,
      evidence: `${key}: ${stagedSpec}`,
      reason: installsNewCode
        ? "a newly added dependency ships third-party code this scan does not inspect into every consumer install — the event-stream/flatmap-stream and node-ipc/peacenotwar vector — so review the new dependency's own contents before approving"
        : "a newly added peer dependency requires every consumer to install this third-party package, which this scan does not inspect — review the dependency's own contents before approving",
    });
  }

  // Modified in place, or relocated with a changed spec: compare the intervals
  // of majors each spec admits, and fire when a staged spec admits a major
  // outside the previously reviewed intervals — higher (widening), lower
  // (downgrade). A pure narrowing stays inside what the prior release was
  // reviewed against and raises nothing. Each modified row compares its own
  // staged spec against its own previous spec, so a major change confined to a
  // higher-ranked section (the peer row of a dependencies + peerDependencies
  // pairing) cannot hide behind an unchanged-major lower-ranked one. A
  // relocated key compares the representative staged spec against every spec
  // removed from an installing section, so an unchanged duplicate cannot mask
  // a real major change.
  //
  if (!hasBaseline) return null;
  const modifiedEntries = entries.filter((e) => e.status === "modified");
  const directPairs = [
    ...modifiedEntries.map((entry) => ({ previous: entry.previous, staged: entry.staged })),
    ...addedEntries
      .filter(
        (entry) =>
          entry.section === "optionalDependencies" && entry.previousInstalledSpec !== undefined,
      )
      .map((entry) => ({
        previous: entry.previousInstalledSpec,
        staged: entry.staged,
      })),
  ];
  const pairs = directPairs.length
    ? directPairs
    : (removedInstallingSpecs ?? []).map((previous) => ({ previous, staged: stagedSpec }));
  for (const pair of pairs) {
    const stagedRanges = specMajorRanges(pair.staged);
    const previousRanges = specMajorRanges(pair.previous ?? undefined);
    if (stagedRanges === undefined || previousRanges === undefined) continue;
    if (majorRangesAreSubset(stagedRanges, previousRanges)) continue;
    return tag("dependencyMajorBump", {
      severity: "low",
      file: "package.json",
      line: firstJsonPropertyLine(stagedPackageJsonText, key, pair.staged),
      evidence: `${key}: ${pair.previous} -> ${pair.staged}`,
      reason:
        "the dependency spec now resolves to a different major version than the previously reviewed release admitted, so consumers can pull code outside the range the prior version was reviewed against; review the dependency's own release diff",
    });
  }
  return null;
}

const SECTION_RANK: Record<DependencySection, number> = {
  dependencies: 0,
  optionalDependencies: 1,
  peerDependencies: 2,
};

function sectionRank(section: DependencySection | undefined): number {
  return section ? SECTION_RANK[section] : 0;
}
