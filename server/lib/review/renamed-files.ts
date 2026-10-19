import { BASELINE_TEXT_SAMPLE_LIMIT } from "../sample-retention";
import type { FileRecord } from "./types";

// Bundlers name chunks by content hash (`dist/chunk-YQNCOY6V.js`,
// `dist/chunks/cli-api.De07GUeT.js`, turbopack's `0w4cpmcl0uzvx.js`), so an
// ordinary release removes last version's chunk and adds the "same" module
// under a new name. Read as a brand-new file, every capability it already had
// lands on the release delta at added-file severity. Pairing the added file
// with its predecessor lets attribution diff it against that predecessor,
// exactly as a modified file is diffed against its previous version.
//
// Pairing is by content, never by name: the hash in a name is attacker-chosen,
// and a name can only narrow the group (same directory, same extension). A
// pairing grants nothing a release could not get by editing the predecessor in
// place, because changed spans are still measured against the predecessor's
// actual bytes. Every bound below fails toward leaving a file unpaired, which
// keeps the full added-file treatment.

/** Code extensions only: other names carry meaning (`binding.gyp`, `.npmrc`). */
const PAIRABLE_PATH = /\.(?:[cm]?[jt]sx?)$/i;
// Near-identical only. Real hash renames sit at 0.8 and above (vitest, tsx,
// storybook, vercel, cypress chunks in the npm sweep); a looser bar would also
// pair chunks a release substantially rewrote, which then lose added-file
// severity even though changed spans still catch their new lines.
const MIN_SIMILARITY = 0.8;
const MIN_SHINGLES = 4;
// A shingle shared by more removed files than this, within one group, is
// boilerplate (`"use strict"`, a shared import line). Dropping it can only
// undercount overlap, which pairs less.
const MAX_POSTING = 32;
// Both sides are compared on the same leading window: the sandbox clips
// baseline bodies to this length, so a whole staged bundle would otherwise
// never look like its clipped predecessor. Where in the file a payload sits
// does not matter here; attribution diffs the whole staged text.
const SHINGLE_WINDOW = BASELINE_TEXT_SAMPLE_LIMIT;
/** Total characters shingled per diff; past it the remaining files stay unpaired. */
const RENAME_PAIRING_CHAR_BUDGET = 32 * 1024 * 1024;

type PairableFile = Pick<FileRecord, "path" | "textSample" | "flags">;

/**
 * Pairs added files with removed files they were renamed from. Returns
 * staged path → previous path; each removed file pairs with at most one added
 * file. Deterministic for a given pair of file lists.
 */
export function pairRenamedFiles(
  previousFiles: PairableFile[],
  stagedFiles: PairableFile[],
  charBudget = RENAME_PAIRING_CHAR_BUDGET,
): Map<string, string> {
  const pairs = new Map<string, string>();
  const previousPaths = new Set(previousFiles.map((file) => file.path));
  const stagedPaths = new Set(stagedFiles.map((file) => file.path));
  const groups = new Map<string, { added: PairableFile[]; removed: PairableFile[] }>();
  const addTo = (file: PairableFile, side: "added" | "removed") => {
    const key = groupKey(file);
    if (!key) return;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { added: [], removed: [] }));
    group[side].push(file);
  };
  for (const file of stagedFiles) if (!previousPaths.has(file.path)) addTo(file, "added");
  for (const file of previousFiles) if (!stagedPaths.has(file.path)) addTo(file, "removed");

  let budget = charBudget;
  const shingle = (file: PairableFile): Set<number> | null => {
    const text = (file.textSample ?? "").slice(0, SHINGLE_WINDOW);
    if (text.length > budget) return null;
    budget -= text.length;
    const set = shingles(text);
    return set.size >= MIN_SHINGLES ? set : null;
  };

  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    if (!group.added.length || !group.removed.length) continue;
    group.added.sort(byPath);
    group.removed.sort(byPath);
    const removed = group.removed.map(shingle);
    const postings = new Map<number, number[]>();
    removed.forEach((set, index) => {
      for (const hash of set ?? []) {
        const list = postings.get(hash);
        if (!list) postings.set(hash, [index]);
        else if (list.length <= MAX_POSTING) list.push(index);
      }
    });
    const candidates: Array<{ added: number; removed: number; score: number }> = [];
    group.added.forEach((file, addedIndex) => {
      const set = shingle(file);
      if (!set) return;
      const shared = new Map<number, number>();
      for (const hash of set) {
        const list = postings.get(hash);
        if (!list || list.length > MAX_POSTING) continue;
        for (const index of list) shared.set(index, (shared.get(index) ?? 0) + 1);
      }
      for (const [removedIndex, count] of shared) {
        const other = removed[removedIndex]!;
        const score = count / (set.size + other.size - count);
        if (score >= MIN_SIMILARITY)
          candidates.push({ added: addedIndex, removed: removedIndex, score });
      }
    });
    candidates.sort((a, b) => b.score - a.score || a.added - b.added || a.removed - b.removed);
    const usedAdded = new Set<number>();
    const usedRemoved = new Set<number>();
    for (const candidate of candidates) {
      if (usedAdded.has(candidate.added) || usedRemoved.has(candidate.removed)) continue;
      usedAdded.add(candidate.added);
      usedRemoved.add(candidate.removed);
      pairs.set(group.added[candidate.added]!.path, group.removed[candidate.removed]!.path);
    }
  }
  return pairs;
}

function byPath(a: PairableFile, b: PairableFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function groupKey(file: PairableFile): string | null {
  if (!PAIRABLE_PATH.test(file.path) || file.flags.includes("binary")) return null;
  if (typeof file.textSample !== "string" || !file.textSample) return null;
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1).toLowerCase();
  // `.d.ts` and `.js` siblings share a directory but never a lineage.
  const extension = /(?:\.d)?\.[cm]?[jt]sx?$/.exec(name)?.[0] ?? "";
  return `${file.path.slice(0, slash + 1)}\u0000${extension}`;
}

// Statement-sized pieces (split at `;`, newline, `{`, `}`) hashed with 32-bit
// FNV-1a in one allocation-free pass. Whitespace is skipped, identifiers of up
// to three characters hash as one placeholder and digit runs as another, so a
// minifier re-mangling `a`/`b` or a bundler renumbering module ids does not
// read as different code.
function shingles(text: string): Set<number> {
  const set = new Set<number>();
  const length = text.length;
  let hash = FNV_OFFSET;
  let pieceLength = 0;
  let index = 0;
  while (index <= length) {
    const code = index < length ? text.charCodeAt(index) : 10;
    if (code === 59 || code === 10 || code === 123 || code === 125) {
      if (pieceLength >= 4) set.add(hash >>> 0);
      hash = FNV_OFFSET;
      pieceLength = 0;
      index += 1;
    } else if (isIdentifierStart(code)) {
      let end = index + 1;
      while (end < length && isIdentifierPart(text.charCodeAt(end))) end += 1;
      if (end - index <= 3) {
        hash = fnvMix(hash, 95);
        pieceLength += 1;
      } else {
        for (let at = index; at < end; at += 1) hash = fnvMix(hash, text.charCodeAt(at));
        pieceLength += end - index;
      }
      index = end;
    } else if (code >= 48 && code <= 57) {
      let end = index + 1;
      while (end < length && isDigit(text.charCodeAt(end))) end += 1;
      hash = fnvMix(hash, 48);
      pieceLength += 1;
      index = end;
    } else {
      if (code !== 32 && code !== 9 && code !== 13) {
        hash = fnvMix(hash, code);
        pieceLength += 1;
      }
      index += 1;
    }
  }
  return set;
}

const FNV_OFFSET = 0x811c9dc5;

function fnvMix(hash: number, code: number): number {
  return Math.imul(hash ^ code, 0x01000193);
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isIdentifierStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36;
}

function isIdentifierPart(code: number): boolean {
  return isIdentifierStart(code) || isDigit(code);
}
