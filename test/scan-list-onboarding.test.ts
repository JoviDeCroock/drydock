import { afterEach, describe, expect, test, vi } from "vitest";
import { setActiveOrganizationId } from "../src/models/active-organization";
import { ScanListModel } from "../src/models/scan-list-model";
import type { ScanListItem } from "../src/models/scan-api";
import { jsonResponse } from "./helpers/fetch-stub";

/**
 * The getting-started funnel's exit: has this organization ever had a review?
 * The dashboard list cannot always answer it — it defaults to the "undecided"
 * filter — so the model probes separately, and the answer must belong to the
 * organization that is active when it lands.
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

/** Serves `/api/v1/scans` from a per-filter map and records the filters asked for. */
function stubScanList(pages: Partial<Record<string, ScanListItem[]>>) {
  const asked: string[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://drydock.test");
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
  test("an organization with no scans costs one probe and nothing more", async () => {
    const asked = stubScanList({});
    const model = new ScanListModel();

    await model.refresh();

    expect(model.hasAnyScan.value).toBe(false);
    // The empty "undecided" page plus the one-row "all" probe. No decision
    // probes: the funnel ends at the first review.
    expect(asked).toEqual(["undecided", "all"]);
  });

  test("a page of undecided reviews settles the answer without a probe", async () => {
    const asked = stubScanList({ undecided: [scan()] });
    const model = new ScanListModel();

    await model.refresh();

    expect(model.hasAnyScan.value).toBe(true);
    expect(asked).toEqual(["undecided"]);
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
        return Promise.resolve(jsonResponse({ scans: [scan()], nextCursor: null, filter }));
      }),
    );

    const model = new ScanListModel();
    setActiveOrganizationId("org-a");
    const stranded = model.refresh();
    await vi.waitFor(() => expect(asked).toContain("org-a:all"));

    setActiveOrganizationId("org-b");
    await model.refresh();
    expect(model.hasAnyScan.value).toBe(true);

    resolveStrandedProbe(jsonResponse({ scans: [], nextCursor: null, filter: "all" }));
    await stranded;

    // org-a's answer is discarded, not written over org-b's.
    expect(model.hasAnyScan.value).toBe(true);
    expect(asked.filter((entry) => entry.startsWith("org-b:"))).toEqual(["org-b:undecided"]);
  });

  test("switching organizations invalidates the previous answer immediately", async () => {
    setActiveOrganizationId("org-a");
    const asked = stubScanList({});
    const model = new ScanListModel();
    await model.refresh();
    expect(model.hasAnyScan.value).toBe(false);

    setActiveOrganizationId("org-b");

    expect(model.hasAnyScan.value).toBe(null);
    expect(asked).toEqual(["undecided", "all"]);
  });
});
