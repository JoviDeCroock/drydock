import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  SCAN_AI_POLL_STOP_AFTER_MS,
  SCAN_POLL_BASE_DELAY_MS,
  SCAN_POLL_MAX_DELAY_MS,
  SCAN_POLL_STALL_AFTER_MS,
  ScanDetailModel,
  type PersistedScanDetail,
} from "../src/models/scan";

function runningDetail(): PersistedScanDetail {
  return {
    scan: {
      id: "scan-1",
      stageId: "stage-1",
      packageName: "left-pad",
      stagedVersion: "1.0.1",
      previousVersion: "1.0.0",
      risk: "none",
      status: "running",
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    },
    files: [],
    findings: [],
    events: [],
  };
}

// A finished report whose advisory review has not landed yet: the scan itself is
// complete and on screen, only `ai_status` is outstanding.
function aiPendingDetail(): PersistedScanDetail {
  const detail = runningDetail();
  return {
    ...detail,
    scan: { ...detail.scan, status: "complete", aiStatus: "pending" },
  };
}

function completedReportDetail(): PersistedScanDetail {
  const detail = aiPendingDetail();
  return {
    ...detail,
    files: [
      {
        id: "file-1",
        scanId: "scan-1",
        path: "index.js",
        status: "added",
        size: 18,
        sha256: "sha256",
        flagsJson: [],
        textSample: "module.exports = 1",
      },
    ],
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function failedResponse(): Response {
  return new Response(JSON.stringify({ error: "boom" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

type ScanDetailModelInstance = InstanceType<typeof ScanDetailModel>;

// Flips the model into the polling state (status running) without going
// through the network, so the fetch mock only ever sees poll requests.
function startPolling(model: ScanDetailModelInstance): void {
  model.detail.value = runningDetail();
}

describe("ScanDetailModel polling", () => {
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

  test("uses a ten second healthy polling cadence", () => {
    expect(SCAN_POLL_BASE_DELAY_MS).toBe(10_000);
  });

  test("backs off exponentially on consecutive failures, capped at the max delay", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(failedResponse()));
    vi.stubGlobal("fetch", fetchMock);

    model = new ScanDetailModel("scan-1");
    startPolling(model);

    // First poll fires at the base delay.
    await vi.advanceTimersByTimeAsync(SCAN_POLL_BASE_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(model.error.value).not.toBeNull();

    // One failure doubles the delay: nothing until the doubled base delay.
    await vi.advanceTimersByTimeAsync(2 * SCAN_POLL_BASE_DELAY_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The next failure clamps the cadence to the max delay.
    await vi.advanceTimersByTimeAsync(SCAN_POLL_MAX_DELAY_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(SCAN_POLL_MAX_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(SCAN_POLL_MAX_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    // Disposal clears the pending timer; no further polls leak.
    model[Symbol.dispose]();
    model = null;
    await vi.advanceTimersByTimeAsync(10 * SCAN_POLL_MAX_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  test("resets to the base delay after a successful poll", async () => {
    let fail = true;
    const fetchMock = vi.fn(() =>
      Promise.resolve(fail ? failedResponse() : jsonResponse(runningDetail())),
    );
    vi.stubGlobal("fetch", fetchMock);

    model = new ScanDetailModel("scan-1");
    startPolling(model);

    // First poll fails → the chain backs off to 2× base.
    await vi.advanceTimersByTimeAsync(SCAN_POLL_BASE_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fail = false;
    await vi.advanceTimersByTimeAsync(2 * SCAN_POLL_BASE_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(model.error.value).toBeNull();

    // Success resets the cadence: the next poll fires at the base delay again.
    await vi.advanceTimersByTimeAsync(SCAN_POLL_BASE_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("stops polling and raises pollingStalled after the stall window", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(runningDetail())));
    vi.stubGlobal("fetch", fetchMock);

    model = new ScanDetailModel("scan-1");
    startPolling(model);

    await vi.advanceTimersByTimeAsync(SCAN_POLL_STALL_AFTER_MS);
    expect(model.pollingStalled.value).toBe(true);

    const callsAtStall = fetchMock.mock.calls.length;
    expect(callsAtStall).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(10 * SCAN_POLL_MAX_DELAY_MS);
    expect(fetchMock.mock.calls.length).toBe(callsAtStall);
  });

  test("keeps polling a complete scan while its review is pending, without the stalled warning", async () => {
    const pending = aiPendingDetail();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (!String(input).endsWith("/status")) return Promise.resolve(jsonResponse(pending));
      return Promise.resolve(
        jsonResponse({
          scan: {
            id: pending.scan.id,
            status: pending.scan.status,
            aiStatus: pending.scan.aiStatus,
            updatedAt: pending.scan.updatedAt,
          },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    model = new ScanDetailModel("scan-1");
    await model.load();

    // Past the window that would have latched a *running* scan as stalled. The
    // report is complete and rendered, so "automatic refresh stopped without the
    // review finishing" would be both alarming and wrong.
    await vi.advanceTimersByTimeAsync(SCAN_POLL_STALL_AFTER_MS);
    expect(model.pollingStalled.value).toBe(false);
    expect(model.aiPollingStopped.value).toBe(false);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    // The lightweight status response must not erase report metadata already
    // loaded by GET /scans/:id.
    expect(model.detail.value?.scan.packageName).toBe("left-pad");
  });

  test("fetches the completed report after the initial load returns a running scan", async () => {
    const completed = completedReportDetail();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/status")) {
        return Promise.resolve(jsonResponse({ scan: completed.scan }));
      }
      if (url.endsWith("?poll=1")) return Promise.resolve(jsonResponse(completed));
      return Promise.resolve(jsonResponse(runningDetail()));
    });
    vi.stubGlobal("fetch", fetchMock);

    model = new ScanDetailModel("scan-1");
    await model.load();

    await vi.advanceTimersByTimeAsync(SCAN_POLL_BASE_DELAY_MS);

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/scans/scan-1",
      "/api/v1/scans/scan-1/status",
      "/api/v1/scans/scan-1?poll=1",
    ]);
    expect(model.detail.value?.scan.status).toBe("complete");
    expect(model.detail.value?.files).toEqual(completed.files);
  });

  test("latches aiPollingStopped once it gives up on a pending review", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ scan: aiPendingDetail().scan })));
    vi.stubGlobal("fetch", fetchMock);

    model = new ScanDetailModel("scan-1");
    model.detail.value = aiPendingDetail();

    await vi.advanceTimersByTimeAsync(SCAN_AI_POLL_STOP_AFTER_MS);
    // `isPolling` stays true while ai_status is pending, so the latch is what
    // stops the UI claiming a review is in flight that nothing is watching.
    expect(model.aiPollingStopped.value).toBe(true);
    expect(model.pollingStalled.value).toBe(false);

    const callsAtStop = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * SCAN_POLL_MAX_DELAY_MS);
    expect(fetchMock.mock.calls.length).toBe(callsAtStop);
  });

  test("resumePolling refetches immediately and restarts the chain", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(runningDetail())));
    vi.stubGlobal("fetch", fetchMock);

    model = new ScanDetailModel("scan-1");
    startPolling(model);

    await vi.advanceTimersByTimeAsync(SCAN_POLL_STALL_AFTER_MS);
    expect(model.pollingStalled.value).toBe(true);
    const callsAtStall = fetchMock.mock.calls.length;

    model.resumePolling();
    expect(model.pollingStalled.value).toBe(false);
    // The manual refresh fires without waiting for the next scheduled tick.
    expect(fetchMock.mock.calls.length).toBe(callsAtStall + 1);

    // The restarted chain polls at the base delay again.
    await vi.advanceTimersByTimeAsync(SCAN_POLL_BASE_DELAY_MS);
    expect(fetchMock.mock.calls.length).toBe(callsAtStall + 2);
  });
});
