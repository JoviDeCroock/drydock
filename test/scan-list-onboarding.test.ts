import { afterEach, describe, expect, test, vi } from "vitest";
import { setActiveOrganizationId } from "../src/models/active-organization";
import { ScanListModel } from "../src/models/scan-list-model";
import type { ScanListItem } from "../src/models/scan-api";

/**
 * The getting-started funnel's last step: has this organization ever recorded a
 * decision? The dashboard list cannot answer it — it defaults to the
 * "undecided" filter — so the model resolves it separately, and only when
 * asked.
 */

function scan(overrides: Partial<ScanListItem> = {}): ScanListItem {
  return {
    id: "scan-1",
    stageId: "stage-1",
    packageName: "left-pad",
    stagedVersion: "1.0.1",
    previousVersion: "1.0.0",
    risk: "low",
    status: "complete",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Serves `/api/v1/scans` from a per-filter map and records the filters asked for. */
function stubScanList(pages: Partial<Record<string, ScanListItem[]>>) {
  const asked: string[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://drydock.test");
    if (init?.method === "POST") {
      return Promise.resolve(
        jsonResponse({ scan: scan({ decision: "publish" }), files: [], findings: [], events: [] }),
      );
    }
    const filter = url.searchParams.get("filter") ?? "undecided";
    asked.push(filter);
    return Promise.resolve(jsonResponse({ scans: pages[filter] ?? [], nextCursor: null, filter }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return asked;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setActiveOrganizationId(null);
});

describe("ScanListModel onboarding progress", () => {
  test("an organization with no scans has nothing decided either", async () => {
    const asked = stubScanList({});
    const model = new ScanListModel();

    await model.refresh();

    expect(model.hasAnyScan.value).toBe(false);
    expect(model.hasAnyDecision.value).toBe(false);
    // The empty "undecided" page plus the one-row "all" probe. Nothing more:
    // an organization with no scans cannot have decided one.
    expect(asked).toEqual(["undecided", "all"]);
  });

  test("a decided review in the fetched page settles the step for free", async () => {
    const asked = stubScanList({ all: [scan({ decision: "no_publish" })] });
    const model = new ScanListModel();
    model.filter.value = "all";

    await model.refresh();

    expect(model.hasAnyScan.value).toBe(true);
    expect(model.hasAnyDecision.value).toBe(true);
    expect(asked).toEqual(["all"]);
  });

  test("a page of undecided reviews leaves the step unknown until it is asked about", async () => {
    const asked = stubScanList({ undecided: [scan()] });
    const model = new ScanListModel();

    await model.refresh();

    // Unknown, not false: the panel is never shown on a guess.
    expect(model.hasAnyDecision.value).toBe(null);
    expect(asked).toEqual(["undecided"]);
  });

  test("approvals are probed first and short-circuit", async () => {
    const asked = stubScanList({
      undecided: [scan()],
      publish: [scan({ id: "scan-2", decision: "publish" })],
      no_publish: [scan({ id: "scan-3", decision: "no_publish" })],
    });
    const model = new ScanListModel();
    await model.refresh();

    await model.resolveHasAnyDecision();

    expect(model.hasAnyDecision.value).toBe(true);
    expect(asked).toEqual(["undecided", "publish"]);
  });

  test("blocked reviews count too", async () => {
    const asked = stubScanList({
      undecided: [scan()],
      no_publish: [scan({ id: "scan-3", decision: "no_publish" })],
    });
    const model = new ScanListModel();
    await model.refresh();

    await model.resolveHasAnyDecision();

    expect(model.hasAnyDecision.value).toBe(true);
    expect(asked).toEqual(["undecided", "publish", "no_publish"]);
  });

  test("answers no when neither decision has ever been recorded", async () => {
    const asked = stubScanList({ undecided: [scan()] });
    const model = new ScanListModel();
    await model.refresh();

    await model.resolveHasAnyDecision();

    expect(model.hasAnyDecision.value).toBe(false);
    expect(asked).toEqual(["undecided", "publish", "no_publish"]);
  });

  test("concurrent callers share one probe", async () => {
    const asked = stubScanList({ undecided: [scan()] });
    const model = new ScanListModel();
    await model.refresh();

    await Promise.all([model.resolveHasAnyDecision(), model.resolveHasAnyDecision()]);

    expect(model.hasAnyDecision.value).toBe(false);
    expect(asked).toEqual(["undecided", "publish", "no_publish"]);
  });

  test("a completed decision write cannot be downgraded by an older probe", async () => {
    let resolveBlockedProbe!: (response: Response) => void;
    let blockedProbeStarted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "https://drydock.test");
        if (init?.method === "POST") {
          return Promise.resolve(
            jsonResponse({
              scan: scan({ decision: "publish" }),
              files: [],
              findings: [],
              events: [],
            }),
          );
        }
        const filter = url.searchParams.get("filter") ?? "undecided";
        if (filter === "undecided") {
          return Promise.resolve(
            jsonResponse({ scans: [scan()], nextCursor: null, filter: "undecided" }),
          );
        }
        if (filter === "publish") {
          return Promise.resolve(jsonResponse({ scans: [], nextCursor: null, filter: "publish" }));
        }
        blockedProbeStarted = true;
        return new Promise<Response>((resolve) => {
          resolveBlockedProbe = resolve;
        });
      }),
    );
    const model = new ScanListModel();
    await model.refresh();

    const probe = model.resolveHasAnyDecision();
    await vi.waitFor(() => expect(blockedProbeStarted).toBe(true));
    await model.setDecision("scan-1", "publish", null);
    resolveBlockedProbe(jsonResponse({ scans: [], nextCursor: null, filter: "no_publish" }));
    await probe;

    expect(model.hasAnyDecision.value).toBe(true);
  });

  test("a settled answer is not re-probed", async () => {
    const asked = stubScanList({ undecided: [scan()] });
    const model = new ScanListModel();
    await model.refresh();
    await model.resolveHasAnyDecision();

    await model.resolveHasAnyDecision();

    expect(asked).toEqual(["undecided", "publish", "no_publish"]);
  });

  test("a decided row already loaded answers without any request", async () => {
    const asked = stubScanList({ all: [scan({ decision: "publish" })] });
    const model = new ScanListModel();
    model.filter.value = "all";
    await model.refresh();
    model.hasAnyDecision.value = null;

    await model.resolveHasAnyDecision();

    expect(model.hasAnyDecision.value).toBe(true);
    expect(asked).toEqual(["all"]);
  });

  test("recording a decision ticks the step without a probe", async () => {
    const asked = stubScanList({ undecided: [scan()] });
    const model = new ScanListModel();
    await model.refresh();
    expect(model.hasAnyDecision.value).toBe(null);

    await model.setDecision("scan-1", "publish", null);

    expect(model.hasAnyDecision.value).toBe(true);
    expect(asked).toEqual(["undecided"]);
  });

  test("a same-organization refresh preserves a recorded decision", async () => {
    let decisionRecorded = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "https://drydock.test");
        if (init?.method === "POST") {
          decisionRecorded = true;
          return Promise.resolve(
            jsonResponse({
              scan: scan({ decision: "publish" }),
              files: [],
              findings: [],
              events: [],
            }),
          );
        }
        const filter = url.searchParams.get("filter") ?? "undecided";
        const scans =
          filter === "undecided"
            ? decisionRecorded
              ? []
              : [scan()]
            : filter === "all" && decisionRecorded
              ? [scan({ decision: "publish" })]
              : [];
        return Promise.resolve(jsonResponse({ scans, nextCursor: null, filter }));
      }),
    );
    const model = new ScanListModel();
    await model.refresh();
    await model.setDecision("scan-1", "publish", null);

    await model.refresh();

    expect(model.hasAnyScan.value).toBe(true);
    expect(model.hasAnyDecision.value).toBe(true);
  });

  test("a refresh stranded by an organization switch cannot clobber the new answer", async () => {
    // org-a's "has any scan at all?" probe never resolves until the end, which
    // is what strands its refresh mid-flight across the switch to org-b.
    let resolveStrandedProbe!: (response: Response) => void;
    const strandedProbe = new Promise<Response>((resolve) => {
      resolveStrandedProbe = resolve;
    });
    const asked: Array<string> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "https://drydock.test");
        const filter = url.searchParams.get("filter") ?? "undecided";
        const organizationId =
          (init?.headers as Record<string, string> | undefined)?.["x-organization-id"] ?? "none";
        asked.push(`${organizationId}:${filter}`);
        if (organizationId === "org-a") {
          if (filter === "all") return strandedProbe;
          return Promise.resolve(jsonResponse({ scans: [], nextCursor: null, filter }));
        }
        if (filter === "undecided") {
          return Promise.resolve(jsonResponse({ scans: [scan()], nextCursor: null, filter }));
        }
        if (filter === "publish") {
          return Promise.resolve(
            jsonResponse({
              scans: [scan({ id: "scan-9", decision: "publish" })],
              nextCursor: null,
              filter,
            }),
          );
        }
        return Promise.resolve(jsonResponse({ scans: [], nextCursor: null, filter }));
      }),
    );

    const model = new ScanListModel();
    setActiveOrganizationId("org-a");
    const stranded = model.refresh();
    await vi.waitFor(() => expect(asked).toContain("org-a:all"));

    setActiveOrganizationId("org-b");
    await model.refresh();
    await model.resolveHasAnyDecision();
    expect(model.hasAnyDecision.value).toBe(true);

    resolveStrandedProbe(jsonResponse({ scans: [], nextCursor: null, filter: "all" }));
    await stranded;

    // org-a's answers are discarded, not written over org-b's.
    expect(model.hasAnyScan.value).toBe(true);
    expect(model.hasAnyDecision.value).toBe(true);
    // And org-b's settled answer is still settled: no probe was dropped, so
    // asking again costs nothing.
    await model.resolveHasAnyDecision();
    expect(asked.filter((entry) => entry.startsWith("org-b:"))).toEqual([
      "org-b:undecided",
      "org-b:publish",
    ]);
  });

  test("switching organizations invalidates the previous onboarding answers immediately", async () => {
    setActiveOrganizationId("org-a");
    const asked = stubScanList({});
    const model = new ScanListModel();
    await model.refresh();
    expect(model.hasAnyScan.value).toBe(false);
    expect(model.hasAnyDecision.value).toBe(false);

    setActiveOrganizationId("org-b");

    expect(model.hasAnyScan.value).toBe(null);
    expect(model.hasAnyDecision.value).toBe(null);
    expect(asked).toEqual(["undecided", "all"]);
  });

  test("an unreachable API leaves the step unknown rather than guessing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = new URL(String(input), "https://drydock.test");
        const filter = url.searchParams.get("filter") ?? "undecided";
        if (filter === "undecided") {
          return Promise.resolve(jsonResponse({ scans: [scan()], nextCursor: null, filter }));
        }
        return Promise.reject(new Error("offline"));
      }),
    );
    const model = new ScanListModel();
    await model.refresh();

    await model.resolveHasAnyDecision();

    expect(model.hasAnyDecision.value).toBe(null);
  });
});
