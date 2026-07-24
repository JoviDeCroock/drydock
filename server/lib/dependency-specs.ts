// Dependency-spec parsing shared by the deterministic dependency rules
// (server/lib/review-rules/deps.ts) and the dependency diff links in the UI
// (src/lib/package-diff-path.ts). One grammar in one place, so a
// dependency.major-bump finding and the "view diff" link rendered for the same
// manifest row derive from the same parser.

export function unusualDependencySpecKind(spec: string): string | null {
  const normalized = spec.trim().toLowerCase();
  if (/^(?:github|gitlab|bitbucket):/.test(normalized)) return "git-hosted";
  if (/^(?:git\+ssh|git\+https|git\+http|git|ssh):/.test(normalized)) return "git";
  if (/^https?:/.test(normalized))
    return normalized.endsWith(".tgz") ? "remote tarball" : "remote URL";
  if (normalized.startsWith("file:")) return "local file";
  if (normalized.startsWith("npm:")) return "npm alias";
  // Monorepo-local protocols must be replaced with a concrete registry range at
  // publish time; their presence in a published tarball is a broken or
  // hand-crafted publish, and the bare name does not resolve on the registry.
  if (/^(?:workspace|catalog|link|portal):/.test(normalized)) return "workspace-protocol";
  return null;
}

// The major-version intervals consumers can resolve from a plain registry spec.
// Each `||` branch remains a separate interval so `^1 || ^3` does not imply that
// 2.x was reviewed. Bounded comparator sets retain their upper major too:
// `>=1 <3` admits 1.x and 2.x. Unparseable or unanchored branches (dist-tags,
// `*`, git/URL specs) are skipped within a union so a no-op `|| ` suffix cannot
// suppress comparison of the parseable branches.
export interface MajorRange {
  min: number;
  max: number;
}

export function specMajorRanges(spec: string | undefined): MajorRange[] | undefined {
  if (!spec || unusualDependencySpecKind(spec)) return undefined;
  const ranges: MajorRange[] = [];
  for (const branch of spec.split("||")) {
    const range = branchMajorRange(branch.trim());
    if (range) ranges.push(range);
  }
  return ranges.length ? ranges : undefined;
}

export function majorRangesAreSubset(staged: MajorRange[], previous: MajorRange[]): boolean {
  const mergedPrevious = mergeMajorRanges(previous);
  return staged.every((candidate) =>
    mergedPrevious.some(
      (reviewed) => candidate.min >= reviewed.min && candidate.max <= reviewed.max,
    ),
  );
}

function branchMajorRange(branch: string): MajorRange | null {
  const hyphen = branch.split(/\s+-\s+/);
  if (hyphen.length === 2) {
    const low = branchFloor(hyphen[0]);
    const high = branchFloor(hyphen[1]);
    return low && high ? { min: low.min, max: high.min } : null;
  }

  const floor = branchFloor(branch);
  if (!floor) return null;
  const min = floor.min;
  let max = floor.max;
  for (const upper of branch.matchAll(/<(=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/gi)) {
    const major = Number.parseInt(upper[2], 10);
    const minor = numericPart(upper[3]);
    const patch = numericPart(upper[4]);
    const boundaryIsNextMajor = minor === 0 && patch === 0;
    const admittedMax = upper[1] || !boundaryIsNextMajor ? major : major - 1;
    max = Math.min(max, admittedMax);
  }
  return max >= min ? { min, max } : null;
}

function mergeMajorRanges(ranges: MajorRange[]): MajorRange[] {
  const sorted = [...ranges].sort((a, b) => a.min - b.min || a.max - b.max);
  const merged: MajorRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || range.min > previous.max + 1) {
      merged.push({ ...range });
    } else {
      previous.max = Math.max(previous.max, range.max);
    }
  }
  return merged;
}

// A direct public-diff URL needs registry version keys, not semver bounds. Only
// exact specs prove those keys; `^1.2.0` does not prove that 1.2.0 was ever
// published. Preserve prerelease/build suffixes because they are part of the
// registry version identifier even though build metadata has no precedence.
export function exactDependencyVersion(spec: string | undefined): string | null {
  if (!spec || unusualDependencySpecKind(spec)) return null;
  const match = spec
    .trim()
    .match(
      /^(?:=\s*)?v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
    );
  if (!match) return null;
  const [, major, minor, patch, prerelease, build] = match;
  if ([major, minor, patch].some((part) => part.length > 1 && part.startsWith("0"))) return null;
  if (
    prerelease
      ?.split(".")
      .some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))
  ) {
    return null;
  }
  return `${major}.${minor}.${patch}${prerelease ? `-${prerelease}` : ""}${build ? `+${build}` : ""}`;
}

interface BranchFloor {
  min: number;
  max: number;
}

function branchFloor(branch: string): BranchFloor | null {
  let found = false;
  let min = 0;
  let max = Infinity;
  for (const match of branch.matchAll(
    /(?:^|\s)([~^=]|>=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?([-+][0-9A-Za-z.+-]+)?(?=$|\s)/g,
  )) {
    found = true;
    const [, operator, major] = match;
    const candidate = Number.parseInt(major, 10);
    min = Math.max(min, candidate);
    if (operator !== ">=") max = Math.min(max, candidate);
  }
  return found ? { min, max } : null;
}

function numericPart(value: string | undefined): number {
  return value && /^\d+$/.test(value) ? Number.parseInt(value, 10) : 0;
}
