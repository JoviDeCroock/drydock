import { describe, expect, test } from "vitest";
import {
  buildRows,
  diffHashLines,
  isDiffScrollTarget,
  nativeBadge,
  shouldSeekInitialDiffTarget,
} from "../src/components/DiffView.tsx";

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

  test("leaves punctuation-only word diff spans unhighlighted", () => {
    const rows = buildRows("foo();\n", "foo(), {};\n", null, null, {
      wordDiff: true,
    });

    expect(rows[1].wordParts?.filter((part) => part.tone !== "unchanged")).toEqual([]);
  });

  test("splits punctuation out of changed word diff spans", () => {
    const rows = buildRows(
      "sub = wonka.subscribe(() => {\n",
      "stop = vue.watch([fetching, stale], ([isFetching, isStale]) => {\n",
      null,
      null,
      {
        wordDiff: true,
      },
    );

    const highlighted = rows[1].wordParts?.filter((part) => part.tone === "added") ?? [];

    expect(highlighted.every((part) => /^[\p{L}\p{N}_$]+$/u.test(part.text))).toBe(true);
    expect(rows[1].wordParts).toContainEqual({ text: "fetching", tone: "added" });
    expect(rows[1].wordParts).toContainEqual({ text: ", ", tone: "unchanged" });
    expect(rows[1].wordParts).toContainEqual({ text: "stale", tone: "added" });
  });

  test("does not word-highlight inserted comments against nearby code", () => {
    const rows = buildRows(
      "var promise = new Promise(resolve => {\nif (!source.value) {\n  return resolve(state);\n}\n",
      "var promise = new Promise(resolve => {\n// If there's no source, resolve without subscribing again.\n// See: https://github.com/urql-graphql/urql/issues/3722\nif (!source.value || !fetching.value && !stale.value) {\n  return resolve(state);\n}\n",
      null,
      null,
      {
        wordDiff: true,
      },
    );

    expect(rows.find((row) => row.afterLine === 2)?.wordParts).toBeNull();
    expect(rows.find((row) => row.afterLine === 3)?.wordParts).toBeNull();
    expect(rows.find((row) => row.afterLine === 4)?.wordParts).toContainEqual({
      text: "fetching",
      tone: "added",
    });
  });

  test("aligns changed block rows before applying word diff", () => {
    const rows = buildRows(
      "var hasResult = false;\nsub = wonka.subscribe(() => {\n  if (!state.fetching.value && !state.stale.value) {\n    if (sub) sub.unsubscribe();\n    hasResult = true;\n  }\n});\n",
      "var stop = vue.watch([fetching, stale], ([isFetching, isStale]) => {\n  if (!isFetching && !isStale) {\n    stop();\n  }\n});\n",
      null,
      null,
      {
        wordDiff: true,
      },
    );

    expect(rows.find((row) => row.beforeLine === 1)?.wordParts).toBeNull();
    expect(rows.find((row) => row.afterLine === 1)?.wordParts).toContainEqual({
      text: "watch",
      tone: "added",
    });
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

describe("diffHashLines", () => {
  test("surfaces the staged hash for a content-skipped binary", () => {
    expect(
      diffHashLines(
        null,
        { sha256: "abc123", flags: ["content-skipped", "native-elf"] },
        "previous",
        "staged (2.0.0)",
      ),
    ).toEqual(["sha256 (staged (2.0.0)): abc123"]);
  });

  test("collapses identical hashes to a single identity line", () => {
    const side = { sha256: "same-hash", flags: ["binary"] };
    expect(diffHashLines(side, { ...side }, "previous", "staged")).toEqual(["sha256 same-hash"]);
  });

  test("stays silent for text diffs and hashless legacy artifacts", () => {
    expect(
      diffHashLines(
        { sha256: "a", flags: [], textSample: "x" },
        { sha256: "b", flags: [], textSample: "y" },
        "previous",
        "staged",
      ),
    ).toEqual([]);
    expect(diffHashLines(null, { sha256: "", flags: ["content-skipped"] }, "p", "s")).toEqual([]);
  });
});

describe("nativeBadge", () => {
  test("maps parser magic flags to badge labels", () => {
    expect(nativeBadge({ flags: ["content-skipped", "native-elf"] })).toBe("elf binary");
    expect(nativeBadge({ flags: ["native-macho"] })).toBe("mach-o binary");
    expect(nativeBadge({ flags: ["native-pe"] })).toBe("pe binary");
    expect(nativeBadge({ flags: ["native-wasm"] })).toBe("wasm");
    expect(nativeBadge({ flags: ["binary"] })).toBe(null);
    expect(nativeBadge(null)).toBe(null);
  });
});

describe("initial diff scroll targeting", () => {
  test("seeks changed files and leaves unchanged files at the top", () => {
    expect(shouldSeekInitialDiffTarget("added")).toBe(true);
    expect(shouldSeekInitialDiffTarget("removed")).toBe(true);
    expect(shouldSeekInitialDiffTarget("modified")).toBe(true);
    expect(shouldSeekInitialDiffTarget("unchanged")).toBe(false);
  });

  test("targets only changed rows inside edited files", () => {
    expect(isDiffScrollTarget("modified", "unchanged")).toBe(false);
    expect(isDiffScrollTarget("modified", "removed")).toBe(true);
    expect(isDiffScrollTarget("modified", "added")).toBe(true);
    expect(isDiffScrollTarget("unchanged", "added")).toBe(false);
  });
});
