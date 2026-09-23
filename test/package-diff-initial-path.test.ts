import { describe, expect, test } from "vitest";
import type { DiffEntry } from "../server/lib/review";
import { pickInitialPath } from "../src/models/package-diff";

const entry = (path: string, status: DiffEntry["status"]): DiffEntry => ({
  path,
  status,
  flags: [],
});

// The public diff opens its workbench on one file before the reader picks any,
// so the choice decides what the page leads with.
describe("pickInitialPath", () => {
  const entries = [
    entry("README.md", "modified"),
    entry("lib/index.js", "modified"),
    entry("package.json", "modified"),
    entry("postinstall.js", "added"),
    entry("vendor/util.js", "unchanged"),
  ];

  test("leads with the changed file carrying the most severe finding, ahead of the manifest", () => {
    expect(
      pickInitialPath(
        entries,
        [
          { file: "package.json", severity: "medium" },
          { file: "postinstall.js", severity: "high" },
        ],
        "npm",
      ),
    ).toBe("postinstall.js");
  });

  test("ignores package-context findings on unchanged files", () => {
    expect(
      pickInitialPath(entries, [{ file: "vendor/util.js", severity: "critical" }], "npm"),
    ).toBe("package.json");
  });

  test("falls back to the ecosystem's manifest, then status rank and path", () => {
    expect(pickInitialPath(entries, [], "npm")).toBe("package.json");
    // A vendored PKG-INFO is not an npm package's manifest.
    expect(
      pickInitialPath(
        [entry("vendor/PKG-INFO", "modified"), entry("b.js", "modified"), entry("a.js", "added")],
        [],
        "npm",
      ),
    ).toBe("a.js");
    expect(pickInitialPath([entry("pkg-1.0.dist-info/METADATA", "modified")], [], "pypi")).toBe(
      "pkg-1.0.dist-info/METADATA",
    );
  });

  test("opens nothing when no file changed", () => {
    expect(pickInitialPath([entry("a.js", "unchanged")], [], "npm")).toBe(null);
  });
});
