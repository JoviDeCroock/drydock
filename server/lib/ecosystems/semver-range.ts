/**
 * node-semver range matching (`satisfies`) without a dependency, following the
 * grammar npm resolves `dependencies` specs with: `||` sets, hyphen ranges,
 * X-ranges, tilde, caret, and primitive comparators, including node-semver's
 * prerelease rule. Loose spellings npm accepts (`v1.2.3`, `>= 1.2.3`, `~> 1.2`)
 * normalize first. A range this cannot parse returns null from `parseSemverRange`
 * so a caller can say "could not check" rather than guess.
 */
import { compareParsedSemver, parseSemver, type ParsedSemver } from "./semver";

type Operator = "<" | "<=" | ">" | ">=" | "=";

interface Comparator {
  operator: Operator;
  version: ParsedSemver;
}

/** One `||` alternative: every comparator must hold. Empty matches any release. */
type ComparatorSet = Comparator[];

export interface SemverRange {
  sets: ComparatorSet[];
}

// node-semver's MAX_LENGTH: a range longer than this is refused outright.
const MAX_RANGE_LENGTH = 256;
const MAX_NUMERIC = Number.MAX_SAFE_INTEGER;

const PARTIAL_RE =
  /^v?(\d+|[xX*])(?:\.(\d+|[xX*])(?:\.(\d+|[xX*])(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)?)?$/;
const COMPARATOR_RE = /^(<=|>=|<|>|=|~>|~|\^)?=?\s*(.*)$/;

interface Partial {
  major: number | null;
  minor: number | null;
  patch: number | null;
  prerelease: string[];
}

function parseNumeric(part: string | undefined): number | null | undefined {
  if (part === undefined || part === "x" || part === "X" || part === "*") return null;
  if (part.length > 16) return undefined;
  const value = Number(part);
  return Number.isSafeInteger(value) && value <= MAX_NUMERIC ? value : undefined;
}

function parsePartial(text: string): Partial | null {
  if (text === "" || text === "*" || text === "x" || text === "X") {
    return { major: null, minor: null, patch: null, prerelease: [] };
  }
  const match = PARTIAL_RE.exec(text);
  if (!match) return null;
  const major = parseNumeric(match[1]);
  const minor = parseNumeric(match[2]);
  const patch = parseNumeric(match[3]);
  if (major === undefined || minor === undefined || patch === undefined) return null;
  // node-semver refuses a number after a wildcard (`1.x.3`, `*.2`).
  if ((major === null && (minor !== null || patch !== null)) || (minor === null && patch !== null))
    return null;
  return {
    major,
    minor,
    patch,
    prerelease: patch !== null && match[4] ? match[4].split(".") : [],
  };
}

function version(major: number, minor: number, patch: number, prerelease: string[] = []) {
  return { major, minor, patch, prerelease };
}

// The exclusive upper bound node-semver writes as `<X.Y.Z-0`: below every
// prerelease of X.Y.Z, so `<2.0.0-0` excludes 2.0.0-rc.1 as well as 2.0.0.
function below(major: number, minor: number, patch: number): Comparator {
  return { operator: "<", version: version(major, minor, patch, ["0"]) };
}

function atLeast(p: Partial): Comparator {
  return {
    operator: ">=",
    version: version(p.major ?? 0, p.minor ?? 0, p.patch ?? 0, p.prerelease),
  };
}

const NOTHING: ComparatorSet = [{ operator: "<", version: version(0, 0, 0, ["0"]) }];

function desugarTilde(p: Partial): ComparatorSet {
  if (p.major === null) return [];
  if (p.minor === null) return [atLeast(p), below(p.major + 1, 0, 0)];
  return [atLeast(p), below(p.major, p.minor + 1, 0)];
}

function desugarCaret(p: Partial): ComparatorSet {
  if (p.major === null) return [];
  if (p.minor === null) return [atLeast(p), below(p.major + 1, 0, 0)];
  if (p.major > 0) return [atLeast(p), below(p.major + 1, 0, 0)];
  if (p.patch === null || p.minor > 0) return [atLeast(p), below(0, p.minor + 1, 0)];
  return [atLeast(p), below(0, 0, p.patch + 1)];
}

function desugarPrimitive(operator: Operator, p: Partial): ComparatorSet | null {
  if (p.major === null) {
    // `>*` and `<*` match nothing; `>=*`, `<=*`, and `=*` match any release.
    return operator === "<" || operator === ">" ? NOTHING : [];
  }
  if (p.minor !== null && p.patch !== null) {
    return [{ operator, version: version(p.major, p.minor, p.patch, p.prerelease) }];
  }
  // An X-range under an operator widens to the boundary it implies.
  switch (operator) {
    case "=":
      return desugarTilde(p);
    case ">=":
      return [atLeast(p)];
    case ">":
      return p.minor === null
        ? [{ operator: ">=", version: version(p.major + 1, 0, 0) }]
        : [{ operator: ">=", version: version(p.major, p.minor + 1, 0) }];
    case "<":
      return [below(p.major, p.minor ?? 0, 0)];
    case "<=":
      return p.minor === null ? [below(p.major + 1, 0, 0)] : [below(p.major, p.minor + 1, 0)];
  }
}

function desugarComparator(token: string): ComparatorSet | null {
  const match = COMPARATOR_RE.exec(token);
  if (!match) return null;
  const operator = match[1] ?? "";
  const partial = parsePartial(match[2].trim());
  if (!partial) return null;
  if (operator === "~" || operator === "~>") return desugarTilde(partial);
  if (operator === "^") return desugarCaret(partial);
  return desugarPrimitive((operator || "=") as Operator, partial);
}

function desugarHyphen(fromText: string, toText: string): ComparatorSet | null {
  const from = parsePartial(fromText);
  const to = parsePartial(toText);
  if (!from || !to) return null;
  const set: ComparatorSet = from.major === null ? [] : [atLeast(from)];
  if (to.major === null) return set;
  if (to.minor === null) return [...set, below(to.major + 1, 0, 0)];
  if (to.patch === null) return [...set, below(to.major, to.minor + 1, 0)];
  return [
    ...set,
    { operator: "<=", version: version(to.major, to.minor, to.patch, to.prerelease) },
  ];
}

function parseAlternative(text: string): ComparatorSet | null {
  // Glue operators to their versions (`>= 1.2.3` → `>=1.2.3`), as node-semver
  // does before splitting comparators on whitespace.
  const trimmed = text.trim().replace(/(<=|>=|<|>|=|~>|~|\^)\s+/g, "$1");
  if (trimmed === "") return [];
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
  if (hyphen) return desugarHyphen(hyphen[1], hyphen[2]);
  const set: ComparatorSet = [];
  for (const token of trimmed.split(/\s+/)) {
    const desugared = desugarComparator(token);
    if (!desugared) return null;
    set.push(...desugared);
  }
  return set;
}

export function parseSemverRange(range: string): SemverRange | null {
  if (typeof range !== "string" || range.length > MAX_RANGE_LENGTH) return null;
  const sets: ComparatorSet[] = [];
  for (const alternative of range.split("||")) {
    const set = parseAlternative(alternative);
    if (!set) return null;
    // `>=0.0.0` is node-semver's "any release" and is dropped like `*`.
    sets.push(set.filter((c) => !(c.operator === ">=" && isZero(c.version))));
  }
  // node-semver collapses a union containing "any" to just "any", which also
  // drops the prerelease opt-in of its siblings: `* || 2.0.0-rc.1` rejects
  // 2.0.0-rc.1. Matching that keeps the answer npm's.
  if (sets.length > 1 && sets.some((set) => set.length === 0)) return { sets: [[]] };
  return { sets };
}

function testComparator(comparator: Comparator, candidate: ParsedSemver): boolean {
  const diff = compareParsedSemver(candidate, comparator.version);
  switch (comparator.operator) {
    case "<":
      return diff < 0;
    case "<=":
      return diff <= 0;
    case ">":
      return diff > 0;
    case ">=":
      return diff >= 0;
    case "=":
      return diff === 0;
  }
}

function isZero(v: ParsedSemver): boolean {
  return v.major === 0 && v.minor === 0 && v.patch === 0 && v.prerelease.length === 0;
}

function sameTuple(a: ParsedSemver, b: ParsedSemver): boolean {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

function testSet(set: ComparatorSet, candidate: ParsedSemver): boolean {
  if (!set.every((comparator) => testComparator(comparator, candidate))) return false;
  if (!candidate.prerelease.length) return true;
  // node-semver's prerelease rule: a prerelease satisfies a set only when some
  // comparator names a prerelease of the same major.minor.patch, so `^2.0.0`
  // never resolves to 2.1.0-rc.1 but `^2.1.0-rc.0` does.
  return set.some(
    (comparator) =>
      comparator.version.prerelease.length > 0 && sameTuple(comparator.version, candidate),
  );
}

export function rangeSatisfiedBy(range: SemverRange, candidate: string): boolean {
  const parsed = parseSemver(candidate);
  if (!parsed) return false;
  return range.sets.some((set) => testSet(set, parsed));
}

export function satisfiesSemverRange(candidate: string, range: string): boolean {
  const parsed = parseSemverRange(range);
  return parsed ? rangeSatisfiedBy(parsed, candidate) : false;
}

/** The highest candidate the range accepts, or null. Non-semver candidates are skipped. */
export function maxSatisfyingVersion(
  candidates: Iterable<string>,
  range: SemverRange,
): string | null {
  let best: { raw: string; parsed: ParsedSemver } | null = null;
  for (const raw of candidates) {
    const parsed = parseSemver(raw);
    if (!parsed || !range.sets.some((set) => testSet(set, parsed))) continue;
    if (!best || compareParsedSemver(parsed, best.parsed) > 0) best = { raw, parsed };
  }
  return best?.raw ?? null;
}
