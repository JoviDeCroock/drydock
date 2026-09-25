import { describe, expect, test } from "vitest";
import {
  CHANGED_SPAN_MARGIN,
  changedRegions,
  patternsTouchChangedRegions,
} from "../server/lib/review/changed-regions";

const bundle = (version, extra = "") =>
  `var a=${"x".repeat(3000)};function p(){return fetch("/api")};var v="${version}";${"y".repeat(3000)}${extra}\n`;

describe("changed regions", () => {
  test("keeps ordinary changed lines whole", () => {
    const regions = changedRegions("a\nb\nc\n", "a\nB\nc\nd\n");
    expect([...regions.lines]).toEqual([2, 4]);
    expect(regions.spans).toEqual([]);
  });

  test("narrows a long replaced line to the characters that changed", () => {
    const previous = bundle("4.26.1");
    const staged = bundle("4.26.2");
    const regions = changedRegions(previous, staged);

    expect([...regions.lines]).toEqual([]);
    expect([...regions.refinedLines]).toEqual([1]);
    expect(regions.spans).toHaveLength(1);
    expect(staged.slice(regions.spans[0].start, regions.spans[0].end)).toBe("2");
  });

  test("counts a rule match only within the margin of a changed span", () => {
    const staged = bundle("4.26.2");
    const regions = changedRegions(bundle("4.26.1"), staged);

    // `fetch(` sits right before the version string, inside the margin.
    expect(patternsTouchChangedRegions(staged, regions, [/fetch\(/])).toBe(true);
    const far = `${"z".repeat(CHANGED_SPAN_MARGIN * 4)}${staged}`;
    const farRegions = changedRegions(
      `${"z".repeat(CHANGED_SPAN_MARGIN * 4)}${bundle("4.26.1")}`,
      far,
    );
    expect(patternsTouchChangedRegions(far, farRegions, [/z{4}fetch/])).toBe(false);
  });

  test("finds an appended payload in a minified line", () => {
    const staged = bundle("1.0.0", ';require("https").get("https://example.invalid/c")');
    const regions = changedRegions(bundle("1.0.0"), staged);

    expect(patternsTouchChangedRegions(staged, regions, [/require\("https"\)/])).toBe(true);
  });

  test("narrows scattered edits inside a large middle with a bounded character diff", () => {
    const middle = "m".repeat(10_000);
    const previous = `${"p".repeat(2000)}A${middle}B${"s".repeat(2000)}\n`;
    const staged = `${"p".repeat(2000)}X${middle}Y${"s".repeat(2000)}\n`;
    const regions = changedRegions(previous, staged);

    expect(
      regions.spans
        .filter((span) => span.end > span.start)
        .map((span) => staged.slice(span.start, span.end)),
    ).toEqual(["X", "Y"]);
  });

  test("falls back to the whole middle when the edit budget is exceeded", () => {
    // A hundred scattered substitutions: far past the edit budget.
    const middle = "x".repeat(10_000);
    const scattered = [...middle].map((char, index) => (index % 100 === 50 ? "y" : char)).join("");
    const previous = `${"p".repeat(2000)}A${middle}B${"s".repeat(2000)}\n`;
    const staged = `${"p".repeat(2000)}C${scattered}D${"s".repeat(2000)}\n`;
    const regions = changedRegions(previous, staged);

    expect(regions.spans).toHaveLength(1);
    expect(regions.spans[0].end - regions.spans[0].start).toBeGreaterThan(9000);
  });
});
