import { afterEach, describe, expect, test, vi } from "vitest";
import { formatCompactDuration, overviewTiles } from "../src/features/overview/tiles";
import { setActiveOrganizationId } from "../src/models/active-organization";
import { ScanOverviewModel, type ScanOverview } from "../src/models/scan-overview";

type ScanOverviewModelInstance = InstanceType<typeof ScanOverviewModel>;

let model: ScanOverviewModelInstance | null = null;

const NOW = Date.parse("2026-09-04T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

function overview(partial: Partial<ScanOverview> = {}): ScanOverview {
  return {
    totalScans: 12,
    windowDays: 30,
    waiting: { count: 3, oldestCompletedAt: new Date(NOW - 5 * HOUR_MS).toISOString() },
    validating: { count: 2, reviewReady: 1 },
    publishedWithoutDecision: { count: 1 },
    decided: { count: 6, approved: 5, rejected: 1, medianDecisionMs: 42 * 60 * 1000 },
    ...partial,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ScanOverviewModel", () => {
  afterEach(() => {
    model?.[Symbol.dispose]();
    model = null;
    setActiveOrganizationId(null);
    vi.unstubAllGlobals();
  });

  test("loads the overview and clears a previous error", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(overview())));
    vi.stubGlobal("fetch", fetchMock);
    model = new ScanOverviewModel();
    model.error.value = "stale";

    await model.refresh();

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/scans/overview", expect.anything());
    expect(model.overview.value?.waiting.count).toBe(3);
    expect(model.error.value).toBeNull();
    expect(model.loaded.value).toBe(true);
    expect(model.refreshing.value).toBe(false);
  });

  test("records a failed load without dropping the figures already shown", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(overview()))
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: "boom" }), { status: 500 })),
    );
    model = new ScanOverviewModel();

    await model.refresh();
    await model.refresh();

    expect(model.error.value).toBe("boom");
    expect(model.overview.value?.totalScans).toBe(12);
    expect(model.loaded.value).toBe(true);
  });

  test("shares one in-flight request between concurrent callers", async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);
    model = new ScanOverviewModel();

    const first = model.refresh();
    const second = model.refresh();
    expect(second).toBe(first);
    response.resolve(jsonResponse(overview()));
    await first;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("discards an answer that arrives after the organization switched", async () => {
    const response = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(response.promise)
        .mockResolvedValue(jsonResponse(overview({ totalScans: 1 }))),
    );
    setActiveOrganizationId("org-a");
    model = new ScanOverviewModel();

    const stale = model.refresh();
    setActiveOrganizationId("org-b");
    const fresh = model.refresh();
    response.resolve(jsonResponse(overview({ totalScans: 99 })));
    await Promise.all([stale, fresh]);

    expect(model.overview.value?.totalScans).toBe(1);
    expect(model.loaded.value).toBe(true);
  });
});

describe("overviewTiles", () => {
  test("turns the aggregate into four filter-linked calls to action", () => {
    const tiles = overviewTiles(overview(), NOW);
    expect(tiles.map((tile) => [tile.id, tile.value, tile.detail, tile.filter])).toEqual([
      ["waiting", "3", "oldest 5h · decide before approving", "undecided"],
      ["validating", "2", "1 of 2 Drydock reviews ready first", "undecided"],
      ["published", "1", "went live unreviewed · 30d", "published_without_decision"],
      ["decided", "6", "5 approved · 1 rejected · median 42m", "all"],
    ]);
  });

  test("describes empty tiles as states, not promises", () => {
    const tiles = overviewTiles(
      overview({
        waiting: { count: 0, oldestCompletedAt: null },
        validating: { count: 0, reviewReady: 0 },
        publishedWithoutDecision: { count: 0 },
        decided: { count: 0, approved: 0, rejected: 0, medianDecisionMs: null },
      }),
      NOW,
    );
    expect(tiles.map((tile) => tile.detail)).toEqual([
      "nothing to decide",
      "nothing in npm validation",
      "none in 30d",
      "no decisions yet",
    ]);
  });

  test("omits the median when no decision carried a completion time", () => {
    const [, , , decided] = overviewTiles(
      overview({ decided: { count: 2, approved: 2, rejected: 0, medianDecisionMs: null } }),
      NOW,
    );
    expect(decided?.detail).toBe("2 approved · 0 rejected");
  });

  test("formats durations compactly and never negative", () => {
    expect(formatCompactDuration(-5)).toBe("<1m");
    expect(formatCompactDuration(30 * 1000)).toBe("<1m");
    expect(formatCompactDuration(59 * 60 * 1000)).toBe("59m");
    expect(formatCompactDuration(47 * HOUR_MS)).toBe("47h");
    expect(formatCompactDuration(48 * HOUR_MS)).toBe("2d");
  });
});
