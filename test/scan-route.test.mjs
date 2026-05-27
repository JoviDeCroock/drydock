import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  createDb: vi.fn(() => ({})),
  createScanJob: vi.fn(),
  enforceRateLimit: vi.fn(),
  getNpmConnection: vi.fn(),
  RateLimitError: class RateLimitError extends Error {
    constructor(retryAfterSeconds) {
      super("rate limit exceeded");
      this.retryAfterSeconds = retryAfterSeconds;
    }
  },
}));
const activeOrgMock = vi.hoisted(() => ({
  requireActiveOrganization: vi.fn(),
}));
const scanJobMock = vi.hoisted(() => ({
  executeScanJob: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));
vi.mock("../server/db/index.ts", () => dbMock);
vi.mock("../server/lib/active-organization.ts", () => activeOrgMock);
vi.mock("../server/lib/scan-job.ts", () => scanJobMock);

const { scanRoutes } = await import("../server/routes/scan.ts");

function buildTestApp() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId: "user_route" });
    await next();
  });
  app.route("/api/v1/scan", scanRoutes);
  return app;
}

afterEach(() => {
  for (const fn of [
    dbMock.createDb,
    dbMock.createScanJob,
    dbMock.enforceRateLimit,
    dbMock.getNpmConnection,
    activeOrgMock.requireActiveOrganization,
    scanJobMock.executeScanJob,
  ]) {
    fn.mockReset();
  }
});

describe("compatibility scan route", () => {
  test("runs the synchronous scan as a final attempt because no queue retry will occur", async () => {
    activeOrgMock.requireActiveOrganization.mockResolvedValue("org_route");
    dbMock.getNpmConnection.mockResolvedValue({ validationStatus: "valid" });
    dbMock.createScanJob.mockResolvedValue(undefined);
    scanJobMock.executeScanJob.mockResolvedValue({ id: "scan_route" });

    const res = await buildTestApp().fetch(
      new Request("http://test.local/api/v1/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stageId: "stage-route-sync-000001" }),
      }),
      { DB: {} },
      { waitUntil: () => undefined },
    );

    expect(res.status).toBe(200);
    expect(scanJobMock.executeScanJob).toHaveBeenCalledWith(
      { DB: {} },
      expect.anything(),
      expect.objectContaining({
        organizationId: "org_route",
        actorUserId: "user_route",
        stageId: "stage-route-sync-000001",
      }),
      {},
      { finalAttempt: true },
    );
  });
});
