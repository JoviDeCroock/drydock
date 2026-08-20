// Turns a reviewer-supplied anchor — a line it copied verbatim out of the
// evidence it was shown — into a line number in the same text sample the
// evidence tools served.
//
// The model never states a line number. It cannot: `read` returns diff and file
// text with no numbering, so any number it produced would be counted from
// memory, and a mis-pinned finding is worse than an unpinned one (it points a
// maintainer at innocent code and quietly exonerates the guilty line). Matching
// a string it must have actually seen is the only claim we can check, so that is
// the only claim we accept.
//
// Every path out of here is fail-closed: an anchor that does not match, matches
// ambiguously, or is too generic to identify a line resolves to `null`, and the
// note falls back to the unpinned banner the diff already renders above the
// hunks.

// Below this many non-whitespace characters an anchor carries no identity —
// `}`, `});`, `"` and friends match dozens of lines in any real file, and the
// first of them is no likelier to be the intended one than any other.
const MIN_ANCHOR_SIGNAL_CHARS = 4;

/**
 * Resolve `anchor` to a 1-based line number in `text`, or null when it cannot
 * be pinned unambiguously.
 *
 * For each candidate, two passes over the whole file require a unique match:
 * line equality first (what a correctly copied anchor hits), then
 * line-contains-anchor (what an anchor clipped by the length bound hits).
 * Ambiguity is terminal before a weaker candidate is tried. Comparison is on
 * trimmed lines, because the reviewer reads text that has already been through
 * diff rendering and per-call truncation, so leading indentation is not
 * reliably preserved.
 *
 * Candidates try the anchor as given and, when it starts with a unified-diff
 * marker, the marker-stripped form: `read` serves changed files as `+`/`-`/space
 * prefixed diff text, so a faithfully copied anchor can carry a prefix that
 * appears nowhere in the file — while a line of source that genuinely begins
 * with `-` (a shell flag, a YAML list item) must still match itself. Trying the
 * literal form first keeps the genuine case exact and treats marker-stripping as
 * the fallback it is.
 */
export function resolveAnchorLine(
  text: string | null | undefined,
  anchor: string | null | undefined,
): number | null {
  const candidates = anchorCandidates(anchor);
  if (!candidates.length || !text) return null;

  const lines = text.split("\n").map((line) => line.trim());
  for (const candidate of candidates) {
    // Keep the most literal interpretation authoritative. If it is ambiguous,
    // trying a weaker marker-stripped or containment match can only manufacture
    // confidence: two `- value` lines plus one `value` line must not pin the
    // former anchor to the latter.
    const exact = matchLine(lines, (line) => line === candidate);
    if (exact.kind === "unique") return exact.line;
    if (exact.kind === "ambiguous") return null;

    const partial = matchLine(lines, (line) => line.includes(candidate));
    if (partial.kind === "unique") return partial.line;
    if (partial.kind === "ambiguous") return null;
  }
  return null;
}

/**
 * The forms of `anchor` worth searching for, most literal first, with anchors
 * too generic to identify a line rejected outright. Exported for tests.
 */
export function anchorCandidates(anchor: string | null | undefined): string[] {
  if (typeof anchor !== "string") return [];
  const trimmed = anchor.trim();
  const stripped = /^[+-]/.test(trimmed) ? trimmed.slice(1).trim() : "";
  return [trimmed, stripped].filter(
    (candidate, index, all) =>
      candidate.replace(/\s+/g, "").length >= MIN_ANCHOR_SIGNAL_CHARS &&
      all.indexOf(candidate) === index,
  );
}

type LineMatch = { kind: "none" } | { kind: "unique"; line: number } | { kind: "ambiguous" };

// Preserve ambiguity separately from a miss. Callers must not fall through to
// a weaker interpretation after the anchor already matched multiple lines.
function matchLine(lines: string[], predicate: (line: string) => boolean): LineMatch {
  let found: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (!predicate(lines[index])) continue;
    if (found !== null) return { kind: "ambiguous" };
    found = index + 1;
  }
  return found === null ? { kind: "none" } : { kind: "unique", line: found };
}
