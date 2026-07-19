// Dependency-spec parsing shared by the deterministic dependency rules
// (server/lib/review-rules/deps.ts) and the dependency diff links in the UI
// (src/lib/package-diff-path.ts). One grammar in one place, so a
// dependency.major-bump finding and the "view diff" link rendered for the same
// manifest row can never disagree about what a spec resolves to.

export function unusualDependencySpecKind(spec: string): string | null {
  const normalized = spec.trim().toLowerCase();
  if (/^(?:github|gitlab|bitbucket):/.test(normalized)) return "git-hosted";
  if (/^(?:git\+ssh|git\+https|git\+http|git|ssh):/.test(normalized)) return "git";
  if (/^https?:/.test(normalized))
    return normalized.endsWith(".tgz") ? "remote tarball" : "remote URL";
  if (normalized.startsWith("file:")) return "local file";
  if (normalized.startsWith("npm:")) return "npm alias";
  return null;
}

// The lowest concrete version a plain registry semver spec can resolve to:
// "^9.1.3" → "9.1.3", "~1.2" → "1.2.0", "2" → "2.0.0", ">=1.0.0 <2" → "1.0.0".
// A `||` union floors at the minimum across its branches, so
// "^2.0.0 || ^1.0.0" floors at 1.0.0. Returns null when any branch has no
// leading version anchor (dist-tags like "latest", "*", bare ">" ranges,
// git/URL specs) — an unanchored spec cannot be resolved without the registry,
// and guessing would fabricate a floor that was never in the range.
export function specFloorVersion(spec: string | undefined): string | null {
  if (!spec) return null;
  let floor: BranchFloor | null = null;
  for (const branch of spec.split("||")) {
    const parsed = branchFloor(branch.trim());
    if (!parsed) return null;
    if (!floor || compareBranchFloors(parsed, floor) < 0) floor = parsed;
  }
  return floor ? floor.text : null;
}

// The major component of specFloorVersion, for rules that only care about
// major-boundary crossings.
export function specFloorMajor(spec: string | undefined): number | undefined {
  const floor = specFloorVersion(spec);
  return floor === null ? undefined : Number.parseInt(floor, 10);
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
  const part = (value: string | undefined) => (value && /^\d+$/.test(value) ? value : "0");
  // Build metadata ("+build") has no version precedence and is not part of the
  // published version identifier; only a leading "-" prerelease is kept.
  const prerelease = suffix?.startsWith("-") ? suffix.split("+")[0] : "";
  return {
    parts: [
      Number.parseInt(major, 10),
      Number.parseInt(part(minor), 10),
      Number.parseInt(part(patch), 10),
    ],
    prerelease,
    text: `${major}.${part(minor)}.${part(patch)}${prerelease}`,
  };
}

function compareBranchFloors(a: BranchFloor, b: BranchFloor): number {
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] - b.parts[index];
  }
  // Same x.y.z: a prerelease floor precedes the release itself.
  if (Boolean(a.prerelease) !== Boolean(b.prerelease)) return a.prerelease ? -1 : 1;
  return 0;
}
