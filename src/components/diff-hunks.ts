// Collapses runs of unchanged rows in a diff table into expandable gap rows,
// so a 36k-line bundle diff renders hundreds of DOM rows instead of tens of
// thousands. Pure so DiffView's table stays declarative and this stays
// unit-testable.

export const GAP_CONTEXT_LINES = 3;
// A run only collapses when it hides at least this many rows; below that the
// gap row costs as much space as the lines it would hide.
export const GAP_MIN_HIDDEN = 10;
// Rows revealed per edge per "show more" click, so one click grows context
// from both ends of the gap by this amount.
export const GAP_EXPAND_STEP = 100;

export interface HunkRowLike {
  tone: "added" | "removed" | "unchanged";
  afterLine: number | null;
}

export interface RowSegment {
  kind: "row";
  index: number;
}

export interface GapSegment {
  kind: "gap";
  key: string;
  hiddenCount: number;
}

export type DisplaySegment = RowSegment | GapSegment;

// `keepLines` are afterLine numbers that must stay visible (rows carrying
// pinned findings); a collapsed row can never hide a deterministic signal.
// `expansions` maps a gap key to how many rows each edge has revealed; keys
// embed `keyPrefix` so stale entries from a previously viewed file never
// collide with the current table.
export function buildDisplaySegments(
  rows: readonly HunkRowLike[],
  keepLines: ReadonlySet<number>,
  expansions: Readonly<Record<string, number>>,
  keyPrefix: string,
): DisplaySegment[] {
  const keep = Array.from({ length: rows.length }, () => false);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const anchored =
      row.tone !== "unchanged" || (row.afterLine !== null && keepLines.has(row.afterLine));
    if (!anchored) continue;
    const from = Math.max(0, index - GAP_CONTEXT_LINES);
    const to = Math.min(rows.length - 1, index + GAP_CONTEXT_LINES);
    for (let context = from; context <= to; context += 1) keep[context] = true;
  }

  const segments: DisplaySegment[] = [];
  let index = 0;
  while (index < rows.length) {
    if (keep[index]) {
      segments.push({ kind: "row", index });
      index += 1;
      continue;
    }
    let runEnd = index;
    while (runEnd < rows.length && !keep[runEnd]) runEnd += 1;
    const key = `${keyPrefix}:${index}`;
    const runLength = runEnd - index;
    const expanded = Math.min(expansions[key] ?? 0, Math.ceil(runLength / 2));
    const hiddenStart = index + expanded;
    const hiddenEnd = Math.max(hiddenStart, runEnd - expanded);
    if (hiddenEnd - hiddenStart < GAP_MIN_HIDDEN) {
      // Fully reveal residual gaps below the collapse floor: a gap row hiding
      // three lines is worse than the three lines.
      for (let row = index; row < runEnd; row += 1) segments.push({ kind: "row", index: row });
    } else {
      for (let row = index; row < hiddenStart; row += 1) segments.push({ kind: "row", index: row });
      segments.push({ kind: "gap", key, hiddenCount: hiddenEnd - hiddenStart });
      for (let row = hiddenEnd; row < runEnd; row += 1) segments.push({ kind: "row", index: row });
    }
    index = runEnd;
  }
  return segments;
}
