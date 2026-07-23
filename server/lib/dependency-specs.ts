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

// The span of major versions consumers can actually resolve from a plain
// registry spec. npm installs the HIGHEST published version the range admits,
// so widening `^1.0.0` to `^1.0.0 || ^2.0.0`, `1.0.0 - 2.0.0`, or `>=1.0.0`
// ships 2.x even though the floor is still 1.x — and a downgrade like `^2.0.0`
// to `^1.0.0` admits a major the prior range never did. Both directions escape
// the previously reviewed span, which is why the major-bump rule compares
// spans instead of single majors: a pure narrowing (`>=1.0.0` to `^1.0.0`)
// stays inside the reviewed span and must not fire. Unparseable or unanchored
// branches (dist-tags, `*`, git/URL specs) yield undefined — the resolvable
// major cannot be known without the registry — and are skipped within a union
// so a no-op `|| ` suffix cannot suppress the comparison.
export interface MajorRange {
  min: number;
  // Infinity for a bare ">=" comparator with no upper bound: it admits every
  // future major.
  max: number;
}

export function specMajorRange(spec: string | undefined): MajorRange | undefined {
  if (!spec || unusualDependencySpecKind(spec)) return undefined;
  let range: MajorRange | undefined;
  for (const branch of spec.split("||")) {
    const trimmed = branch.trim();
    const parsed = branchFloor(trimmed);
    if (!parsed) continue;
    const min = parsed.parts[0];
    const max = branchMaxMajor(trimmed) ?? min;
    range = range ? { min: Math.min(range.min, min), max: Math.max(range.max, max) } : { min, max };
  }
  return range;
}

// The highest major a single range branch admits. A hyphen range follows its
// high endpoint ("1.0.0 - 2.3.4" admits 2.x), and a bare ">=" comparator with
// no upper bound admits every future major (Infinity) — in both forms npm can
// install above the floor's major, so the floor alone would under-report what
// consumers can pull. An upper-bound comparator ("<2.0.0") keeps the floor's
// major: resolving its exact admitted major needs more range algebra than a
// deterministic manifest rule should carry, and the floor is the conservative
// under-approximation.
function branchMaxMajor(branch: string): number | undefined {
  const hyphen = branch.split(/\s+-\s+/);
  if (hyphen.length === 2) return branchFloor(hyphen[1])?.parts[0];
  if (!branchFloor(branch)) return undefined;
  if (branch.startsWith(">=") && !branch.includes("<")) return Infinity;
  return undefined;
}

// The lowest concrete version a plain registry spec can resolve to, for
// building a concrete diff link: "^9.1.3" → "9.1.3", "~1.2" → "1.2.0",
// ">=1.0.0 <2" → "1.0.0". A `||` union floors at the minimum across branches.
// Returns null when the spec is unusual (git/URL/alias/workspace) or any branch
// has no leading version anchor (`latest`, `*`, bare `>` ranges) — there is no
// concrete published version to link, and guessing would fabricate a pair that
// was never in the range.
export function specFloorVersion(spec: string | undefined): string | null {
  if (!spec || unusualDependencySpecKind(spec)) return null;
  let floor: BranchFloor | null = null;
  for (const branch of spec.split("||")) {
    const trimmed = branch.trim();
    if (!trimmed) continue;
    const parsed = branchFloor(trimmed);
    if (!parsed) return null;
    if (!floor || compareBranchFloors(parsed, floor) < 0) floor = parsed;
  }
  return floor ? floor.text : null;
}

interface BranchFloor {
  parts: [number, number, number];
  prerelease: string;
  text: string;
}

function branchFloor(branch: string): BranchFloor | null {
  const match = branch.match(
    /^(?:[~^=]|>=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?([-+][0-9A-Za-z.+-]+)?(?=$|\s)/,
  );
  if (!match) return null;
  const [, major, minor, patch, suffix] = match;
  const part = (value: string | undefined) =>
    value && /^\d+$/.test(value) ? Number.parseInt(value, 10) : 0;
  // Build metadata ("+build") has no version precedence and is not part of the
  // published version identifier; only a leading "-" prerelease is kept.
  const prerelease = suffix?.startsWith("-") ? suffix.split("+")[0] : "";
  const parts: [number, number, number] = [Number.parseInt(major, 10), part(minor), part(patch)];
  // Text is built from the parsed integers so leading zeros ("01.0.0") cannot
  // reach a diff link as a version segment that no registry ever published.
  return { parts, prerelease, text: `${parts[0]}.${parts[1]}.${parts[2]}${prerelease}` };
}

function compareBranchFloors(a: BranchFloor, b: BranchFloor): number {
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] - b.parts[index];
  }
  // Same x.y.z: a prerelease floor precedes the release itself, and the lower
  // prerelease identifier wins so the union's true minimum is kept.
  if (Boolean(a.prerelease) !== Boolean(b.prerelease)) return a.prerelease ? -1 : 1;
  if (a.prerelease !== b.prerelease) return a.prerelease < b.prerelease ? -1 : 1;
  return 0;
}
