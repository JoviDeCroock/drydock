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
//   file (npm makes it a strict rule), `package.json` and README / LICENSE /
//   LICENCE / COPYING (with any extension) in every walked directory, and the
//   `main`, `browser` and `bin` targets. Bundled dependencies are packed under
//   the root `node_modules/` by their own rules, not the root `files`.
//
// Deliberate tolerances beyond npm 7+: CHANGELOG / CHANGES / HISTORY / NOTICE
// documents at the root (always packed by npm <= 6 and yarn, both still
// publish), npm-shrinkwrap.json, and the declared `module` / `types` targets.
// Each is a document name or a declared entrypoint, so none can hide an
// undeclared script.

export interface PackageFilesAllowlist {
  isOutside(path: string): boolean;
}

// `files` comes from the reviewed (hostile) manifest. Patterns are matched by a
// linear-time wildcard walk rather than compiled to RegExp, and the work per
// manifest is capped; a manifest over a cap is not evaluated at all, which only
// gives up a signal the same author could disable with `files: ["**"]`.
const MAX_FILES_ENTRIES = 1_000;
const MAX_ENTRY_LENGTH = 1_024;
const MAX_EXPANSIONS_PER_ENTRY = 64;

const ALWAYS_PACKED_AT_ANY_LEVEL =
  /^(?:package\.json|(?:readme|copying|license|licence)(?:\..*[^~$])?)$/i;
const TOLERATED_AT_ROOT = /^(?:changelog|changes|history|notice)(?:\.(?:md|markdown|txt|rst))?$/i;

export function isOutsidePackageFilesAllowlist(
  path: string,
  packageJson: PackageJsonSummary | null | undefined,
  rawManifest?: unknown,
): boolean {
  return compilePackageFilesAllowlist(packageJson, rawManifest)?.isOutside(path) ?? false;
}

/**
 * Compile once per manifest. `rawManifest` is the parsed `package.json` text,
 * read for fields the parser summary does not carry (`browser`,
 * `bundleDependencies`); the summary's own fields win when both are present.
 */
export function compilePackageFilesAllowlist(
  packageJson: PackageJsonSummary | null | undefined,
  rawManifest?: unknown,
): PackageFilesAllowlist | null {
  const raw = isRecord(rawManifest) ? rawManifest : {};
  const files = (packageJson?.files ?? stringList(raw.files)).filter((entry) => entry.trim());
  if (!files.length || files.length > MAX_FILES_ENTRIES) return null;
  if (files.some((entry) => entry.length > MAX_ENTRY_LENGTH)) return null;

  const rules = files.flatMap(compileFilesEntry);
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
  alwaysPacked.add("package.json");
  alwaysPacked.add("npm-shrinkwrap.json");
  const bundled = hasBundledDependencies(raw);

  const directoryWalked = new Map<string, boolean>();
  const walked = (segments: string[]): boolean => {
    for (let depth = 1; depth < segments.length; depth += 1) {
      const key = segments.slice(0, depth).join("/");
      let survives = directoryWalked.get(key);
      if (survives === undefined) {
        survives = evaluate(rules, segments.slice(0, depth), true);
        directoryWalked.set(key, survives);
      }
      if (!survives) return false;
    }
    return true;
  };

  return {
    isOutside(path: string): boolean {
      const normalized = normalizeManifestPath(path).toLowerCase();
      if (!normalized) return false;
      if (alwaysPacked.has(normalized)) return false;
      const segments = normalized.split("/");
      if (segments.length === 1 && TOLERATED_AT_ROOT.test(normalized)) return false;
      if (bundled && segments[0] === "node_modules" && segments.length > 1) return false;
      if (!walked(segments)) return true;
      if (ALWAYS_PACKED_AT_ANY_LEVEL.test(segments.at(-1) ?? "")) return false;
      return !evaluate(rules, segments, false);
    },
  };
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

function compileFilesEntry(entry: string): FilesRule[] {
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

  const rule = { include, matchers: compileGlob(pattern, { matchBase, directoryOnly }) };
  if (hasGlobMagic(pattern)) return [rule];
  // A literal entry is either a file or a directory; npm adds `<entry>/**` for
  // the directory case, and for a file it matches nothing extra.
  return [rule, { include, matchers: compileGlob(`${pattern}/**`, { matchBase: false }) }];
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

function compileGlob(
  pattern: string,
  options: { matchBase: boolean; directoryOnly?: boolean },
): GlobMatcher[] {
  return expandAlternatives(pattern).map(({ positive, negatives }) => {
    const compiled = compileSegments(positive);
    const excluded = negatives.map(compileSegments);
    return {
      match(segments, isDirectory, partial) {
        if (options.directoryOnly && !isDirectory) return false;
        const target = options.matchBase ? segments.slice(-1) : segments;
        // ignore-walk's partial test is minimatch's own: a basename pattern
        // still compares against the directory's basename.
        const usePartial = partial && !options.matchBase;
        if (!matchSegments(compiled, target, usePartial)) return false;
        return usePartial || !excluded.some((negative) => matchSegments(negative, target, false));
      },
    };
  });
}

// Brace sets and the `@(a|b)` / `?(a|b)` extglobs expand to alternatives; one
// `!(a|b)` per pattern becomes "matches `*` here but none of the alternatives".
// `+(…)` and `*(…)` stay literal, which can only make an entry match less.
function expandAlternatives(pattern: string): Array<{ positive: string; negatives: string[] }> {
  const out: Array<{ positive: string; negatives: string[] }> = [];
  for (const expanded of expandBraces(pattern)) {
    const negation = findGroup(expanded, "!");
    if (!negation) {
      out.push(...expandExtglobs(expanded).map((positive) => ({ positive, negatives: [] })));
      continue;
    }
    const before = expanded.slice(0, negation.start);
    const after = expanded.slice(negation.end);
    for (const positive of expandExtglobs(`${before}*${after}`)) {
      out.push({
        positive,
        negatives: negation.alternatives.flatMap((alternative) =>
          expandExtglobs(`${before}${alternative}${after}`),
        ),
      });
    }
  }
  return out.slice(0, MAX_EXPANSIONS_PER_ENTRY);
}

function expandBraces(pattern: string): string[] {
  let results = [pattern];
  for (let round = 0; round < 8; round += 1) {
    let changed = false;
    const next: string[] = [];
    for (const candidate of results) {
      const group = findBraceGroup(candidate);
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
): { start: number; end: number; alternatives: string[] } | null {
  for (let start = 0; start < pattern.length; start += 1) {
    if (pattern[start] === "\\") {
      start += 1;
      continue;
    }
    if (pattern[start] !== "{") continue;
    const group = splitGroup(pattern, start + 1, "}", ",");
    // `{x}` (no comma) is literal in minimatch.
    if (group && group.alternatives.length > 1) return { start, ...group };
  }
  return null;
}

function expandExtglobs(pattern: string): string[] {
  let results = [pattern];
  for (let round = 0; round < 8; round += 1) {
    const next: string[] = [];
    let changed = false;
    for (const candidate of results) {
      const group = findGroup(candidate, "@") ?? findGroup(candidate, "?");
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
): { start: number; end: number; alternatives: string[] } | null {
  for (let start = 0; start + 1 < pattern.length; start += 1) {
    if (pattern[start] === "\\") {
      start += 1;
      continue;
    }
    if (pattern[start] !== marker || pattern[start + 1] !== "(") continue;
    const group = splitGroup(pattern, start + 2, ")", "|");
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
): { end: number; alternatives: string[] } | null {
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

function compileSegments(pattern: string): Segment[] {
  return pattern
    .split("/")
    .filter(Boolean)
    .map((segment) => (segment === "**" ? GLOBSTAR : compileSegment(segment)));
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
function matchSegments(pattern: Segment[], path: string[], partial: boolean): boolean {
  const memo = new Map<number, boolean>();
  const width = path.length + 1;
  const visit = (pi: number, fi: number): boolean => {
    const key = pi * width + fi;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (pi === pattern.length) result = fi === path.length;
    else if (fi === path.length) {
      result = partial || pattern.slice(pi).every((segment) => segment === GLOBSTAR);
    } else {
      const segment = pattern[pi];
      result =
        segment === GLOBSTAR
          ? visit(pi + 1, fi) || visit(pi, fi + 1)
          : matchSegment(segment, path[fi]) && visit(pi + 1, fi + 1);
    }
    memo.set(key, result);
    return result;
  };
  return visit(0, 0);
}

// Greedy wildcard match with single-star backtracking: O(tokens x chars).
function matchSegment(tokens: SegmentToken[], text: string): boolean {
  let ti = 0;
  let ci = 0;
  let starToken = -1;
  let starChar = 0;
  while (ci < text.length) {
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
      return false;
    }
  }
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

function hasBundledDependencies(raw: Record<string, unknown>): boolean {
  const value = raw.bundleDependencies ?? raw.bundledDependencies;
  return value === true || (Array.isArray(value) && value.length > 0);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
