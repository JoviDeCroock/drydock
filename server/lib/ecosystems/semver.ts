/**
 * Semver ordering shared by the ecosystems whose versions are semver (npm,
 * atpm) and by the shared code that orders their releases, such as the badge.
 * Dependency-free so a shared module can order versions without importing one
 * ecosystem's registry client.
 */
export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseSemver(version: string): ParsedSemver | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.+)?$/.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

export function compareParsedSemver(a: ParsedSemver, b: ParsedSemver) {
  for (const key of ["major", "minor", "patch"] as const) {
    const diff = a[key] - b[key];
    if (diff) return diff;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumber = /^\d+$/.test(left) ? Number(left) : null;
    const rightNumber = /^\d+$/.test(right) ? Number(right) : null;
    if (leftNumber !== null && rightNumber !== null) {
      const diff = leftNumber - rightNumber;
      if (diff) return diff;
    } else if (leftNumber !== null) {
      return -1;
    } else if (rightNumber !== null) {
      return 1;
    } else {
      const diff = left.localeCompare(right);
      if (diff) return diff;
    }
  }
  return 0;
}

export function compareSemver(a: string, b: string) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa && pb) return compareParsedSemver(pa, pb);
  return a.localeCompare(b);
}
