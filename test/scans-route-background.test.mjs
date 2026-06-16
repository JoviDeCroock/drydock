import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  createDb: vi.fn(() => ({})),
  createScanJob: vi.fn(),
  enforceRateLimit: vi.fn(),
  getNpmConnection: vi.fn(),
  recordScanEvent: vi.fn(),
}));
const activeOrgMock = vi.hoisted(() => ({
  requireActiveOrganization: vi.fn(),
}));
const scanJobMock = vi.hoisted(() => ({
  executeScanJob: vi.fn(),
}));
const npmConnectionMock = vi.hoisted(() => ({
  decryptNpmToken: vi.fn(),
}));
const stagedPublishesMock = vi.hoisted(() => ({
  checkStagedPublishAccess: vi.fn(),
  StagedPublishesFetchError: class StagedPublishesFetchError extends Error {},
}));

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));
vi.mock("../server/db/index.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...dbMock };
});
vi.mock("../server/lib/active-organization.ts", () => activeOrgMock);
vi.mock("../server/lib/scan-job.ts", () => scanJobMock);
vi.mock("../server/lib/npm-connection.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...npmConnectionMock };
});
vi.mock("../server/lib/staged-publishes.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...stagedPublishesMock };
});

const { scansRoutes } = await import("../server/routes/scans.ts");

function buildTestApp() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId: "user_route" });
    await next();
  });
  app.route("/api/v1/scans", scansRoutes);
  return app;
}

afterEach(() => {
  for (const fn of [
    ...Object.values(dbMock),
    activeOrgMock.requireActiveOrganization,
    scanJobMock.executeScanJob,
    npmConnectionMock.decryptNpmToken,
    stagedPublishesMock.checkStagedPublishAccess,
  ]) {
    fn.mockReset();
  }
});

describe("scans route background fallback", () => {
  test("runs the waitUntil fallback as a final attempt because no queue retry will occur", async () => {
    activeOrgMock.requireActiveOrganization.mockResolvedValue("org_route");
    dbMock.getNpmConnection.mockResolvedValue({
      validationStatus: "valid",
      registryUrl: "https://registry.npmjs.org",
    });
    dbMock.createScanJob.mockResolvedValue({
      scan: { id: "scan_route", stageId: "stage-route-bg-000001" },
    });
    npmConnectionMock.decryptNpmToken.mockResolvedValue("npm_secret_token");
    stagedPublishesMock.checkStagedPublishAccess.mockResolvedValue({
      allowed: true,
      status: 206,
      detail: null,
    });
    scanJobMock.executeScanJob.mockResolvedValue({ id: "scan_route" });
    const backgrounded = [];

    const res = await buildTestApp().fetch(
      new Request("http://test.local/api/v1/scans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stageId: "stage-route-bg-000001" }),
      }),
      // No SCAN_QUEUE binding: local/dev falls back to executionCtx.waitUntil().
      { DB: {} },
      { waitUntil: (promise) => backgrounded.push(promise) },
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      scan: { id: "scan_route", stageId: "stage-route-bg-000001" },
      queued: false,
    });

    expect(backgrounded).toHaveLength(1);
    await Promise.all(backgrounded);
    // finalAttempt must be true: there is no queue to retry a transient
    // failure, so the job has to persist retryable errors as failed instead of
    // leaving the scan running forever.
    expect(scanJobMock.executeScanJob).toHaveBeenCalledWith(
      { DB: {} },
      expect.anything(),
      expect.objectContaining({
        organizationId: "org_route",
        actorUserId: "user_route",
        stageId: "stage-route-bg-000001",
      }),
      {},
      { finalAttempt: true },
    );

    const backgroundedEvents = dbMock.recordScanEvent.mock.calls.filter(
      ([, payload]) => payload?.type === "scan.backgrounded",
    );
    expect(backgroundedEvents).toHaveLength(1);
  });
});
