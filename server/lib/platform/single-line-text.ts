// Characters that let free text leave the one line it is pasted into: C0/C1
// controls (CR, LF, TAB, …) and the Unicode line and paragraph separators.
const LINE_BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const LINE_BREAKING_ALL = new RegExp(LINE_BREAKING.source, "gu");
// Text that renders as nothing or reorders its neighbors: every format control
// (bidi, zero-width, soft hyphen, tags, interlinear annotation, …) except
// ZWNJ/ZWJ, which emoji sequences and several scripts need, plus the
// combining grapheme joiner and the Hangul fillers, which draw as blanks.
const INVISIBLE = /(?![‌‍])\p{Cf}|[͏ᅟᅠㅤﾠ]/u;
const INVISIBLE_ALL = new RegExp(INVISIBLE.source, "gu");
// Stacked combining marks draw over the lines around them.
const MAX_COMBINING_MARKS = 4;
const EXCESS_COMBINING_MARKS = new RegExp(`(\\p{M}{${MAX_COMBINING_MARKS}})\\p{M}+`, "gu");

const graphemes =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** Whether `value` holds a line break, control character, or invisible format character. */
export function hasLineBreakingOrInvisibleCharacters(value: string): boolean {
  return LINE_BREAKING.test(value) || INVISIBLE.test(value);
}

/**
 * Flatten untrusted free text to one plain line for a context that trusts line
 * structure, such as a plain-text email body: invisible characters are
 * dropped, combining-mark runs capped, breaks and runs of whitespace become one
 * space, and the result is trimmed and capped at `maxLength` graphemes, so an
 * emoji sequence is never cut mid-way (code points where `Intl.Segmenter` is
 * missing).
 */
export function toSingleLineText(value: string, maxLength: number): string {
  const flattened = value
    .replace(INVISIBLE_ALL, "")
    .replace(LINE_BREAKING_ALL, " ")
    .replace(EXCESS_COMBINING_MARKS, "$1")
    .replace(/\s+/gu, " ")
    .trim();
  const units = graphemes
    ? Array.from(graphemes.segment(flattened), (part) => part.segment)
    : Array.from(flattened);
  if (units.length <= maxLength) return flattened;
  return units.slice(0, maxLength).join("").trimEnd();
}
