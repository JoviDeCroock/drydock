import { describe, expect, test } from "vitest";
import { FOLD_MIN_LINES, PEEK_LINES, codeFold } from "../src/components/code-fold";

const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

describe("docs code fold", () => {
  test("keeps short snippets inline", () => {
    const fold = codeFold(lines(FOLD_MIN_LINES));

    expect(fold.foldable).toBe(false);
    expect(fold.lineCount).toBe(FOLD_MIN_LINES);
    expect(fold.peekText).toBe(lines(FOLD_MIN_LINES));
    expect(fold.hiddenCount).toBe(0);
  });

  test("folds a snippet past the threshold to a peek", () => {
    const fold = codeFold(lines(FOLD_MIN_LINES + 1));

    expect(fold.foldable).toBe(true);
    expect(fold.lineCount).toBe(FOLD_MIN_LINES + 1);
    expect(fold.peekText).toBe(lines(PEEK_LINES));
    expect(fold.peekLineCount).toBe(PEEK_LINES);
    expect(fold.hiddenCount).toBe(FOLD_MIN_LINES + 1 - PEEK_LINES);
  });

  test("ignores trailing newlines when measuring", () => {
    const fold = codeFold(`${lines(FOLD_MIN_LINES)}\n\n`);

    expect(fold.foldable).toBe(false);
    expect(fold.lineCount).toBe(FOLD_MIN_LINES);
    expect(fold.peekText).toBe(lines(FOLD_MIN_LINES));
  });

  test("pins the peek a workflow-sized snippet collapses to", () => {
    const fold = codeFold(lines(30));

    expect(fold).toEqual({
      foldable: true,
      lineCount: 30,
      peekText: lines(6),
      peekLineCount: 6,
      hiddenCount: 24,
    });
  });
});
