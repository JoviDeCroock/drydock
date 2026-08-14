import { describe, expect, test } from "vitest";
import {
  buildRows,
  diffHashLines,
  initialScrollResetKey,
  isDiffScrollTarget,
  nativeBadge,
  shouldSeekInitialDiffTarget,
} from "../src/components/DiffView";

describe("buildRows", () => {
  test("marks changed word spans inside paired changed lines", () => {
    const { rows } = buildRows('const label = "safe";\n', 'const label = "risky";\n', null, null, {
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
    const { rows } = buildRows("foo();\n", "foo(), {};\n", null, null, {
      wordDiff: true,
    });

    expect(rows[1].wordParts?.filter((part) => part.tone !== "unchanged")).toEqual([]);
  });

  test("splits punctuation out of changed word diff spans", () => {
    const { rows } = buildRows(
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
    const { rows } = buildRows(
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
    const { rows } = buildRows(
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

  test("skips word-diff decoration for huge changed blocks instead of going quadratic", () => {
    // Pairing scores every removed×added line combination, so a 150×150 block
    // (common in bundled artifacts) must bail out rather than run 22,500 word
    // diffs; line tones still render.
    const before = Array.from({ length: 150 }, (_, i) => `const before${i} = ${i};`).join("\n");
    const after = Array.from({ length: 150 }, (_, i) => `const after${i} = ${i};`).join("\n");
    const { rows } = buildRows(`${before}\n`, `${after}\n`, null, null, { wordDiff: true });

    expect(rows).toHaveLength(300);
    expect(rows.every((row) => row.wordParts === null)).toBe(true);
    expect(rows[0].tone).toBe("removed");
    expect(rows[150].tone).toBe("added");
  });

  test("strips CRLF carriage returns from rendered row text", () => {
    // shiki drops the \r when tokenizing, so a retained \r would make a CRLF
    // file render differently before and after the lazy highlighter loads.
    const { rows } = buildRows("const a = 1;\r\n", "const a = 2;\r\n", null, null, {});
    expect(rows.map((row) => row.text)).toEqual(["const a = 1;", "const a = 2;"]);
    expect(rows.some((row) => row.text.includes("\r"))).toBe(false);
  });

  test("treats whitespace-only line edits as unchanged with -w", () => {
    const { rows } = buildRows("const value=1;\n", "const value = 1;\n", null, null, {
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
    const { rows } = buildRows("const value = 1;\n", "const value = 2;\n", null, null, {
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

  // Reformatting a minified side turns a 1×1 comparison into a several-thousand
  // line one, so the pairing can run out of budget. A negative budget is already
  // spent before the first Myers iteration, which is the deterministic way to
  // reach the give-up path without staging a genuinely slow diff.
  const EXHAUSTED_BUDGET_MS = -1;

  test("defers row construction when line pairing runs out of budget", () => {
    const { rows, paired } = buildRows("a\nb\n", "c\nd\n", null, null, {
      timeoutMs: EXHAUSTED_BUDGET_MS,
    });

    expect(paired).toBe(false);
    expect(rows).toEqual([]);
  });

  test("gives up the same way with -w", () => {
    const { rows, paired } = buildRows("a\nb\n", "c\nd\n", null, null, {
      ignoreWhitespace: true,
      timeoutMs: EXHAUSTED_BUDGET_MS,
    });

    expect(paired).toBe(false);
    expect(rows).toEqual([]);
  });

  test("reports a real pairing as paired", () => {
    const { paired } = buildRows("a\nb\n", "a\nc\n", null, null, {});

    expect(paired).toBe(true);
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

  test("surfaces both hashes when the display samples were dropped from the cache", () => {
    expect(
      diffHashLines(
        { sha256: "before-hash", flags: ["sample-omitted"] },
        { sha256: "after-hash", flags: ["sample-omitted"] },
        "2.5.0",
        "2.5.1",
      ),
    ).toEqual(["sha256 (2.5.0): before-hash", "sha256 (2.5.1): after-hash"]);
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

  test("reset key changes with file identity and content, never with findings", () => {
    const key = initialScrollResetKey("lib/index.js", "modified", "before\n", "after\n");
    // Same file and content → same key; findings are not an input, so a
    // finding set arriving after render can never reset the scroll.
    expect(initialScrollResetKey("lib/index.js", "modified", "before\n", "after\n")).toBe(key);
    expect(initialScrollResetKey("lib/other.js", "modified", "before\n", "after\n")).not.toBe(key);
    expect(initialScrollResetKey("lib/index.js", "added", "before\n", "after\n")).not.toBe(key);
    expect(initialScrollResetKey("lib/index.js", "modified", "before\n", "after!\n")).not.toBe(key);
  });
});
