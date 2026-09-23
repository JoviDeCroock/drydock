import { describe, expect, test } from "vitest";
import { findingFirstPath } from "../src/features/review/initial-path";

const entries = [
  { path: "README.md", status: "modified" },
  { path: "index.js", status: "modified" },
  { path: "package.json", status: "modified" },
  { path: "secrets.txt", status: "added" },
  { path: "LICENSE", status: "unchanged" },
];

describe("findingFirstPath", () => {
  test("opens the changed file with the most severe finding, not the first change", () => {
    expect(
      findingFirstPath(entries, [
        { file: "package.json", severity: "high" },
        { file: "secrets.txt", severity: "critical" },
        { file: "index.js", severity: "low" },
      ]),
    ).toBe("secrets.txt");
  });

  test("ignores findings on unchanged or absent files", () => {
    expect(
      findingFirstPath(entries, [
        { file: "LICENSE", severity: "critical" },
        { file: "gone.js", severity: "critical" },
        { file: null, severity: "critical" },
        { file: "index.js", severity: "medium" },
      ]),
    ).toBe("index.js");
  });

  test("leaves the choice to the caller when no changed file has a finding", () => {
    expect(findingFirstPath(entries, [])).toBe(null);
    expect(findingFirstPath(entries, [{ file: "LICENSE", severity: "high" }])).toBe(null);
  });
});
