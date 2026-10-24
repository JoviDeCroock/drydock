import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DetonationResult, DetonationSignal } from "../server/lib/detonation/types";
import {
  DETONATION_POLL_DELAY_MS,
  ScanDetonationModel,
  type ScanDetonationResponse,
  type ScanDetonationRun,
} from "../src/models/scan";
import {
  cleanRunCaveat,
  coverageParts,
  detonationView,
  signalNeedsBadge,
} from "../src/pages/Dashboard/ScanDetail/detonation-view";
import { jsonResponse, stubFetchRoutes } from "./helpers/fetch-stub";

function signal(
  severity: DetonationSignal["severity"],
  id = "dynamic.network-egress",
): DetonationSignal {
  return {
    id: id as DetonationSignal["id"],
    severity,
    title: `${severity} signal`,
    evidence: [],
    source: "egress",
    step: "lifecycle",
  };
}

function result(overrides: Partial<DetonationResult> = {}): DetonationResult {
  return {
    status: "complete",
    signals: [],
    coverage: {
      syscallTracing: true,
      runtimeHooks: true,
      dependencyInstall: "complete",
      stepsSkipped: 0,
      exercise: "load",
      browserTargeted: false,
    },
    steps: [],
    egress: [],
    truncated: false,
    errorCode: null,
    ...overrides,
  };
}

function run(overrides: Partial<ScanDetonationRun> = {}): ScanDetonationRun {
  return {
    status: "complete",
    stale: false,
    result: result(),
    errorCode: null,
    artifactSha256: "a".repeat(64),
    requestedAt: "2026-10-20T00:00:00.000Z",
    startedAt: "2026-10-20T00:00:01.000Z",
    completedAt: "2026-10-20T00:00:30.000Z",
    ...overrides,
  };
}

function response(detonation: ScanDetonationRun | null, eligible = true): ScanDetonationResponse {
  return { eligible, detonation };
}

describe("detonationView", () => {
  test("offers a first run only when the scan is eligible", () => {
    expect(detonationView(response(null))).toEqual({ kind: "not-run", canRun: true });
    expect(detonationView(response(null, false))).toEqual({ kind: "hidden" });
    expect(detonationView(null)).toEqual({ kind: "hidden" });
  });

  test("a live run is pending until the server marks it stale", () => {
    expect(detonationView(response(run({ status: "queued", result: null })))).toEqual({
      kind: "pending",
      label: "Detonation queued",
    });
    expect(detonationView(response(run({ status: "running", result: null })))).toEqual({
      kind: "pending",
      label: "Running in the sandbox",
    });
    expect(
      detonationView(response(run({ status: "running", stale: true, result: null }))),
    ).toMatchObject({ kind: "stalled", canRun: true });
  });

  test("deterministic refusals do not offer a rerun; transient failures do", () => {
    const mismatch = detonationView(
      response(run({ status: "skipped", result: null, errorCode: "artifact_digest_mismatch" })),
    );
    expect(mismatch).toEqual({
      kind: "unfinished",
      message: "Refused: the bytes no longer match what this review read, so they were not run.",
      canRun: false,
    });
    expect(
      detonationView(
        response(run({ status: "skipped", result: null, errorCode: "artifact_too_large" })),
      ),
    ).toMatchObject({
      message: "Skipped: the package is over the 16 MiB sandbox limit.",
      canRun: false,
    });
    expect(
      detonationView(response(run({ status: "failed", result: null, errorCode: "timeout" }))),
    ).toMatchObject({ kind: "unfinished", canRun: true });
  });

  test("a finished run outside eligibility shows results without a rerun", () => {
    expect(detonationView(response(run(), false))).toMatchObject({
      kind: "complete",
      canRun: false,
    });
  });

  test("sorts signals most severe first", () => {
    const view = detonationView(
      response(
        run({ result: result({ signals: [signal("low"), signal("critical"), signal("medium")] }) }),
      ),
    );
    expect(view.kind === "complete" && view.signals.map((s) => s.severity)).toEqual([
      "critical",
      "medium",
      "low",
    ]);
  });
});

test("only canary exfiltration and registry writes get a Badge, whatever the severity", () => {
  expect(signalNeedsBadge("dynamic.canary-exfiltration")).toBe(true);
  expect(signalNeedsBadge("dynamic.registry-publish-attempt")).toBe(true);
  // A telemetry ping that sends data is a high network-egress signal.
  expect(signalNeedsBadge("dynamic.network-egress")).toBe(false);
  expect(signalNeedsBadge("dynamic.credential-file-read")).toBe(false);
});

describe("coverage", () => {
  const full = {
    syscallTracing: true,
    runtimeHooks: true,
    dependencyInstall: "complete",
    stepsSkipped: 0,
    exercise: "load",
    browserTargeted: false,
  } as const;
  const LIMITED = "Limited coverage makes a clean run weaker evidence.";

  test("names only the ways a run fell short of full coverage", () => {
    expect(coverageParts(full, false)).toEqual([]);
    expect(cleanRunCaveat(full, false)).toBeNull();

    const hooksOnly = { ...full, syscallTracing: false, dependencyInstall: "partial" } as const;
    expect(coverageParts(hooksOnly, true)).toEqual([
      "syscall tracing off",
      "dependency install partial",
      "record truncated",
    ]);
    expect(coverageParts({ ...full, runtimeHooks: false }, false)).toEqual(["runtime hooks off"]);
    expect(coverageParts(null, false)).toEqual(["coverage not reported"]);
    expect(cleanRunCaveat(hooksOnly, false)).toBe(LIMITED);
    expect(cleanRunCaveat(null, false)).toBe(LIMITED);

    const starved = { ...full, stepsSkipped: 3 };
    expect(coverageParts(starved, false)).toContain("3 steps not run");
    expect(cleanRunCaveat(starved, false)).toBe(LIMITED);
  });

  test("a browser build gets its own caveat, even with full coverage", () => {
    expect(cleanRunCaveat({ ...full, browserTargeted: true }, false)).toMatch(
      /ships a browser build, which never runs in the sandbox/,
    );
  });
});

describe("ScanDetonationModel", () => {
  let model: InstanceType<typeof ScanDetonationModel> | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    model?.[Symbol.dispose]();
    model = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("hides itself when the organization is outside the beta", async () => {
    stubFetchRoutes({ "/detonation": () => jsonResponse({ error: "not found" }, 404) });
    model = new ScanDetonationModel("scan-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(model.hidden.value).toBe(true);
    expect(model.loadError.value).toBeNull();
  });

  test("polls a live run and stops once it is terminal", async () => {
    const replies = [
      response(run({ status: "queued", result: null })),
      response(run({ status: "running", result: null })),
      response(run()),
    ];
    const fetchMock = stubFetchRoutes({
      "/detonation": () => jsonResponse(replies.shift() ?? response(run())),
    });
    model = new ScanDetonationModel("scan-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(model.run.value?.status).toBe("queued");

    await vi.advanceTimersByTimeAsync(DETONATION_POLL_DELAY_MS);
    expect(model.run.value?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(DETONATION_POLL_DELAY_MS);
    expect(model.run.value?.status).toBe("complete");

    await vi.advanceTimersByTimeAsync(DETONATION_POLL_DELAY_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("does not poll a stale run", async () => {
    const fetchMock = stubFetchRoutes({
      "/detonation": () =>
        jsonResponse(response(run({ status: "running", stale: true, result: null }))),
    });
    model = new ScanDetonationModel("scan-1");
    await vi.advanceTimersByTimeAsync(DETONATION_POLL_DELAY_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    [409, "A run is already in progress."],
    [429, "This organization has hit the hourly run limit. Try later."],
  ])("reports a %i rerun response inline and reloads", async (status, message) => {
    const fetchMock = stubFetchRoutes({
      "/detonation": (_url, init) =>
        init?.method === "POST"
          ? jsonResponse({ error: "nope" }, status)
          : jsonResponse(response(run())),
    });
    model = new ScanDetonationModel("scan-1");
    await vi.advanceTimersByTimeAsync(0);
    await model.requestRun();
    expect(model.requestError.value).toBe(message);
    expect(model.requesting.value).toBe(false);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual([
      "GET",
      "POST",
      "GET",
    ]);
  });

  test("a new request clears the previous request's error", async () => {
    let status = 429;
    stubFetchRoutes({
      "/detonation": (_url, init) =>
        init?.method === "POST"
          ? jsonResponse(status === 200 ? { ok: true } : { error: "nope" }, status)
          : jsonResponse(response(run())),
    });
    model = new ScanDetonationModel("scan-1");
    await vi.advanceTimersByTimeAsync(0);
    await model.requestRun();
    expect(model.requestError.value).not.toBeNull();

    status = 200;
    const pending = model.requestRun();
    expect(model.requestError.value).toBeNull();
    await pending;
    expect(model.requestError.value).toBeNull();
  });
});
