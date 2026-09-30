import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ScanDetailModel, type PersistedScanDetail } from "../src/models/scan";
import { jsonResponse, stubFetchRoutes } from "./helpers/fetch-stub";

type ScanDetailModelInstance = InstanceType<typeof ScanDetailModel>;

// A stable release cut after release candidates: the staged `latest` tag makes
// the pipeline diff against the old stable, while the semver predecessor the
// versions endpoint guesses before the scan records a baseline is the newest rc.
const STABLE_BASELINE = "10.29.8";
const NEWEST_RC = "11.0.0-rc.2";

function scanDetail(
  status: "running" | "complete",
  previousVersion: string | null,
): PersistedScanDetail {
  return {
    scan: {
      id: "scan-1",
      stageId: "stage-1",
      packageName: "preact",
      stagedVersion: "11.0.0",
      previousVersion,
      risk: "none",
      status,
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
    },
    files: [],
    findings: [],
    events: [],
  };
}

function stubVersionsAndCompare(defaultPreviousVersion: string | null) {
  return stubFetchRoutes({
    "/versions": () =>
      jsonResponse({
        packageName: "preact",
        stagedVersion: "11.0.0",
        defaultPreviousVersion,
        versions: [
          { version: NEWEST_RC, distTags: ["rc"] },
          { version: "11.0.0-rc.1", distTags: [] },
          { version: STABLE_BASELINE, distTags: [] },
        ],
      }),
    "/compare": (url) =>
      jsonResponse({
        version: new URL(url, "http://localhost").searchParams.get("version"),
        files: [],
        packageJson: null,
      }),
  });
}

describe("ScanDetailModel comparison default", () => {
  let model: ScanDetailModelInstance | null = null;

  beforeEach(() => {
    // Running details start the poll chain; fake timers keep it from firing.
    vi.useFakeTimers();
  });

  afterEach(() => {
    model?.[Symbol.dispose]();
    model = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("moves a selection made while the scan ran onto the baseline it records", async () => {
    stubVersionsAndCompare(NEWEST_RC);
    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail("running", null);
    await model.loadVersions();
    expect(model.selectedVersion.value).toBe(NEWEST_RC);

    model.detail.value = scanDetail("complete", STABLE_BASELINE);

    expect(model.selectedVersion.value).toBe(STABLE_BASELINE);
    expect(model.defaultPreviousVersion.value).toBe(STABLE_BASELINE);
    expect(model.isDefaultComparison.value).toBe(true);
  });

  test("treats a version other than the recorded baseline as a live comparison", async () => {
    stubVersionsAndCompare(STABLE_BASELINE);
    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail("complete", STABLE_BASELINE);
    await model.loadVersions();
    expect(model.isDefaultComparison.value).toBe(true);

    model.selectVersion(NEWEST_RC);

    expect(model.isDefaultComparison.value).toBe(false);
    expect(model.defaultPreviousVersion.value).toBe(STABLE_BASELINE);
  });

  test("never labels the endpoint's stale guess as the default once a baseline exists", async () => {
    // The versions payload fetched mid-scan is kept for the page's lifetime.
    stubVersionsAndCompare(NEWEST_RC);
    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail("running", null);
    await model.loadVersions();
    model.selectVersion(NEWEST_RC);
    model.detail.value = scanDetail("complete", STABLE_BASELINE);
    model.selectVersion(NEWEST_RC);

    expect(model.defaultPreviousVersion.value).toBe(STABLE_BASELINE);
    expect(model.isDefaultComparison.value).toBe(false);
  });

  test("keeps the old guess when the reader picks it after the scan completes", async () => {
    stubVersionsAndCompare(NEWEST_RC);
    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail("running", null);
    await model.loadVersions();
    model.detail.value = scanDetail("complete", STABLE_BASELINE);
    model.selectVersion(NEWEST_RC);

    // A decision save or claim change replaces the detail wholesale.
    model.detail.value = scanDetail("complete", STABLE_BASELINE);

    expect(model.selectedVersion.value).toBe(NEWEST_RC);
    expect(model.isDefaultComparison.value).toBe(false);
  });

  test("keeps a version the reader chose while the scan ran", async () => {
    stubVersionsAndCompare(NEWEST_RC);
    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail("running", null);
    await model.loadVersions();
    model.selectVersion("11.0.0-rc.1");

    model.detail.value = scanDetail("complete", STABLE_BASELINE);

    expect(model.selectedVersion.value).toBe("11.0.0-rc.1");
    expect(model.isDefaultComparison.value).toBe(false);
  });

  test("judges a linked version against the recorded baseline before versions load", () => {
    stubVersionsAndCompare(STABLE_BASELINE);
    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail("complete", STABLE_BASELINE);
    expect(model.isDefaultComparison.value).toBe(true);

    // A `?version=` link restores the selection before the versions request lands.
    model.selectVersion(NEWEST_RC);

    expect(model.isDefaultComparison.value).toBe(false);
  });
});
