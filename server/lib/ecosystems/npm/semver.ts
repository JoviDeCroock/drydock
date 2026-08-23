// Bounded semver parsing, comparison, and range satisfaction for npm specs.
//
// Extracted from `registry.ts` (which owns baseline selection) so the
// dependency-artifact resolver can answer a second question: given a declared
// range and the versions a registry actually published, which version would a
// consumer install right now? That is a review-time snapshot, never a
// permanent provenance claim — see `docs/dependency-review.md`.
//
// Deliberately hand-rolled rather than pulling in `semver`: the Worker bundle
// pays for every dependency it boots, the grammar below is the subset npm
// specs actually use, and anything this parser cannot represent resolves to
// "unresolvable", which the caller must surface as an uninspected dependency
// rather than silently skip.

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const NUMERIC_IDENTIFIER = "(?:0|[1-9]\\d*)";
const PARTIAL_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|x|X|\\*)`;
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const BUILD_IDENTIFIER = "[0-9A-Za-z-]+";
const SEMVER_RE = new RegExp(
  `^(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})` +
    `(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?` +
    `(?:\\+${BUILD_IDENTIFIER}(?:\\.${BUILD_IDENTIFIER})*)?$`,
);

export function parseSemver(version: string): ParsedSemver | null {
  const match = SEMVER_RE.exec(version.trim());
  if (!match) return null;
  const numeric = match.slice(1, 4).map(Number);
  if (!numeric.every(Number.isSafeInteger) || hasUnsafeNumericPrerelease(match[4])) return null;
  return {
    major: numeric[0],
    minor: numeric[1],
    patch: numeric[2],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

export function compareParsedSemver(a: ParsedSemver, b: ParsedSemver): number {
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
      // SemVer compares non-numeric identifiers in ASCII sort order. Locale
      // collation can reverse case ordering (for example `A` vs `a`) and pick
      // a different published version than npm.
      if (left < right) return -1;
      if (left > right) return 1;
    }
  }
  return 0;
}

type ComparatorOperator = ">" | ">=" | "<" | "<=" | "=";

interface Comparator {
  operator: ComparatorOperator;
  version: ParsedSemver;
}

/** One `||` branch: an intersection of comparators, all of which must hold. */
type ComparatorSet = Comparator[];

/**
 * A parsed npm range. `null` means the spec is not a plain registry range at
 * all (a git URL, `workspace:`, a dist-tag, or grammar this parser does not
 * model), which callers must treat as unresolvable rather than as "matches
 * nothing".
 */
export type SemverRange = ComparatorSet[];

const ANY_RANGE: SemverRange = [[]];

// A partial version (`1`, `1.2`, `1.x`) inside a comparator or an `^`/`~`
// operator. Captures the operator, then up to three numeric-or-wildcard parts,
// then an optional prerelease/build suffix.
const PARTIAL_RE = new RegExp(
  `^(\\^|~>|~|>=|<=|>|<|=|)\\s*v?(${PARTIAL_IDENTIFIER})` +
    `(?:\\.(${PARTIAL_IDENTIFIER}))?(?:\\.(${PARTIAL_IDENTIFIER}))?` +
    `(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?` +
    `(?:\\+${BUILD_IDENTIFIER}(?:\\.${BUILD_IDENTIFIER})*)?$`,
);

export function parseRange(spec: string): SemverRange | null {
  const trimmed = spec.trim();
  if (trimmed === "" || trimmed === "*" || trimmed === "x" || trimmed === "X") return ANY_RANGE;
  const sets: ComparatorSet[] = [];
  for (const branch of trimmed.split("||")) {
    const set = parseComparatorSet(branch.trim());
    if (!set) return null;
    sets.push(set);
  }
  return sets.length ? sets : null;
}

function parseComparatorSet(branch: string): ComparatorSet | null {
  if (branch === "" || branch === "*" || branch === "x" || branch === "X") return [];

  const hyphen = branch.split(/\s+-\s+/);
  if (hyphen.length === 2) {
    const low = hyphenLowerBound(hyphen[0]);
    const high = hyphenUpperBound(hyphen[1]);
    return low && high ? [low, high] : null;
  }
  if (hyphen.length > 2) return null;

  // node-semver accepts whitespace between a comparator operator and its
  // partial version (`>= 1.2.3`, `^ 1.2.3`). Join only that grammar boundary
  // before tokenization so comparator sets remain whitespace-delimited.
  branch = branch.replace(/(\^|~>|~|>=|<=|>|<|=)\s+(?=v?(?:\d|x|X|\*))/g, "$1");

  const comparators: Comparator[] = [];
  for (const token of branch.split(/\s+/).filter(Boolean)) {
    const parsed = parseComparator(token);
    if (!parsed) return null;
    comparators.push(...parsed);
  }
  return comparators;
}

function parseComparator(token: string): Comparator[] | null {
  const match = PARTIAL_RE.exec(token);
  if (!match) return null;
  const [, rawOperator, rawMajor, rawMinor, rawPatch, prerelease] = match;
  const operator = rawOperator || "=";

  if (
    [rawMajor, rawMinor, rawPatch].some(isUnsafeNumericIdentifier) ||
    hasUnsafeNumericPrerelease(prerelease)
  ) {
    return null;
  }

  const major = numericPart(rawMajor);
  const parsedMinor = numericPart(rawMinor);
  const parsedPatch = numericPart(rawPatch);
  const parts = [major, parsedMinor, parsedPatch];
  const wildcardIndex = parts.findIndex((part) => part === null);
  // npm's bare/comparator grammar rejects a numeric component after a
  // wildcard (`1.x.2`, `<1.x.2`) instead of silently broadening it to `1.x`.
  // Caret and tilde ranges deliberately retain npm's permissive partial-range
  // behavior (`^1.x.2` is equivalent to `^1.x`).
  if (
    parsedMinor === null &&
    rawMinor !== undefined &&
    parsedPatch !== null &&
    operator !== "^" &&
    operator !== "~" &&
    operator !== "~>"
  ) {
    return null;
  }
  const minor = parsedMinor;
  const patch = wildcardIndex === 1 ? null : parsedPatch;
  const pre = prerelease ? prerelease.split(".") : [];

  // Bare, equality, and inclusive major wildcards admit everything. Strict
  // major-wildcard comparators (`>x`, `<*`) are valid npm ranges that admit
  // nothing, represented by a comparator below the minimum SemVer.
  if (wildcardIndex === 0) {
    return operator === ">" || operator === "<"
      ? [{ operator: "<", version: { major: 0, minor: 0, patch: 0, prerelease: ["0"] } }]
      : [];
  }

  if (operator === "^" || operator === "~" || operator === "~>") {
    const floor: ParsedSemver = {
      major: major ?? 0,
      minor: minor ?? 0,
      patch: patch ?? 0,
      prerelease: pre,
    };
    return [
      { operator: ">=", version: floor },
      { operator: "<", version: tildeOrCaretCeiling(operator, floor, minor, patch) },
    ];
  }

  // A partial version under a comparator: `>=1.2` means `>=1.2.0`, `<1.2` means
  // `<1.2.0`, and a bare `1.2` is the range `>=1.2.0 <1.3.0`.
  const floor: ParsedSemver = {
    major: major ?? 0,
    minor: minor ?? 0,
    patch: patch ?? 0,
    prerelease: pre,
  };
  if (wildcardIndex === -1) {
    return [{ operator: operator as ComparatorOperator, version: floor }];
  }
  if (operator === "=") {
    return [
      { operator: ">=", version: floor },
      { operator: "<", version: nextAfterWildcard(floor, wildcardIndex) },
    ];
  }
  if (operator === ">") {
    // `>1.2` excludes all of 1.2.x, so its floor is the next minor.
    return [{ operator: ">=", version: nextAfterWildcard(floor, wildcardIndex) }];
  }
  if (operator === "<=") {
    // `<=1.2` admits all of 1.2.x.
    return [{ operator: "<", version: nextAfterWildcard(floor, wildcardIndex) }];
  }
  return [{ operator: operator as ComparatorOperator, version: floor }];
}

function tildeOrCaretCeiling(
  operator: string,
  floor: ParsedSemver,
  minor: number | null,
  patch: number | null,
): ParsedSemver {
  const zero: string[] = [];
  if (operator !== "^") {
    // `~1` is `>=1.0.0 <2.0.0`; `~1.2` and `~1.2.3` are both `<1.3.0`.
    return minor === null
      ? { major: floor.major + 1, minor: 0, patch: 0, prerelease: zero }
      : { major: floor.major, minor: floor.minor + 1, patch: 0, prerelease: zero };
  }
  // `^0.0.3` → `<0.0.4`; `^0.2` / `^0.2.3` → `<0.3.0`; otherwise next major.
  if (floor.major !== 0) return { major: floor.major + 1, minor: 0, patch: 0, prerelease: zero };
  if (minor === null) return { major: 1, minor: 0, patch: 0, prerelease: zero };
  if (floor.minor !== 0 || patch === null) {
    return { major: 0, minor: floor.minor + 1, patch: 0, prerelease: zero };
  }
  return { major: 0, minor: 0, patch: floor.patch + 1, prerelease: zero };
}

function nextAfterWildcard(floor: ParsedSemver, wildcardIndex: number): ParsedSemver {
  const zero: string[] = [];
  return wildcardIndex === 1
    ? { major: floor.major + 1, minor: 0, patch: 0, prerelease: zero }
    : { major: floor.major, minor: floor.minor + 1, patch: 0, prerelease: zero };
}

function hyphenLowerBound(token: string): Comparator | null {
  const match = PARTIAL_RE.exec(token.trim());
  if (
    !match ||
    match[1] ||
    [match[2], match[3], match[4]].some(isUnsafeNumericIdentifier) ||
    hasUnsafeNumericPrerelease(match[5])
  ) {
    return null;
  }
  const major = numericPart(match[2]);
  if (major === null) return null;
  return {
    operator: ">=",
    version: {
      major,
      minor: numericPart(match[3]) ?? 0,
      patch: numericPart(match[4]) ?? 0,
      prerelease: match[5] ? match[5].split(".") : [],
    },
  };
}

function hyphenUpperBound(token: string): Comparator | null {
  const match = PARTIAL_RE.exec(token.trim());
  if (
    !match ||
    match[1] ||
    [match[2], match[3], match[4]].some(isUnsafeNumericIdentifier) ||
    hasUnsafeNumericPrerelease(match[5])
  ) {
    return null;
  }
  const major = numericPart(match[2]);
  if (major === null) return null;
  const minor = numericPart(match[3]);
  const patch = numericPart(match[4]);
  // `1.2.3 - 2.3` admits every 2.3.x; `1.2.3 - 2` admits every 2.x.
  if (minor === null) return { operator: "<", version: zeroed(major + 1, 0) };
  if (patch === null) return { operator: "<", version: zeroed(major, minor + 1) };
  return {
    operator: "<=",
    version: { major, minor, patch, prerelease: match[5] ? match[5].split(".") : [] },
  };
}

function zeroed(major: number, minor: number): ParsedSemver {
  return { major, minor, patch: 0, prerelease: [] };
}

function numericPart(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (value === "x" || value === "X" || value === "*") return null;
  return Number.parseInt(value, 10);
}

function isUnsafeNumericIdentifier(value: string | undefined): boolean {
  if (value === undefined || value === "x" || value === "X" || value === "*") return false;
  return !Number.isSafeInteger(Number(value));
}

function hasUnsafeNumericPrerelease(value: string | undefined): boolean {
  return (
    value
      ?.split(".")
      .some(
        (identifier) => /^\d+$/.test(identifier) && !Number.isSafeInteger(Number(identifier)),
      ) ?? false
  );
}

/**
 * Whether a published version satisfies a parsed range.
 *
 * Prereleases follow npm: `1.0.0-rc.1` only satisfies a comparator set that
 * itself names a prerelease on the same `major.minor.patch` tuple. Without that
 * rule `^1.0.0` would silently resolve to an unreleased `2.0.0-rc.1`, and the
 * review would report a version no consumer would install.
 */
export function satisfies(version: ParsedSemver, range: SemverRange): boolean {
  return range.some((set) => satisfiesComparatorSet(version, set));
}

function satisfiesComparatorSet(version: ParsedSemver, set: ComparatorSet): boolean {
  for (const comparator of set) {
    if (!satisfiesComparator(version, comparator)) return false;
  }
  if (!version.prerelease.length) return true;
  return set.some(
    (comparator) =>
      comparator.version.prerelease.length &&
      comparator.version.major === version.major &&
      comparator.version.minor === version.minor &&
      comparator.version.patch === version.patch,
  );
}

function satisfiesComparator(version: ParsedSemver, comparator: Comparator): boolean {
  const order = compareParsedSemver(version, comparator.version);
  switch (comparator.operator) {
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case "=":
      return order === 0;
  }
}

/**
 * The highest published version a declared range admits — what a fresh
 * consumer install would resolve today.
 *
 * Returns null when the spec is not a parseable registry range or when no
 * published version satisfies it. Both cases mean "no artifact to review", and
 * the caller must record them explicitly rather than treat the dependency as
 * clean.
 */
export function maxSatisfyingVersion(versions: string[], spec: string): string | null {
  const range = parseRange(spec);
  if (!range) return null;
  let best: { version: string; parsed: ParsedSemver } | null = null;
  for (const version of versions) {
    const parsed = parseSemver(version);
    if (!parsed || !satisfies(parsed, range)) continue;
    if (!best || compareParsedSemver(parsed, best.parsed) > 0) best = { version, parsed };
  }
  return best?.version ?? null;
}
