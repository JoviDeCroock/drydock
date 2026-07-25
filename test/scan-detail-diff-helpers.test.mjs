import { describe, expect, test } from "vitest";
import {
  annotatePersistedFindings,
  hasNoLoadableBodyFlags,
  scanFilesToFileRecords,
  selectDiffWorkbenchState,
} from "../src/pages/Dashboard/ScanDetail/diff-helpers.ts";

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

describe("hasNoLoadableBodyFlags", () => {
  test("treats binary and content-skipped files as unpreviewable", () => {
    expect(hasNoLoadableBodyFlags(["binary"])).toBe(true);
    expect(hasNoLoadableBodyFlags(["content-skipped"])).toBe(true);
    expect(hasNoLoadableBodyFlags(["truncated"])).toBe(false);
    expect(hasNoLoadableBodyFlags([])).toBe(false);
  });
});

describe("selectDiffWorkbenchState", () => {
  const base = {
    hasEntry: true,
    entryStatus: "modified",
    hasStagedMeta: true,
    hasStagedContent: true,
    stagedHasNoLoadableBody: false,
    hasPreviousMeta: true,
    hasPreviousContent: true,
    previousHasNoLoadableBody: false,
    compareReady: true,
    compareLoading: false,
  };

  test("prompts to pick a file when nothing is selected", () => {
    const state = selectDiffWorkbenchState({ ...base, hasEntry: false });
    expect(state).toEqual({ kind: "empty", message: "Select a file from the tree to diff." });
  });

  test("shows processing while the previous version is still fetching", () => {
    const state = selectDiffWorkbenchState({
      ...base,
      compareReady: false,
      hasPreviousMeta: false,
      hasPreviousContent: false,
    });
    expect(state.kind).toBe("processing");
    expect(state.title).toBe("Loading comparison");
  });

  test("stays in processing when a newer compare fetch is in flight over a stale cache", () => {
    const state = selectDiffWorkbenchState({ ...base, compareLoading: true });
    expect(state.kind).toBe("processing");
    expect(state.title).toBe("Loading comparison");
  });

  test("shows processing once the compare resolves but the file body is loading", () => {
    const state = selectDiffWorkbenchState({ ...base, hasPreviousContent: false });
    expect(state.kind).toBe("processing");
    expect(state.title).toBe("Loading file diff");
  });

  test("shows processing while staged file content is loading", () => {
    const state = selectDiffWorkbenchState({ ...base, hasStagedContent: false });
    expect(state.kind).toBe("processing");
    expect(state.title).toBe("Loading file diff");
  });

  test("renders the diff for an added file without waiting on a previous version", () => {
    const state = selectDiffWorkbenchState({
      ...base,
      entryStatus: "added",
      compareReady: false,
      hasPreviousMeta: false,
      hasPreviousContent: false,
    });
    expect(state).toEqual({ kind: "diff" });
  });

  test("renders the diff for an unpreviewable staged file instead of waiting on its body", () => {
    const state = selectDiffWorkbenchState({
      ...base,
      hasStagedContent: false,
      stagedHasNoLoadableBody: true,
    });
    expect(state).toEqual({ kind: "diff" });
  });

  test("renders the diff for an unpreviewable previous file instead of waiting on its body", () => {
    const state = selectDiffWorkbenchState({
      ...base,
      previousHasNoLoadableBody: true,
      hasPreviousContent: false,
    });
    expect(state).toEqual({ kind: "diff" });
  });

  test("renders an unchanged file without a comparison fetch", () => {
    const state = selectDiffWorkbenchState({
      ...base,
      entryStatus: "unchanged",
      compareReady: false,
      hasPreviousMeta: false,
      hasPreviousContent: false,
    });
    expect(state).toEqual({ kind: "diff" });
  });

  test("reports no content when neither side has anything to show", () => {
    const state = selectDiffWorkbenchState({
      ...base,
      entryStatus: "unchanged",
      hasStagedMeta: false,
      hasStagedContent: false,
      hasPreviousMeta: false,
      hasPreviousContent: false,
    });
    expect(state).toEqual({ kind: "empty", message: "No file content available." });
  });

  test("renders the diff once both sides are ready", () => {
    expect(selectDiffWorkbenchState(base)).toEqual({ kind: "diff" });
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
