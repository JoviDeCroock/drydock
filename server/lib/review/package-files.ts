import type { PackageJsonSummary } from "./serialize";

// Whether a packed file is one `npm pack` could have put in the tarball given
// the manifest's `files` array. A file npm would have left out is evidence the
// archive was assembled or altered by something other than the declared pack,
// so the matcher mirrors npm-packlist (npm 7+) rather than a looser glob:
//
// - Entries are inverted into ignore rules after a leading `*` that excludes
//   everything; rules apply in order and the last match wins, so a `!` entry
//   re-excludes what an earlier entry included.
// - A leading `./` is dropped and a trailing `/*` widens to `/**`. A literal
//   entry naming a directory also gets `<entry>/**`, so its contents are in;
//   a glob that merely matches a directory does not pull in its contents.
// - Patterns are minimatch globs with `dot` and `nocase`. One without a slash
//   matches a basename at any depth (`matchBase`); a slash anchors it to the
//   package root, and a leading `/` only anchors. A trailing `/` matches
//   directories only.
// - Walking is gated by directories: a file is packed only when every
//   ancestor directory survives the rules, and a directory survives while some
//   include rule could still match beneath it.
// - Always packed regardless of later `!` entries: a literal entry naming a
//   file (npm makes it a strict rule), and at the package root only
//   `package.json`, README / LICENSE / LICENCE / COPYING (with any extension)
//   and the `main`, `browser` and `bin` targets. Bundled dependencies are
//   packed under the root `node_modules/` by their own rules, not the root
//   `files`: the declared names (`true` means every `dependencies` name) plus
//   the dependencies their packed manifests declare, which npm hoists too.
//
// Deliberate tolerances beyond npm 7+: CHANGELOG / CHANGES / HISTORY / NOTICE
// documents with a document extension at the root (always packed by npm <= 6
// and yarn, both still publish), npm-shrinkwrap.json, and the declared
// `module` / `types` targets. Each is a document or a declared entrypoint, so
// none can hide an undeclared script; an extensionless name is excluded
// because `require("./CHANGELOG")` loads one as JavaScript.

export interface PackageFilesAllowlist {
  /** The given paths npm would not have packed. */
  outsidePaths(paths: Iterable<string>): Set<string>;
}

export interface PackageFilesAllowlistOptions {
  /** Parsed text of a packed `package.json`, used for bundled dependencies. */
  packedManifest?: (path: string) => unknown;
}

// `files` comes from the reviewed (hostile) manifest. Patterns are matched by a
// linear-time wildcard walk rather than compiled to RegExp, and the work per
// manifest is capped. A manifest over a cap falls back to its literal entries:
// a glob nobody can afford to evaluate proves nothing is packed, so every path
// not named literally, always packed, bundled or an entrypoint counts as
// outside. Real manifests never reach the caps, so the fallback only ever
// over-reports on a manifest built to exhaust them.
const MAX_FILES_ENTRIES = 1_000;
const MAX_ENTRY_LENGTH = 1_024;
const MAX_EXPANSIONS_PER_ENTRY = 64;
// Compile work across one manifest: every expanded pattern costs its length
// plus a fixed overhead (an empty alternative still allocates a compiled
// pattern), and parsing a group costs the characters it scans. Without it the
// entry, length and expansion caps multiply into gigabytes before any path is
// matched.
const MAX_COMPILE_WORK = 250_000;
const PATTERN_OVERHEAD = 32;
// Wildcard steps across every path matched against one manifest. Real
// manifests spend well under 1% of it on the largest packages in the sweep.
const MAX_MATCH_WORK = 30_000_000;
const MAX_BUNDLED_MANIFESTS = 5_000;

const ALWAYS_PACKED_AT_ROOT =
  /^(?:package\.json|npm-shrinkwrap\.json|(?:readme|copying|license|licence)(?:\..*[^~$])?)$/i;
const TOLERATED_AT_ROOT = /^(?:changelog|changes|history|notice)\.(?:md|markdown|txt|rst)$/i;

export function isOutsidePackageFilesAllowlist(
  path: string,
  packageJson: PackageJsonSummary | null | undefined,
  rawManifest?: unknown,
): boolean {
  return (
    compilePackageFilesAllowlist(packageJson, rawManifest)?.outsidePaths([path]).has(path) ?? false
  );
}

/**
 * Compile once per manifest. `rawManifest` is the parsed `package.json` text,
 * read for fields the parser summary does not carry (`browser`,
 * `bundleDependencies`); the summary's own fields win when both are present.
 */
export function compilePackageFilesAllowlist(
  packageJson: PackageJsonSummary | null | undefined,
  rawManifest?: unknown,
  options: PackageFilesAllowlistOptions = {},
): PackageFilesAllowlist | null {
  const raw = isRecord(rawManifest) ? rawManifest : {};
  const files = (packageJson?.files ?? stringList(raw.files)).filter((entry) => entry.trim());
  if (!files.length) return null;

  const budget: MatchBudget = { remaining: MAX_MATCH_WORK };
  const compileBudget: MatchBudget = { remaining: MAX_COMPILE_WORK };
  let rules: FilesRule[] | null = null;
  if (
    files.length <= MAX_FILES_ENTRIES &&
    files.every((entry) => entry.length <= MAX_ENTRY_LENGTH)
  ) {
    try {
      rules = files.flatMap((entry) => compileFilesEntry(entry, budget, compileBudget));
    } catch (error) {
      if (!(error instanceof MatchBudgetExceeded)) throw error;
    }
  }
  const literalDirectories = new Set(
    files
      .map((entry) => entry.trim())
      .filter((entry) => !entry.startsWith("!") && !hasGlobMagic(entry))
      .map((entry) => normalizeManifestPath(entry).toLowerCase())
      .filter(Boolean),
  );
  const alwaysPacked = new Set(
    [
      packageJson?.main ?? raw.main,
      packageJson?.module ?? raw.module,
      packageJson?.types ?? raw.types,
      packageJson?.browser ?? raw.browser,
      ...binTargets(packageJson?.bin ?? raw.bin),
    ]
      .filter((value): value is string => typeof value === "string")
      .map((value) => normalizeManifestPath(value).toLowerCase())
      .filter(Boolean),
  );
  for (const entry of files) {
    const literal = literalFileEntry(entry);
    if (literal) alwaysPacked.add(literal);
  }
  const bundled = bundledDependencyNames(raw, options.packedManifest);

  const directoryWalked = new Map<string, boolean>();
  const walked = (segments: string[]): boolean => {
    for (let depth = 1; depth < segments.length; depth += 1) {
      const key = segments.slice(0, depth).join("/");
      let survives = directoryWalked.get(key);
      if (survives === undefined) {
        survives = evaluate(rules ?? [], segments.slice(0, depth), true);
        directoryWalked.set(key, survives);
      }
      if (!survives) return false;
    }
    return true;
  };
  const isOutside = (path: string): boolean => {
    const normalized = normalizeManifestPath(path).toLowerCase();
    if (!normalized) return false;
    if (alwaysPacked.has(normalized)) return false;
    const segments = normalized.split("/");
    if (
      segments.length === 1 &&
      (ALWAYS_PACKED_AT_ROOT.test(normalized) || TOLERATED_AT_ROOT.test(normalized))
    ) {
      return false;
    }
    if (isBundledPath(segments, bundled)) return false;
    if (!rules) return !isUnderLiteralEntry(normalized, literalDirectories);
    if (!walked(segments)) return true;
    return !evaluate(rules, segments, false);
  };

  return {
    outsidePaths(paths) {
      const list = [...paths];
      const outside = new Set<string>();
      try {
        for (const path of list) {
          if (isOutside(path)) outside.add(path);
        }
        return outside;
      } catch (error) {
        if (!(error instanceof MatchBudgetExceeded)) throw error;
      }
      rules = null;
      return new Set(list.filter(isOutside));
    },
  };
}

// Whether the path is a literal entry or lies beneath one. The fallback runs
// precisely when `files` is too large to trust, so the lookup walks the path's
// own prefixes instead of the entries.
function isUnderLiteralEntry(normalized: string, entries: Set<string>): boolean {
  if (entries.has(normalized)) return true;
  for (
    let slash = normalized.indexOf("/");
    slash >= 0;
    slash = normalized.indexOf("/", slash + 1)
  ) {
    if (entries.has(normalized.slice(0, slash))) return true;
  }
  return false;
}

interface MatchBudget {
  remaining: number;
}

class MatchBudgetExceeded extends Error {}

function spend(budget: MatchBudget, units: number): void {
  budget.remaining -= units;
  if (budget.remaining < 0) throw new MatchBudgetExceeded();
}

// `node_modules/<name>/…` or `node_modules/@scope/<name>/…` for a bundled name.
function isBundledPath(segments: string[], bundled: Set<string>): boolean {
  if (segments[0] !== "node_modules" || !bundled.size) return false;
  const name = segments[1]?.startsWith("@") ? segments.slice(1, 3).join("/") : segments[1];
  return segments.length > (name?.includes("/") ? 3 : 2) && bundled.has(name ?? "");
}

// npm-packlist packs each bundled dependency and, from the bundle down, every
// prod and optional dependency it resolves, wherever arborist placed it. The
// packed manifests say which names those are; a name whose manifest is not in
// the archive contributes nothing further.
function bundledDependencyNames(
  raw: Record<string, unknown>,
  packedManifest: PackageFilesAllowlistOptions["packedManifest"],
): Set<string> {
  const declared = raw.bundleDependencies ?? raw.bundledDependencies;
  const roots =
    declared === true
      ? Object.keys(isRecord(raw.dependencies) ? raw.dependencies : {})
      : stringList(declared);
  const names = new Set<string>();
  const queue: string[] = [];
  const visit = (directory: string, name: string) => {
    if (queue.length >= MAX_BUNDLED_MANIFESTS) return;
    queue.push(`${directory}node_modules/${name.toLowerCase()}`);
  };
  for (const name of roots) visit("", name);
  const seen = new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const directory = queue[index];
    if (seen.has(directory)) continue;
    seen.add(directory);
    if (!directory.includes("/node_modules/")) names.add(directory.slice("node_modules/".length));
    const manifest = packedManifest?.(`${directory}/package.json`);
    if (!isRecord(manifest)) continue;
    for (const field of [manifest.dependencies, manifest.optionalDependencies]) {
      for (const name of Object.keys(isRecord(field) ? field : {})) {
        visit(`${directory}/`, name);
        visit("", name);
      }
    }
  }
  return names;
}

interface FilesRule {
  include: boolean;
  matchers: GlobMatcher[];
}

// ignore-walk's filterEntry: start included, then let each rule whose polarity
// differs from the current state flip it when it matches. Directories also
// match an include rule that could match something beneath them.
function evaluate(rules: FilesRule[], segments: string[], isDirectory: boolean): boolean {
  let included = false; // the leading `*` rule excludes everything
  for (const rule of rules) {
    if (rule.include === included) continue;
    const matches = rule.matchers.some(
      (matcher) =>
        matcher.match(segments, isDirectory, false) ||
        (isDirectory && rule.include && matcher.match(segments, true, true)),
    );
    if (matches) included = rule.include;
  }
  return included;
}

function compileFilesEntry(
  entry: string,
  budget: MatchBudget,
  compileBudget: MatchBudget,
): FilesRule[] {
  let pattern = entry.trim();
  let include = true;
  while (pattern.startsWith("!")) {
    include = !include;
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("./")) pattern = pattern.slice(1);
  if (pattern.endsWith("/*")) pattern += "*";
  const directoryOnly = pattern.endsWith("/");
  const matchBase = !pattern.replace(/\/+$/, "").includes("/");
  pattern = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!pattern || pattern === ".") pattern = "**";
  pattern = pattern.toLowerCase();

  const rule = {
    include,
    matchers: compileGlob(pattern, budget, compileBudget, { matchBase, directoryOnly }),
  };
  if (hasGlobMagic(pattern)) return [rule];
  // A literal entry is either a file or a directory; npm adds `<entry>/**` for
  // the directory case, and for a file it matches nothing extra.
  return [
    rule,
    {
      include,
      matchers: compileGlob(`${pattern}/**`, budget, compileBudget, { matchBase: false }),
    },
  ];
}

// A non-negated entry without glob syntax; npm-packlist turns one that names a
// file into a required file that no later `!` entry can drop. Directory names
// land here too, which is harmless: no packed file has a directory's path.
function literalFileEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (trimmed.startsWith("!") || trimmed.endsWith("/") || hasGlobMagic(trimmed)) return null;
  return normalizeManifestPath(trimmed).toLowerCase() || null;
}

function hasGlobMagic(pattern: string): boolean {
  return /[*?[\]{}()]/.test(pattern);
}

interface GlobMatcher {
  match(segments: string[], isDirectory: boolean, partial: boolean): boolean;
}

const GLOBSTAR = Symbol("globstar");
type SegmentToken =
  | { kind: "star" }
  | { kind: "one" }
  | { kind: "char"; char: string }
  | { kind: "class"; negated: boolean; test: (char: string) => boolean };
type Segment = typeof GLOBSTAR | SegmentToken[];
interface CompiledPattern {
  segments: Segment[];
  // restIsGlobstar[i]: every segment from i on is `**`.
  restIsGlobstar: boolean[];
}

function compileGlob(
  pattern: string,
  budget: MatchBudget,
  compileBudget: MatchBudget,
  options: { matchBase: boolean; directoryOnly?: boolean },
): GlobMatcher[] {
  const compiledNegatives = new Map<string[], CompiledPattern[]>();
  return expandAlternatives(pattern, compileBudget).map(({ positive, negatives }) => {
    const compiled = compileSegments(positive);
    let excluded = compiledNegatives.get(negatives);
    if (!excluded) {
      excluded = negatives.map(compileSegments);
      compiledNegatives.set(negatives, excluded);
    }
    return {
      match(segments, isDirectory, partial) {
        if (options.directoryOnly && !isDirectory) return false;
        const target = options.matchBase ? segments.slice(-1) : segments;
        // ignore-walk's partial test is minimatch's own: a basename pattern
        // still compares against the directory's basename.
        const usePartial = partial && !options.matchBase;
        if (!matchSegments(compiled, target, usePartial, budget)) return false;
        return (
          usePartial || !excluded.some((negative) => matchSegments(negative, target, false, budget))
        );
      },
    };
  });
}

// Brace sets and the `@(a|b)` / `?(a|b)` extglobs expand to alternatives; one
// `!(a|b)` per pattern becomes "matches `*` here but none of the alternatives".
// `+(…)` and `*(…)` stay literal, which can only make an entry match less.
// Every string kept is charged to the compile budget as it is produced, so a
// hostile entry stops allocating at the cap instead of after expanding fully.
function expandAlternatives(
  pattern: string,
  compileBudget: MatchBudget,
): Array<{ positive: string; negatives: string[] }> {
  const out: Array<{ positive: string; negatives: string[] }> = [];
  const keep = (positive: string, negatives: string[]): boolean => {
    if (out.length === MAX_EXPANSIONS_PER_ENTRY) return false;
    spend(compileBudget, PATTERN_OVERHEAD + positive.length);
    out.push({ positive, negatives });
    return true;
  };
  for (const expanded of expandBraces(pattern, compileBudget)) {
    if (out.length === MAX_EXPANSIONS_PER_ENTRY) break;
    const negation = findGroup(expanded, "!", compileBudget);
    if (!negation) {
      for (const positive of expandExtglobs(expanded, compileBudget)) {
        if (!keep(positive, [])) break;
      }
      continue;
    }
    const before = expanded.slice(0, negation.start);
    const after = expanded.slice(negation.end);
    // Shared by every positive this alternative expands to.
    const negatives: string[] = [];
    for (const alternative of negation.alternatives) {
      for (const negative of expandExtglobs(`${before}${alternative}${after}`, compileBudget)) {
        spend(compileBudget, PATTERN_OVERHEAD + negative.length);
        negatives.push(negative);
      }
    }
    for (const positive of expandExtglobs(`${before}*${after}`, compileBudget)) {
      if (!keep(positive, negatives)) break;
    }
  }
  return out;
}

function expandBraces(pattern: string, compileBudget: MatchBudget): string[] {
  let results = [pattern];
  for (let round = 0; round < 8; round += 1) {
    let changed = false;
    const next: string[] = [];
    for (const candidate of results) {
      const group = findBraceGroup(candidate, compileBudget);
      if (!group) {
        next.push(candidate);
        continue;
      }
      changed = true;
      for (const alternative of group.alternatives) {
        next.push(`${candidate.slice(0, group.start)}${alternative}${candidate.slice(group.end)}`);
      }
    }
    if (next.length > MAX_EXPANSIONS_PER_ENTRY) return results;
    results = next;
    if (!changed) break;
  }
  return results;
}

function findBraceGroup(
  pattern: string,
  compileBudget: MatchBudget,
): { start: number; end: number; alternatives: string[] } | null {
  for (let start = 0; start < pattern.length; start += 1) {
    if (pattern[start] === "\\") {
      start += 1;
      continue;
    }
    if (pattern[start] !== "{") continue;
    const group = splitGroup(pattern, start + 1, "}", ",", compileBudget);
    // `{x}` (no comma) is literal in minimatch.
    if (group && group.alternatives.length > 1) return { start, ...group };
  }
  return null;
}

function expandExtglobs(pattern: string, compileBudget: MatchBudget): string[] {
  let results = [pattern];
  for (let round = 0; round < 8; round += 1) {
    const next: string[] = [];
    let changed = false;
    for (const candidate of results) {
      const group =
        findGroup(candidate, "@", compileBudget) ?? findGroup(candidate, "?", compileBudget);
      if (!group) {
        next.push(candidate);
        continue;
      }
      changed = true;
      const alternatives =
        candidate[group.start] === "?" ? ["", ...group.alternatives] : group.alternatives;
      for (const alternative of alternatives) {
        next.push(`${candidate.slice(0, group.start)}${alternative}${candidate.slice(group.end)}`);
      }
    }
    if (next.length > MAX_EXPANSIONS_PER_ENTRY) return results;
    results = next;
    if (!changed) break;
  }
  return results;
}

function findGroup(
  pattern: string,
  marker: "!" | "@" | "?",
  compileBudget: MatchBudget,
): { start: number; end: number; alternatives: string[] } | null {
  for (let start = 0; start + 1 < pattern.length; start += 1) {
    if (pattern[start] === "\\") {
      start += 1;
      continue;
    }
    if (pattern[start] !== marker || pattern[start + 1] !== "(") continue;
    const group = splitGroup(pattern, start + 2, ")", "|", compileBudget);
    if (group) return { start, ...group };
  }
  return null;
}

// Split the group body that starts at `from` on top-level separators, up to
// its matching close. Null when the group never closes (then it is literal).
function splitGroup(
  pattern: string,
  from: number,
  close: "}" | ")",
  separator: "," | "|",
  compileBudget: MatchBudget,
): { end: number; alternatives: string[] } | null {
  // An unclosed group scans to the end, once per opener; charging the scan
  // keeps a pattern of openers from going quadratic.
  spend(compileBudget, pattern.length - from);
  const open = close === "}" ? "{" : "(";
  const alternatives: string[] = [];
  let depth = 0;
  let current = "";
  for (let index = from; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\" && index + 1 < pattern.length) {
      current += char + pattern[index + 1];
      index += 1;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) {
      if (depth === 0) {
        alternatives.push(current);
        return { end: index + 1, alternatives };
      }
      depth -= 1;
    }
    if (char === separator && depth === 0) {
      alternatives.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  return null;
}

// Adjacent `**` segments are one `**`; collapsing them keeps a stack of
// globstars from multiplying the walk below.
function compileSegments(pattern: string): CompiledPattern {
  const segments: Segment[] = [];
  for (const segment of pattern.split("/").filter(Boolean)) {
    if (segment !== "**") segments.push(compileSegment(segment));
    else if (segments.at(-1) !== GLOBSTAR) segments.push(GLOBSTAR);
  }
  const restIsGlobstar = Array.from({ length: segments.length + 1 }, () => true);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    restIsGlobstar[index] = segments[index] === GLOBSTAR && restIsGlobstar[index + 1];
  }
  return { segments, restIsGlobstar };
}

function compileSegment(segment: string): SegmentToken[] {
  const tokens: SegmentToken[] = [];
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (char === "\\" && index + 1 < segment.length) {
      tokens.push({ kind: "char", char: segment[index + 1] });
      index += 1;
    } else if (char === "*") {
      // `**` inside a segment is a plain `*` in minimatch.
      if (tokens.at(-1)?.kind !== "star") tokens.push({ kind: "star" });
    } else if (char === "?") {
      tokens.push({ kind: "one" });
    } else if (char === "[") {
      const parsed = parseClass(segment, index);
      if (parsed) {
        tokens.push(parsed.token);
        index = parsed.end;
      } else {
        tokens.push({ kind: "char", char });
      }
    } else {
      tokens.push({ kind: "char", char });
    }
  }
  return tokens;
}

function parseClass(segment: string, open: number): { token: SegmentToken; end: number } | null {
  let index = open + 1;
  const negated = segment[index] === "!" || segment[index] === "^";
  if (negated) index += 1;
  const ranges: Array<[string, string]> = [];
  let first = true;
  for (; index < segment.length; index += 1) {
    let char = segment[index];
    if (char === "]" && !first) {
      const test = (value: string) => ranges.some(([low, high]) => value >= low && value <= high);
      return { token: { kind: "class", negated, test }, end: index };
    }
    first = false;
    if (char === "\\" && index + 1 < segment.length) char = segment[++index];
    if (segment[index + 1] === "-" && index + 2 < segment.length && segment[index + 2] !== "]") {
      ranges.push([char, segment[index + 2]]);
      index += 2;
    } else {
      ranges.push([char, char]);
    }
  }
  return null;
}

// Memoized walk over (pattern segment, path segment) positions, so stacked
// `**` segments cost O(pattern x path) instead of backtracking.
function matchSegments(
  { segments: pattern, restIsGlobstar }: CompiledPattern,
  path: string[],
  partial: boolean,
  budget: MatchBudget,
): boolean {
  const memo = new Map<number, boolean>();
  const width = path.length + 1;
  const visit = (pi: number, fi: number): boolean => {
    const key = pi * width + fi;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (pi === pattern.length) result = fi === path.length;
    else if (fi === path.length) {
      result = partial || restIsGlobstar[pi];
    } else {
      const segment = pattern[pi];
      result =
        segment === GLOBSTAR
          ? visit(pi + 1, fi) || visit(pi, fi + 1)
          : matchSegment(segment, path[fi], budget) && visit(pi + 1, fi + 1);
    }
    memo.set(key, result);
    return result;
  };
  const matched = visit(0, 0);
  spend(budget, memo.size);
  return matched;
}

// Greedy wildcard match with single-star backtracking: O(tokens x chars).
function matchSegment(tokens: SegmentToken[], text: string, budget: MatchBudget): boolean {
  let steps = 0;
  let ti = 0;
  let ci = 0;
  let starToken = -1;
  let starChar = 0;
  while (ci < text.length) {
    steps += 1;
    const token = tokens[ti];
    if (token && token.kind !== "star" && tokenMatches(token, text[ci])) {
      ti += 1;
      ci += 1;
    } else if (token?.kind === "star") {
      starToken = ti;
      starChar = ci;
      ti += 1;
    } else if (starToken >= 0) {
      ti = starToken + 1;
      starChar += 1;
      ci = starChar;
    } else {
      spend(budget, steps);
      return false;
    }
  }
  spend(budget, steps);
  while (tokens[ti]?.kind === "star") ti += 1;
  return ti === tokens.length;
}

function tokenMatches(token: Exclude<SegmentToken, { kind: "star" }>, char: string): boolean {
  if (token.kind === "one") return true;
  if (token.kind === "char") return token.char === char;
  return token.test(char) !== token.negated;
}

function normalizeManifestPath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function binTargets(bin: unknown): unknown[] {
  if (typeof bin === "string") return [bin];
  if (isRecord(bin)) return Object.values(bin);
  return [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
