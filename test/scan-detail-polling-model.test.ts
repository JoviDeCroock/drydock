import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
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

  test("backs off exponentially on consecutive failures, capped at the max delay", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(failedResponse()));
    vi.stubGlobal("fetch", fetchMock);

    model = new ScanDetailModel("scan-1");
    startPolling(model);

    // First poll fires at the base delay.
    await vi.advanceTimersByTimeAsync(SCAN_POLL_BASE_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(model.error.value).not.toBeNull();

    // One failure doubles the delay: nothing at 4999ms, the poll at 5000ms.
    await vi.advanceTimersByTimeAsync(2 * SCAN_POLL_BASE_DELAY_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Keeps doubling: 10s, 20s, then clamps to the 30s cap.
    await vi.advanceTimersByTimeAsync(4 * SCAN_POLL_BASE_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(8 * SCAN_POLL_BASE_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(SCAN_POLL_MAX_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(SCAN_POLL_MAX_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(6);

    // Disposal clears the pending timer; no further polls leak.
    model[Symbol.dispose]();
    model = null;
    await vi.advanceTimersByTimeAsync(10 * SCAN_POLL_MAX_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(6);
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
