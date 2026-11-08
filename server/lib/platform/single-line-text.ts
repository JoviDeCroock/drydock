// Characters that let free text leave the one line it is pasted into: C0/C1
// controls (CR, LF, TAB, …) and the Unicode line and paragraph separators.
const LINE_BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const LINE_BREAKING_ALL = new RegExp(LINE_BREAKING.source, "gu");
// Text that renders as nothing or reorders its neighbors: every format control
// (bidi, zero-width, soft hyphen, tags, interlinear annotation, …) except
// ZWNJ/ZWJ, which emoji sequences and several scripts need, plus the
// combining grapheme joiner and the Hangul fillers, which draw as blanks.
const INVISIBLE = /(?![‌‍])\p{Cf}|[͏ᅟᅠㅤﾠ]/u;
// Tag characters are only visible inside a subdivision flag such as England's:
// a black flag, tag letters, and a cancel tag. Those sequences are kept whole.
const TAG_FLAG_SEQUENCE = /\u{1F3F4}[\u{E0020}-\u{E007E}]{1,32}\u{E007F}/u;
const TAG_FLAG_SEQUENCE_ALL = new RegExp(TAG_FLAG_SEQUENCE.source, "gu");
const TAG_FLAG_OR_INVISIBLE_ALL = new RegExp(
  `(${TAG_FLAG_SEQUENCE.source})|${INVISIBLE.source}`,
  "gu",
);
// Stacked combining marks draw over the lines around them.
const MAX_COMBINING_MARKS = 4;
const EXCESS_COMBINING_MARKS = new RegExp(`(\\p{M}{${MAX_COMBINING_MARKS}})\\p{M}+`, "gu");
// One grapheme can be arbitrarily long (a joiner chain, a jamo or virama run),
// so the grapheme cap alone bounds nothing; this bounds UTF-16 code units.
const CODE_UNITS_PER_GRAPHEME = 4;

const graphemes =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** Whether `value` holds a line break, control character, or invisible format character. */
export function hasLineBreakingOrInvisibleCharacters(value: string): boolean {
  return LINE_BREAKING.test(value) || INVISIBLE.test(value.replace(TAG_FLAG_SEQUENCE_ALL, ""));
}

/**
 * Flatten untrusted free text to one plain line for a context that trusts line
 * structure, such as a plain-text email body: invisible characters are
 * dropped (subdivision flags excepted), combining-mark runs capped, breaks and
 * runs of whitespace become one space, and the result is trimmed and cut at a
 * grapheme boundary so it holds at most `maxLength` graphemes and
 * `4 × maxLength` UTF-16 code units. Graphemes fall back to code points where
 * `Intl.Segmenter` is missing.
 */
export function toSingleLineText(value: string, maxLength: number): string {
  const flattened = value
    .replace(TAG_FLAG_OR_INVISIBLE_ALL, (_match, flag: string | undefined) => flag ?? "")
    .replace(LINE_BREAKING_ALL, " ")
    .replace(EXCESS_COMBINING_MARKS, "$1")
    .replace(/\s+/gu, " ")
    .trim();
  const maxCodeUnits = maxLength * CODE_UNITS_PER_GRAPHEME;
  const units = graphemes
    ? Array.from(graphemes.segment(flattened), (part) => part.segment)
    : Array.from(flattened);
  if (units.length <= maxLength && flattened.length <= maxCodeUnits) return flattened;
  let kept = "";
  for (const unit of units.slice(0, maxLength)) {
    if (kept.length + unit.length > maxCodeUnits) break;
    kept += unit;
  }
  return kept.trimEnd();
}
