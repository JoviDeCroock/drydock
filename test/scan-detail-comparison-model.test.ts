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

function stubVersionsAndCompare(
  defaultPreviousVersion: string | null,
  failCompareFor: string | null = null,
) {
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
    "/compare": (url) => {
      const version = new URL(url, "http://localhost").searchParams.get("version");
      if (version === failCompareFor) return jsonResponse({ error: "unknown version" }, 404);
      return jsonResponse({ version, files: [], packageJson: null });
    },
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

  test("follows the baseline a running scan records, never the endpoint's guess", async () => {
    const fetchMock = stubVersionsAndCompare(NEWEST_RC);
    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail("running", null);
    await model.loadVersions();

    expect(model.comparisonVersion.value).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/compare"))).toBe(false);

    model.detail.value = scanDetail("complete", STABLE_BASELINE);

    expect(model.selectedVersion.value).toBeNull();
    expect(model.comparisonVersion.value).toBe(STABLE_BASELINE);
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

    expect(model.comparisonVersion.value).toBe(NEWEST_RC);
    expect(model.isDefaultComparison.value).toBe(false);
  });

  test("picking the recorded baseline follows the default instead of pinning it", () => {
    stubVersionsAndCompare(STABLE_BASELINE);
    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail("complete", STABLE_BASELINE);
    model.selectVersion(NEWEST_RC);

    model.selectVersion(STABLE_BASELINE);

    expect(model.selectedVersion.value).toBeNull();
    expect(model.isDefaultComparison.value).toBe(true);
  });

  test("keeps a reader's pick through a detail refresh", async () => {
    stubVersionsAndCompare(NEWEST_RC);
    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail("complete", STABLE_BASELINE);
    await model.loadVersions();
    model.selectVersion(NEWEST_RC);

    // A decision save or claim change replaces the detail wholesale.
    model.detail.value = scanDetail("complete", STABLE_BASELINE);

    expect(model.comparisonVersion.value).toBe(NEWEST_RC);
    expect(model.isDefaultComparison.value).toBe(false);
  });

  test("a scan that recorded no baseline compares against nothing by default", async () => {
    const fetchMock = stubVersionsAndCompare(NEWEST_RC);
    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail("complete", null);
    await model.loadVersions();

    expect(model.defaultPreviousVersion.value).toBeNull();
    expect(model.comparisonVersion.value).toBeNull();
    expect(model.isDefaultComparison.value).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/compare"))).toBe(false);

    model.selectVersion(NEWEST_RC);
    expect(model.isDefaultComparison.value).toBe(false);

    model.selectVersion(null);
    expect(model.comparisonVersion.value).toBeNull();
  });

  test("judges a linked version against the recorded baseline before versions load", () => {
    stubVersionsAndCompare(STABLE_BASELINE);
    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail("complete", STABLE_BASELINE);
    expect(model.isDefaultComparison.value).toBe(true);

    // A `?version=` link restores the selection before the versions request lands.
    model.selectedVersion.value = NEWEST_RC;

    expect(model.isDefaultComparison.value).toBe(false);
  });

  test("records a failed comparison against the version it was for", async () => {
    stubVersionsAndCompare(STABLE_BASELINE, NEWEST_RC);
    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail("complete", STABLE_BASELINE);
    model.selectVersion(NEWEST_RC);
    await vi.waitFor(() => expect(model?.compareFailure.value).toBe("unknown version"));

    model.selectVersion(STABLE_BASELINE);

    expect(model.compareFailure.value).toBeNull();
  });
});
