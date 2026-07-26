// Compact PEP 440 version handling for equivalence checks and ordering.
// PyPI registry release keys, artifact filenames, and embedded METADATA can
// spell the same version differently ("1.0-1" vs "1.0.post1", "0.5dev0" vs
// "0.5.dev0"), and PyPI has no semver — PEP 440 defines the total order used
// to pick version predecessors.

export interface ParsedPyPiVersion {
  epoch: number;
  release: number[];
  pre: { rank: number; n: number } | null;
  post: number | null;
  dev: number | null;
  local: string | null;
}

// PEP 440 appendix regex, condensed. Applied after lowercasing and stripping
// the legacy "-final"/"-stable" release markers old setuptools emitted (pkg
// _resources treated "*final" as the release itself).
const PEP440_RE = new RegExp(
  "^v?" +
    "(?:(\\d+)!)?" + // epoch
    "(\\d+(?:\\.\\d+)*)" + // release
    "(?:[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\\d*))?" + // pre
    "(?:(?:-(\\d+))|(?:[-_.]?(?:post|rev|r)[-_.]?(\\d*)))?" + // post
    "(?:[-_.]?dev[-_.]?(\\d*))?" + // dev
    "(?:\\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$", // local
);

const PRE_RANK: Record<string, number> = {
  a: 0,
  alpha: 0,
  b: 1,
  beta: 1,
  c: 2,
  rc: 2,
  pre: 2,
  preview: 2,
};

export function parsePyPiVersion(version: string): ParsedPyPiVersion | null {
  const cleaned = version
    .trim()
    .toLowerCase()
    .replace(/[-_.](final|stable)$/, "");
  const match = PEP440_RE.exec(cleaned);
  if (!match) return null;
  const [, epoch, release, preLetter, preN, postN1, postN2, devN, local] = match;
  return {
    epoch: epoch ? Number(epoch) : 0,
    release: release.split(".").map(Number),
    pre: preLetter !== undefined ? { rank: PRE_RANK[preLetter] ?? 2, n: Number(preN || 0) } : null,
    post: postN1 !== undefined ? Number(postN1) : postN2 !== undefined ? Number(postN2 || 0) : null,
    dev: devN !== undefined ? Number(devN || 0) : null,
    local: local ?? null,
  };
}

// Canonical spelling used only for equality, not display. Unparseable legacy
// versions fall back to a separator-normalized form so "1.0_beta" and
// "1.0-beta" still compare equal.
function pyPiVersionEquivalenceKey(version: string): string {
  const parsed = parsePyPiVersion(version);
  if (!parsed) {
    return version
      .trim()
      .toLowerCase()
      .replace(/^v/, "")
      .replace(/[-_]+/g, ".")
      .replace(/\.+/g, ".")
      .replace(/\.$/, "");
  }
  const release = [...parsed.release];
  while (release.length > 1 && release.at(-1) === 0) release.pop();
  let key = `${parsed.epoch}!${release.join(".")}`;
  if (parsed.pre) key += `${["a", "b", "rc"][parsed.pre.rank]}${parsed.pre.n}`;
  if (parsed.post !== null) key += `.post${parsed.post}`;
  if (parsed.dev !== null) key += `.dev${parsed.dev}`;
  if (parsed.local) key += `+${parsed.local.replace(/[-_]/g, ".")}`;
  return key;
}

export function pyPiVersionsEquivalent(a: string, b: string): boolean {
  return pyPiVersionEquivalenceKey(a) === pyPiVersionEquivalenceKey(b);
}

// PEP 440 ordering: X.devN < X.aN < X.bN < X.rcN < X < X.postN. Local
// segments are ignored. Returns null when either side is unparseable.
export function comparePyPiVersions(a: string, b: string): number | null {
  const pa = parsePyPiVersion(a);
  const pb = parsePyPiVersion(b);
  if (!pa || !pb) return null;
  return compareParsedPyPiVersions(pa, pb);
}

export function compareParsedPyPiVersions(a: ParsedPyPiVersion, b: ParsedPyPiVersion): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  const length = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < length; i++) {
    const diff = (a.release[i] ?? 0) - (b.release[i] ?? 0);
    if (diff) return diff;
  }
  const [rankA, preA] = preSortKey(a);
  const [rankB, preB] = preSortKey(b);
  if (rankA !== rankB) return rankA - rankB;
  if (preA !== preB) return preA - preB;
  const postA = a.post ?? -1;
  const postB = b.post ?? -1;
  if (postA !== postB) return postA - postB;
  const devA = a.dev ?? Number.POSITIVE_INFINITY;
  const devB = b.dev ?? Number.POSITIVE_INFINITY;
  if (devA !== devB) return devA < devB ? -1 : 1;
  return 0;
}

// A bare dev release ("1.0.dev1") sorts below every pre-release of the same
// release segment; a final release sorts above every pre-release.
function preSortKey(version: ParsedPyPiVersion): [number, number] {
  if (version.pre) return [version.pre.rank, version.pre.n];
  if (version.post === null && version.dev !== null) return [-1, 0];
  return [3, 0];
}
