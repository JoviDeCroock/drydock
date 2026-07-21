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

// The major version consumers can actually resolve from a plain registry spec.
// npm installs the HIGHEST published version the range admits, so the signal
// for "consumers can now pull a newer major" is the maximum major across the
// spec's `||` branches, not the minimum floor: widening `^1.0.0` to
// `^1.0.0 || ^2.0.0` ships 2.x even though the floor is still 1.x. Unparseable
// or unanchored branches (dist-tags, `*`, git/URL specs) yield undefined — the
// resolvable major cannot be known without the registry — and are skipped
// within a union so a no-op `|| ` suffix cannot suppress the comparison.
export function specMaxMajor(spec: string | undefined): number | undefined {
  if (!spec || unusualDependencySpecKind(spec)) return undefined;
  let max: number | undefined;
  for (const branch of spec.split("||")) {
    const parsed = branchFloor(branch.trim());
    if (!parsed) continue;
    max = max === undefined ? parsed.parts[0] : Math.max(max, parsed.parts[0]);
  }
  return max;
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
