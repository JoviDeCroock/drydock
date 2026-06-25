import { describe, expect, test } from "vitest";
import { buildRows } from "../src/components/DiffView.tsx";

describe("buildRows", () => {
  test("marks changed word spans inside paired changed lines", () => {
    const rows = buildRows('const label = "safe";\n', 'const label = "risky";\n', null, null, {
      wordDiff: true,
    });

    expect(rows).toMatchObject([
      { tone: "removed", beforeLine: 1, afterLine: null },
      { tone: "added", beforeLine: null, afterLine: 1 },
    ]);
    expect(rows[0].wordParts).toContainEqual({ text: "safe", tone: "removed" });
    expect(rows[1].wordParts).toContainEqual({ text: "risky", tone: "added" });
  });

  test("treats whitespace-only line edits as unchanged with -w", () => {
    const rows = buildRows("const value=1;\n", "const value = 1;\n", null, null, {
      ignoreWhitespace: true,
    });

    expect(rows).toMatchObject([
      {
        tone: "unchanged",
        beforeLine: 1,
        afterLine: 1,
        text: "const value = 1;",
      },
    ]);
  });

  test("keeps non-whitespace edits visible when -w is enabled", () => {
    const rows = buildRows("const value = 1;\n", "const value = 2;\n", null, null, {
      ignoreWhitespace: true,
      wordDiff: true,
    });

    expect(rows).toMatchObject([
      { tone: "removed", beforeLine: 1, afterLine: null },
      { tone: "added", beforeLine: null, afterLine: 1 },
    ]);
    expect(rows[0].wordParts).toContainEqual({ text: "1", tone: "removed" });
    expect(rows[1].wordParts).toContainEqual({ text: "2", tone: "added" });
  });
});
