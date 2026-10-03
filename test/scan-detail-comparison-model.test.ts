import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  COMPARE_PICK_SETTLE_MS,
  ScanDetailModel,
  type PersistedScanDetail,
} from "../src/models/scan";
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

// Holds each compare request open until the test settles it, by version.
function stubHeldCompare() {
  const held = new Map<string, (response: Response) => void>();
  const fetchMock = stubFetchRoutes({
    "/compare": (url) => {
      const version = new URL(url, "http://localhost").searchParams.get("version") ?? "";
      return new Promise<Response>((resolve) => held.set(version, resolve));
    },
  });
  const compareRequests = (version: string) =>
    fetchMock.mock.calls.filter(([input]) => String(input).includes(`version=${version}`)).length;
  const settle = (version: string, response: Response) => {
    const resolve = held.get(version);
    if (!resolve) throw new Error(`no compare request held for ${version}`);
    held.delete(version);
    resolve(response);
  };
  return { compareRequests, settle };
}

function comparePayload(version: string) {
  return jsonResponse({ version, files: [], packageJson: null });
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

// A reader's pick is fetched once it has held for the settle delay.
function pick(model: ScanDetailModelInstance, version: string) {
  model.selectVersion(version);
  vi.advanceTimersByTime(COMPARE_PICK_SETTLE_MS);
}

describe("ScanDetailModel comparison while a payload loads", () => {
  let model: ScanDetailModelInstance | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    model?.[Symbol.dispose]();
    model = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("a payload that arrives after the reader moved on never stands in for the shown one", async () => {
    const compare = stubHeldCompare();
    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail("complete", STABLE_BASELINE);
    pick(model, NEWEST_RC);
    expect(model.compareLoading.value).toBe(true);

    model.selectVersion(STABLE_BASELINE);
    compare.settle(NEWEST_RC, comparePayload(NEWEST_RC));
    await vi.waitFor(() => expect(model?.compareCache.value[NEWEST_RC]).toBeDefined());

    expect(model.compareLoading.value).toBe(true);
    expect(model.compare.value).toBeNull();
    compare.settle(STABLE_BASELINE, comparePayload(STABLE_BASELINE));
    await vi.waitFor(() => expect(model?.compare.value?.version).toBe(STABLE_BASELINE));
    expect(model.compareLoading.value).toBe(false);
  });

  test("arrowing through versions fetches only the one the reader settles on", () => {
    const compare = stubHeldCompare();
    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail("complete", STABLE_BASELINE);

    model.selectVersion("11.0.0-rc.1");
    vi.advanceTimersByTime(COMPARE_PICK_SETTLE_MS / 2);
    pick(model, NEWEST_RC);

    expect(compare.compareRequests("11.0.0-rc.1")).toBe(0);
    expect(compare.compareRequests(NEWEST_RC)).toBe(1);
  });

  test("returning to a version still in flight does not fetch it again", async () => {
    const compare = stubHeldCompare();
    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail("complete", STABLE_BASELINE);
    pick(model, NEWEST_RC);
    model.selectVersion(STABLE_BASELINE);
    compare.settle(STABLE_BASELINE, comparePayload(STABLE_BASELINE));
    await vi.waitFor(() => expect(model?.compare.value?.version).toBe(STABLE_BASELINE));

    pick(model, NEWEST_RC);

    expect(model.compareLoading.value).toBe(true);
    expect(compare.compareRequests(NEWEST_RC)).toBe(1);
    compare.settle(NEWEST_RC, comparePayload(NEWEST_RC));
    await vi.waitFor(() => expect(model?.compare.value?.version).toBe(NEWEST_RC));
  });

  test("a failure for a version no longer shown is not reported", async () => {
    const compare = stubHeldCompare();
    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail("complete", STABLE_BASELINE);
    pick(model, NEWEST_RC);
    model.selectVersion(STABLE_BASELINE);

    // Settled first, so it has landed by the time the shown payload has.
    compare.settle(NEWEST_RC, jsonResponse({ error: "rate limited" }, 429));
    compare.settle(STABLE_BASELINE, comparePayload(STABLE_BASELINE));
    await vi.waitFor(() => expect(model?.compare.value?.version).toBe(STABLE_BASELINE));

    expect(model.compareFailure.value).toBeNull();
    expect(model.compareError.value).toBeNull();
    // Picking it again retries rather than replaying the old failure, which
    // is gone before the pick has settled.
    model.selectVersion(NEWEST_RC);
    expect(model.compareFailure.value).toBeNull();
    vi.advanceTimersByTime(COMPARE_PICK_SETTLE_MS);
    expect(model.compareLoading.value).toBe(true);
    expect(compare.compareRequests(NEWEST_RC)).toBe(2);
  });

  test("re-picking a failed version drops its old failure before the pick settles", async () => {
    stubVersionsAndCompare(STABLE_BASELINE, NEWEST_RC);
    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail("complete", STABLE_BASELINE);
    pick(model, NEWEST_RC);
    await vi.waitFor(() => expect(model?.compareFailure.value).toBe("unknown version"));
    model.selectVersion(STABLE_BASELINE);

    model.selectVersion(NEWEST_RC);

    expect(model.compareFailure.value).toBeNull();
  });

  test("retrying a failed comparison clears the failure and fetches it again", async () => {
    const fetchMock = stubVersionsAndCompare(STABLE_BASELINE, NEWEST_RC);
    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail("complete", STABLE_BASELINE);
    pick(model, NEWEST_RC);
    await vi.waitFor(() => expect(model?.compareFailure.value).toBe("unknown version"));

    model.retryComparison();

    expect(model.compareFailure.value).toBeNull();
    expect(model.compareLoading.value).toBe(true);
    const rcRequests = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes(`version=${NEWEST_RC}`),
    );
    expect(rcRequests).toHaveLength(2);
    await vi.waitFor(() => expect(model?.compareFailure.value).toBe("unknown version"));
  });

  test("loading a comparison does not clear a failed versions request", async () => {
    stubFetchRoutes({
      "/versions": () => jsonResponse({ error: "registry unavailable" }, 502),
      "/compare": () => comparePayload(STABLE_BASELINE),
    });
    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail("running", null);
    await model.loadVersions();
    expect(model.compareError.value).toBe("registry unavailable");

    model.detail.value = scanDetail("complete", STABLE_BASELINE);
    await vi.waitFor(() => expect(model?.compare.value?.version).toBe(STABLE_BASELINE));

    expect(model.compareError.value).toBe("registry unavailable");
  });
});
