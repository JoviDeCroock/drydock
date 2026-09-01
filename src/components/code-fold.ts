/**
 * Fold arithmetic for docs code blocks.
 *
 * Long snippets are the page's biggest space consumers, so anything past
 * `FOLD_MIN_LINES` renders collapsed to a short peek with the rest behind an
 * expander. Short snippets stay inline — folding a four-line command costs the
 * reader a click and saves nothing.
 */

export const FOLD_MIN_LINES = 14;
export const PEEK_LINES = 6;

export interface CodeFold {
  foldable: boolean;
  lineCount: number;
  peekText: string;
  peekLineCount: number;
  hiddenCount: number;
}

export function codeFold(source: string): CodeFold {
  const lines = source.replace(/\n+$/, "").split("\n");

  if (lines.length <= FOLD_MIN_LINES) {
    return {
      foldable: false,
      lineCount: lines.length,
      peekText: lines.join("\n"),
      peekLineCount: lines.length,
      hiddenCount: 0,
    };
  }

  return {
    foldable: true,
    lineCount: lines.length,
    peekText: lines.slice(0, PEEK_LINES).join("\n"),
    peekLineCount: PEEK_LINES,
    hiddenCount: lines.length - PEEK_LINES,
  };
}
