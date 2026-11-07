import { afterEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  getScan: vi.fn(),
  getScanVersions: vi.fn(async () => ({ versions: [] })),
}));
vi.mock("../src/models/scan-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/models/scan-api")>()),
  ...api,
}));
vi.mock("../src/models/github-app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/models/github-app")>()),
  getWorkflowGateByScan: vi.fn(async () => null),
}));

const { ScanDetailModel } = await import("../src/models/scan-detail-model");

let model: InstanceType<typeof ScanDetailModel> | null = null;

afterEach(() => {
  model?.[Symbol.dispose]();
  model = null;
  vi.clearAllMocks();
  vi.useRealTimers();
});

function detail(status: string) {
  return {
    scan: {
      id: "scan-1",
      stageId: "stage-1",
      organizationId: "org-1",
      packageName: "pkg",
      stagedVersion: "1.0.0",
      previousVersion: null,
      risk: "low",
      status,
      source: "manual",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
    files: [],
    findings: [],
    events: [],
  };
}

test("a notification landing is reported on the first load that has a report", async () => {
  vi.useFakeTimers();
  model = new ScanDetailModel("scan-1");
  api.getScan.mockResolvedValueOnce(detail("running"));
  await model.load({ via: "notification" });
  // Still running: the server records no view, so the hint must survive.
  api.getScan.mockResolvedValueOnce(detail("complete"));
  await model.load();
  api.getScan.mockResolvedValueOnce(detail("complete"));
  await model.load();

  expect(api.getScan.mock.calls.map(([, options]) => options)).toEqual([
    { via: "notification" },
    { via: "notification" },
    { via: undefined },
  ]);
});
