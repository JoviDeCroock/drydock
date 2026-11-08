// Characters that let free text leave the one line it is pasted into: C0/C1
// controls (CR, LF, TAB, …) and the Unicode line and paragraph separators.
const LINE_BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const LINE_BREAKING_ALL = new RegExp(LINE_BREAKING.source, "gu");
// Bidi embeddings, overrides, isolates, and marks reorder how the surrounding
// text renders; zero-width spaces, word joiners, and BOMs hide boundaries.
// ZWJ/ZWNJ stay: emoji sequences and several scripts need them.
const INVISIBLE_FORMATTING = /[؜​‎‏‪-‮⁠-⁤⁦-⁩﻿]/u;
const INVISIBLE_FORMATTING_ALL = new RegExp(INVISIBLE_FORMATTING.source, "gu");

/** Whether `value` holds a line break, control character, or bidi/invisible format control. */
export function hasLineBreakingOrInvisibleCharacters(value: string): boolean {
  return LINE_BREAKING.test(value) || INVISIBLE_FORMATTING.test(value);
}

/**
 * Flatten untrusted free text to one plain line for a context that trusts line
 * structure, such as a plain-text email body: format controls are dropped,
 * breaks and runs of whitespace become one space, and the result is trimmed
 * and capped at `maxLength` code points (never splitting a surrogate pair).
 */
export function toSingleLineText(value: string, maxLength: number): string {
  const flattened = value
    .replace(INVISIBLE_FORMATTING_ALL, "")
    .replace(LINE_BREAKING_ALL, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const codePoints = Array.from(flattened);
  if (codePoints.length <= maxLength) return flattened;
  return codePoints.slice(0, maxLength).join("").trimEnd();
}
