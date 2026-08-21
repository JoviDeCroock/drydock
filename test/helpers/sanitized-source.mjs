// Comment/string-aware source blanking for static invariant scans.
//
// Invariant tests that grep our own source for forbidden constructs must not
// trip on a comment that *mentions* the construct, a detection regex that
// *matches* it, or a string that merely contains it. The project's
// non-executing JS lexer already knows where those tokens start and end, so
// blank them out (preserving newlines, so reported line numbers stay true)
// and scan only what is actually code.

import { tokenizeJs } from "../../server/lib/platform/js-lexer";

/**
 * Return `source` with comment, template, and regex tokens blanked out, and
 * string tokens blanked unless `keepString(value)` returns true for the
 * string's decoded value (kept strings keep their original spelling).
 *
 * @param {string} source
 * @param {(value: string) => boolean} [keepString]
 */
export function sanitizeJsSource(source, keepString = () => false) {
  // Split by UTF-16 code units so indexes line up with token start/end offsets
  // even when the file contains astral characters.
  const chars = source.split("");
  for (const token of tokenizeJs(source, { sourceGoal: "module" })) {
    const blank =
      token.type === "comment" ||
      token.type === "template" ||
      token.type === "regex" ||
      (token.type === "string" && !keepString(token.value ?? ""));
    if (!blank) continue;
    for (let i = token.start; i < token.end; i++) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
  }
  return chars.join("");
}
