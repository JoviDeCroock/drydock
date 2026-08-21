import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ScanListModel,
  scanMatchesDecisionFilter,
  type PersistedScanDetail,
} from "../src/models/scan";
import { ACTIVE_ORG_HEADER, setActiveOrganizationId } from "../src/models/active-organization";

type ScanListModelInstance = InstanceType<typeof ScanListModel>;

let model: ScanListModelInstance | null = null;

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

function scanDetail(decision: "publish" | "no_publish" | null): PersistedScanDetail {
  return {
    scan: {
      id: "scan-1",
      stageId: "stage-1",
      packageName: "left-pad",
      stagedVersion: "1.0.1",
      previousVersion: "1.0.0",
      risk: "none",
      status: "complete",
      decision,
      decisionReason: "reviewed",
      createdAt: "2026-06-21T00:00:00.000Z",
      updatedAt: "2026-06-21T00:00:00.000Z",
    },
    riskSummary: {
      artifactRisk: "none",
      releaseRisk: "none",
      contextRisk: "none",
      releaseFindingCount: 0,
      contextFindingCount: 0,
      unknownFindingCount: 0,
    },
    files: [],
    findings: [],
    events: [],
  };
}

describe("ScanListModel decisions", () => {
  afterEach(() => {
    model?.[Symbol.dispose]();
    model = null;
    vi.unstubAllGlobals();
  });

  test("filters a decided scan out of the default undecided list", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(scanDetail("publish"))));
    vi.stubGlobal("fetch", fetchMock);

    model = new ScanListModel();
    model.scans.value = [scanDetail(null).scan];
    model.filter.value = "undecided";

    await model.setDecision("scan-1", "publish", "reviewed");

    expect(model.decisionStatus.value).toBe("idle");
    expect(model.scans.value).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/scans/scan-1/decision",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ decision: "publish", reason: "reviewed" }),
      }),
    );
  });

  test("keeps an updated decided scan in the all list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(scanDetail("no_publish")))),
    );

    model = new ScanListModel();
    model.scans.value = [scanDetail(null).scan];
    model.filter.value = "all";

    await model.setDecision("scan-1", "no_publish", "reviewed");

    expect(model.scans.value).toHaveLength(1);
    expect(model.scans.value[0]?.decision).toBe("no_publish");
    expect(model.scans.value[0]?.riskSummary?.releaseRisk).toBe("none");
  });
});

describe("ScanListModel deletion", () => {
  afterEach(() => {
    model?.[Symbol.dispose]();
    model = null;
    vi.unstubAllGlobals();
  });

  test("removes a failed scan after the delete request succeeds", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ ok: true, id: "scan-1" })));
    vi.stubGlobal("fetch", fetchMock);

    model = new ScanListModel();
    model.scans.value = [{ ...scanDetail(null).scan, status: "failed" }];

    await expect(model.deleteFailed("scan-1")).resolves.toBe(true);

    expect(model.deleteStatus.value).toBe("idle");
    expect(model.scans.value).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/scans/scan-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  test("keeps the scan and exposes the server error when deletion is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "only failed scans can be deleted" }), {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );

    model = new ScanListModel();
    model.scans.value = [scanDetail(null).scan];

    await expect(model.deleteFailed("scan-1")).resolves.toBe(false);

    expect(model.deleteStatus.value).toBe("error");
    expect(model.deleteError.value).toBe("only failed scans can be deleted");
    expect(model.scans.value).toHaveLength(1);
  });
});

describe("scanMatchesDecisionFilter", () => {
  test("matches dashboard decision filter semantics", () => {
    expect(scanMatchesDecisionFilter({ decision: null }, "undecided")).toBe(true);
    expect(scanMatchesDecisionFilter({ decision: "publish" }, "undecided")).toBe(false);
    expect(scanMatchesDecisionFilter({ decision: "publish" }, "publish")).toBe(true);
    expect(scanMatchesDecisionFilter({ decision: "no_publish" }, "publish")).toBe(false);
    expect(scanMatchesDecisionFilter({ decision: "no_publish" }, "all")).toBe(true);
  });
});

describe("ScanListModel hasAnyScan", () => {
  afterEach(() => {
    model?.[Symbol.dispose]();
    model = null;
    vi.unstubAllGlobals();
  });

  function listResponse(scans: unknown[]) {
    return jsonResponse({ scans, nextCursor: null });
  }

  test("a non-empty page settles the question without a second request", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(listResponse([scanDetail(null).scan])));
    vi.stubGlobal("fetch", fetchMock);

    model = new ScanListModel();
    await model.refresh();

    expect(model.hasAnyScan.value).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("an empty undecided page probes 'all' before concluding", async () => {
    // A maintainer who has decided every review looks identical to one who has
    // never scanned, on the default filter. Only the second gets onboarding.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(listResponse([scanDetail("publish").scan]));
    vi.stubGlobal("fetch", fetchMock);

    model = new ScanListModel();
    await model.refresh();

    expect(model.hasAnyScan.value).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("filter=all");
  });

  test("concludes false only when the probe also comes back empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(listResponse([]))),
    );

    model = new ScanListModel();
    await model.refresh();

    expect(model.hasAnyScan.value).toBe(false);
  });

  test("does not carry a stale answer across an organization switch", async () => {
    // Regression: `hasAnyScan` latched `true` on first resolution, so switching
    // to a brand-new organization hid its getting-started panel. `refresh` runs
    // on every switch, so it must re-resolve rather than keep the old answer.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(listResponse([scanDetail(null).scan]))
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(listResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    model = new ScanListModel();
    await model.refresh();
    expect(model.hasAnyScan.value).toBe(true);

    await model.refresh(); // the switched-to organization
    expect(model.hasAnyScan.value).toBe(false);
  });

  test("stays unknown when the probe fails, so nothing renders on a guess", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(listResponse([]))
      .mockRejectedValueOnce(new Error("network"));
    vi.stubGlobal("fetch", fetchMock);

    model = new ScanListModel();
    await model.refresh();

    expect(model.hasAnyScan.value).toBe(null);
  });
});

describe("ScanListModel hasAnyScan after deletion", () => {
  afterEach(() => {
    model?.[Symbol.dispose]();
    model = null;
    vi.unstubAllGlobals();
  });

  test("deleting the only scan brings back the never-scanned state", async () => {
    // Regression: `deleteFailed` emptied the list without touching
    // `hasAnyScan`, so an organization whose single failed scan was deleted
    // kept a stale `true` — the getting-started panel never returned and the
    // empty state offered "Show all reviews" against an equally empty filter.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, id: "scan-1" }))
      .mockResolvedValueOnce(jsonResponse({ scans: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    model = new ScanListModel();
    model.hasAnyScan.value = true;
    model.scans.value = [{ ...scanDetail(null).scan, status: "failed" }];

    await expect(model.deleteFailed("scan-1")).resolves.toBe(true);

    expect(model.scans.value).toEqual([]);
    expect(model.hasAnyScan.value).toBe(false);
  });

  test("deleting one of several scans leaves the answer alone", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ ok: true, id: "scan-1" })));
    vi.stubGlobal("fetch", fetchMock);

    model = new ScanListModel();
    model.hasAnyScan.value = true;
    model.scans.value = [
      { ...scanDetail(null).scan, id: "scan-1", status: "failed" },
      { ...scanDetail(null).scan, id: "scan-2" },
    ];

    await expect(model.deleteFailed("scan-1")).resolves.toBe(true);

    expect(model.hasAnyScan.value).toBe(true);
    // No probe: the list is still non-empty, so only the DELETE was sent.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("ScanListModel registry status refreshes", () => {
  afterEach(() => {
    model?.[Symbol.dispose]();
    model = null;
    setActiveOrganizationId(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("ignores a refresh response from the previously active organization", async () => {
    const organizationA = deferred<Response>();
    const organizationB = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(organizationA.promise)
      .mockReturnValueOnce(organizationB.promise);
    vi.stubGlobal("fetch", fetchMock);
    model = new ScanListModel();
    model.filter.value = "all";

    setActiveOrganizationId("org-a");
    const refreshA = model.refresh();
    setActiveOrganizationId("org-b");
    const refreshB = model.refresh();

    organizationB.resolve(
      jsonResponse({ scans: [{ ...scanDetail(null).scan, id: "scan-b" }], nextCursor: null }),
    );
    await refreshB;
    organizationA.resolve(
      jsonResponse({ scans: [{ ...scanDetail(null).scan, id: "scan-a" }], nextCursor: null }),
    );
    await refreshA;

    expect(model.scans.value.map((scan) => scan.id)).toEqual(["scan-b"]);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ [ACTIVE_ORG_HEADER]: "org-a" }),
      }),
    );
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ [ACTIVE_ORG_HEADER]: "org-b" }),
      }),
    );
  });

  test("cancels pending registry refreshes after the active organization changes", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ scans: [], nextCursor: null })));
    vi.stubGlobal("fetch", fetchMock);
    model = new ScanListModel();
    model.filter.value = "all";

    setActiveOrganizationId("org-a");
    model.scheduleRegistryStatusRefreshes();
    setActiveOrganizationId("org-b");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("refreshes while the Check npm background work can still be completing", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ scans: [], nextCursor: null })));
    vi.stubGlobal("fetch", fetchMock);
    model = new ScanListModel();
    model.filter.value = "all";

    model.scheduleRegistryStatusRefreshes();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(39_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test("keeps already-loaded pages during registry status refreshes", async () => {
    vi.useFakeTimers();
    const loadedScans = Array.from({ length: 40 }, (_, index) => ({
      ...scanDetail(null).scan,
      id: `scan-${index}`,
    }));
    const refreshedScans = loadedScans.map((scan) => ({
      ...scan,
      registryVersionStatus: "published",
    }));
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ scans: refreshedScans, nextCursor: "cursor-after-refresh" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    model = new ScanListModel();
    model.filter.value = "all";
    model.scans.value = loadedScans;
    model.nextCursor.value = "cursor-before-refresh";

    model.scheduleRegistryStatusRefreshes();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/scans?filter=all&limit=40", expect.any(Object));
    expect(model.scans.value).toHaveLength(40);
    expect(model.scans.value.every((scan) => scan.registryVersionStatus === "published")).toBe(
      true,
    );
    expect(model.nextCursor.value).toBe("cursor-after-refresh");
  });

  test("cancels pending refreshes when the model is disposed", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ scans: [], nextCursor: null })));
    vi.stubGlobal("fetch", fetchMock);
    model = new ScanListModel();
    model.filter.value = "all";

    model.scheduleRegistryStatusRefreshes();
    model[Symbol.dispose]();
    model = null;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
