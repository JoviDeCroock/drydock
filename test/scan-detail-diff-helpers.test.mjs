import { describe, expect, test } from "vitest";
import {
  annotatePersistedFindings,
  filterDiffEntries,
  scanFilesToFileRecords,
} from "../src/pages/Dashboard/ScanDetail/diff-helpers.ts";

describe("filterDiffEntries", () => {
  const entries = [
    { path: "z.js", status: "unchanged" },
    { path: "a.js", status: "added" },
    { path: "m.js", status: "modified" },
    { path: "b.js", status: "added" },
  ];

  test("drops unchanged entries and sorts by status rank then path", () => {
    const out = filterDiffEntries(entries, "", true).map((e) => e.path);
    expect(out).toEqual(["a.js", "b.js", "m.js"]);
  });

  test("keeps unchanged entries when changedOnly is false", () => {
    const out = filterDiffEntries(entries, "", false).map((e) => e.path);
    expect(out).toEqual(["a.js", "b.js", "m.js", "z.js"]);
  });

  test("filters by case-insensitive path substring", () => {
    const out = filterDiffEntries(entries, "M", true).map((e) => e.path);
    expect(out).toEqual(["m.js"]);
  });
});

describe("scanFilesToFileRecords", () => {
  test("maps persisted files and defaults missing size/sha/flags", () => {
    const records = scanFilesToFileRecords([
      {
        path: "x.js",
        status: "added",
        size: 5,
        sha256: "abc",
        flagsJson: ["binary"],
        textSample: "hi",
      },
      {
        path: "y.js",
        status: "modified",
        size: null,
        sha256: null,
        flagsJson: null,
        textSample: null,
      },
    ]);

    expect(records[0]).toEqual({
      path: "x.js",
      size: 5,
      sha256: "abc",
      textSample: "hi",
      flags: ["binary"],
    });
    expect(records[1]).toEqual({
      path: "y.js",
      size: 0,
      sha256: "",
      textSample: undefined,
      flags: [],
    });
  });
});

describe("annotatePersistedFindings", () => {
  const finding = {
    id: "f1",
    scanId: "s1",
    file: "a.js",
    severity: "high",
    evidence: "",
    reason: "",
    source: "deterministic",
  };
  const diff = [{ path: "a.js", status: "added" }];

  test("uses supplied compare annotations keyed by finding id", () => {
    const out = annotatePersistedFindings(
      [finding],
      diff,
      false,
      [],
      [],
      [{ id: "f1", diffStatus: "modified", releaseDelta: false }],
    );

    expect(out[0].diffStatus).toBe("modified");
    expect(out[0].releaseDelta).toBe(false);
    expect(out[0].finding.file).toBe("a.js");
  });

  test("derives status from the diff when no persisted annotations exist", () => {
    const out = annotatePersistedFindings([finding], diff, false, [], [], undefined);

    expect(out[0].diffStatus).toBe("added");
    expect(out[0].releaseDelta).toBe(true);
  });

  test("prefers the finding's own persisted status on the default comparison", () => {
    const persistedFinding = { ...finding, diffStatus: "unchanged", releaseDelta: false };
    const out = annotatePersistedFindings([persistedFinding], diff, true, [], [], undefined);

    expect(out[0].diffStatus).toBe("unchanged");
    expect(out[0].releaseDelta).toBe(false);
  });
});
