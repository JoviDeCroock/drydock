import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PublicWorkflowGate } from "../src/models/github-app";
import { ScanDetailModel, type PersistedScanDetail } from "../src/models/scan";
import { jsonResponse, stubFetchRoutes } from "./helpers/fetch-stub";

const GATE_PATH = "/workflow-gates/by-scan/scan-1";

function gateDetail(status: "complete" | "failed" | "running" = "complete"): PersistedScanDetail {
  return {
    scan: {
      id: "scan-1",
      stageId: "stage-1",
      source: "workflow_gate",
      packageName: "left-pad",
      stagedVersion: "1.0.1",
      previousVersion: null,
      risk: "none",
      status,
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    },
    files: [],
    findings: [],
    events: [],
  };
}

function workflowGate(overrides: Partial<PublicWorkflowGate> = {}): PublicWorkflowGate {
  return {
    id: "gate-1",
    organizationId: "org-1",
    releaseTargetId: "target-1",
    repositoryFullName: "owner/repo",
    environment: "release",
    runId: 1,
    status: "pending",
    decision: null,
    decisionComment: null,
    reportUrl: null,
    scanId: "scan-1",
    failureReason: null,
    organizationRequiresTwoFactor: false,
    packages: [],
    requestedAt: "2026-06-09T00:00:00.000Z",
    decidedAt: null,
    createdAt: "2026-06-09T00:00:00.000Z",
    updatedAt: "2026-06-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("ScanDetailModel workflow gate lookup", () => {
  let model: InstanceType<typeof ScanDetailModel>;

  beforeEach(() => {
    vi.useFakeTimers();
    model = new ScanDetailModel("scan-1");
  });

  afterEach(() => {
    model[Symbol.dispose]();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test.each([404, 500])("backs off and stops retrying a persistent %i", async (status) => {
    const fetchMock = stubFetchRoutes({
      [GATE_PATH]: () => jsonResponse({ error: "not found" }, status),
    });
    model.detail.value = gateDetail();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(model.gateLoaded.value).toBe(false);
    expect(model.gateLookupStalled.value).toBe(true);
    // A report refresh must not restart the budget.
    model.detail.value = gateDetail();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(model.gateDecisionError.value).toBe(status === 404 ? null : "not found");
  });

  test.each(["complete", "failed"] as const)("loads a %s scan's gate and stops", async (status) => {
    const gate = workflowGate();
    const fetchMock = stubFetchRoutes({ [GATE_PATH]: () => jsonResponse({ gate }) });
    model.detail.value = gateDetail(status);
    await vi.advanceTimersByTimeAsync(0);
    expect(model.gate.value).toEqual(gate);
    expect(model.gateLoaded.value).toBe(true);
    expect(model.gateLookupStalled.value).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("waits for the terminal transition and ignores ordinary scans", async () => {
    const fetchMock = stubFetchRoutes({
      [GATE_PATH]: () => jsonResponse({ gate: workflowGate() }),
    });
    model.detail.value = { ...gateDetail(), scan: { ...gateDetail().scan, source: "manual" } };
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();

    model.detail.value = gateDetail("running");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
    model.detail.value = gateDetail("failed");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not overlap slow lookups or count their waiting time as retries", async () => {
    const page = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal("document", page);
    let resolve!: (response: Response) => void;
    const fetchMock = stubFetchRoutes({
      [GATE_PATH]: () => new Promise<Response>((done) => (resolve = done)),
    });
    model.detail.value = gateDetail();
    await vi.advanceTimersByTimeAsync(0);
    page.hidden = true;
    page.dispatchEvent(new Event("visibilitychange"));
    page.hidden = false;
    page.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(jsonResponse({ error: "not found" }, 404));
    await vi.advanceTimersByTimeAsync(2_499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("disposal cancels retries and discards an in-flight result", async () => {
    const page = Object.assign(new EventTarget(), { hidden: false });
    const removeListener = vi.spyOn(page, "removeEventListener");
    vi.stubGlobal("document", page);
    let resolve!: (response: Response) => void;
    const fetchMock = stubFetchRoutes({
      [GATE_PATH]: () => new Promise<Response>((done) => (resolve = done)),
    });
    model.detail.value = gateDetail();
    await vi.advanceTimersByTimeAsync(0);
    model[Symbol.dispose]();
    resolve(jsonResponse({ gate: workflowGate() }));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(model.gate.value).toBeNull();
    expect(model.gateLoaded.value).toBe(false);
    expect(removeListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });

  test("recovers after a transient error and clears its error message", async () => {
    let fail = true;
    const gate = workflowGate();
    const fetchMock = stubFetchRoutes({
      [GATE_PATH]: () =>
        fail ? jsonResponse({ error: "temporarily unavailable" }, 500) : jsonResponse({ gate }),
    });
    model.detail.value = gateDetail();
    await vi.advanceTimersByTimeAsync(0);
    expect(model.gateDecisionError.value).toBe("temporarily unavailable");
    fail = false;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(model.gate.value).toEqual(gate);
    expect(model.gateDecisionError.value).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("manual lookup retry grants one new bounded budget", async () => {
    const fetchMock = stubFetchRoutes({
      [GATE_PATH]: () => jsonResponse({ error: "temporarily unavailable" }, 500),
    });
    model.detail.value = gateDetail();
    await vi.advanceTimersByTimeAsync(0);
    model.retryGateLookup();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(model.gateLookupStalled.value).toBe(true);

    model.retryGateLookup();
    model.retryGateLookup();
    expect(model.gateLookupStalled.value).toBe(false);
    expect(model.gateDecisionError.value).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(12);
    expect(model.gateLookupStalled.value).toBe(true);
    model.detail.value = gateDetail();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });

  test("disposes an already scheduled retry", async () => {
    const fetchMock = stubFetchRoutes({
      [GATE_PATH]: () => jsonResponse({ error: "not found" }, 404),
    });
    model.detail.value = gateDetail();
    await vi.advanceTimersByTimeAsync(0);
    model[Symbol.dispose]();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("pauses hidden tabs without resetting retry backoff or the request cap", async () => {
    const page = Object.assign(new EventTarget(), { hidden: true });
    vi.stubGlobal("document", page);
    const fetchMock = stubFetchRoutes({
      [GATE_PATH]: () => jsonResponse({ error: "not found" }, 404),
    });
    model.detail.value = gateDetail();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();

    page.hidden = false;
    page.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    page.hidden = true;
    page.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1_000);
    page.hidden = false;
    page.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1_499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    page.hidden = true;
    page.dispatchEvent(new Event("visibilitychange"));
    page.hidden = false;
    page.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  test("preserves a human gate decision and its report refresh", async () => {
    const approved = workflowGate({ status: "approved", decision: "approved" });
    const fetchMock = stubFetchRoutes({
      [GATE_PATH]: () => jsonResponse({ gate: workflowGate() }),
      "/workflow-gates/gate-1/decision": () => jsonResponse({ gate: approved }),
      "/api/v1/scans/scan-1": () => jsonResponse(gateDetail()),
    });
    model.detail.value = gateDetail();
    await vi.advanceTimersByTimeAsync(0);
    await model.decideGate("approved", null);
    expect(model.gate.value).toEqual(approved);
    expect(model.gateDecisionStatus.value).toBe("idle");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock.mock.calls.filter(([path]) => String(path).includes(GATE_PATH))).toHaveLength(
      1,
    );
  });
});
