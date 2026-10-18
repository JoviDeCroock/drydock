import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppDb } from "../../server/db/client";
import { scans } from "../../server/db/schema";
import { recordReportView } from "../../server/lib/scan/report-view";
import { scansRoutes } from "../../server/routes/scans";
import { buildTestApp, call, type TestApp } from "./helpers/app";
import { seedCompletedScan, seedUser, type SeededUser } from "./helpers/seed";
import { seedLegacyScanJob } from "./helpers/seed-scan-job";

const mountScans = (app: TestApp) => app.route("/api/v1/scans", scansRoutes);

interface CapturedPoint {
  indexes: string[];
  blobs: string[];
  doubles: number[];
}

function withAnalytics(): CapturedPoint[] {
  const written: CapturedPoint[] = [];
  (env as { PRODUCT_ANALYTICS?: unknown }).PRODUCT_ANALYTICS = {
    writeDataPoint: (point: CapturedPoint) => written.push(point),
  };
  return written;
}

const viewEvents = (written: CapturedPoint[]) =>
  written.filter((point) => point.blobs[1] === "scan.viewed");

afterEach(() => {
  delete (env as { PRODUCT_ANALYTICS?: unknown }).PRODUCT_ANALYTICS;
  vi.restoreAllMocks();
});

async function viewColumns(db: AppDb, scanId: string) {
  const [row] = await db
    .select({
      firstViewedAt: scans.reportFirstViewedAt,
      lastViewedAt: scans.reportLastViewedAt,
      viewCount: scans.reportViewCount,
      surface: scans.reportFirstViewSurface,
      updatedAt: scans.updatedAt,
    })
    .from(scans)
    .where(eq(scans.id, scanId));
  return row;
}

/** A completed staged review counted since creation, as `createScanJob` writes it. */
function seedTrackedScan(owner: SeededUser, jobColumns: Partial<typeof scans.$inferInsert> = {}) {
  return seedCompletedScan(owner, {
    job: { source: "auto_discovery" },
    jobColumns: { reportViewCount: 0, ...jobColumns },
  });
}

function getDetail(owner: SeededUser, path: string, organizationId = owner.organizationId) {
  return call(buildTestApp(mountScans, owner), "GET", path, {
    activeOrganizationId: organizationId,
  });
}

describe("report view tracking", () => {
  test("the first load of a completed review records the view once and emits scan.viewed once", async () => {
    const written = withAnalytics();
    const owner = await seedUser();
    const scanId = await seedTrackedScan(owner);
    const before = await viewColumns(owner.db, scanId);

    const first = await getDetail(owner, `/api/v1/scans/${scanId}`);
    expect(first.status).toBe(200);
    // The read returns the row as it was; the write lands after the response.
    expect(((await first.json()) as { scan: { reportFirstViewedAt: unknown } }).scan).toMatchObject(
      { reportFirstViewedAt: null },
    );
    const afterFirst = await viewColumns(owner.db, scanId);
    expect(afterFirst).toMatchObject({ viewCount: 1, surface: "web" });
    expect(afterFirst.firstViewedAt).toEqual(afterFirst.lastViewedAt);
    // A view is not a change to the review.
    expect(afterFirst.updatedAt).toEqual(before.updatedAt);

    const second = await getDetail(owner, `/api/v1/scans/${scanId}?via=notification`);
    expect(second.status).toBe(200);
    const afterSecond = await viewColumns(owner.db, scanId);
    expect(afterSecond).toMatchObject({
      viewCount: 2,
      surface: "web",
      firstViewedAt: afterFirst.firstViewedAt,
    });
    expect(afterSecond.lastViewedAt!.getTime()).toBeGreaterThanOrEqual(
      afterFirst.lastViewedAt!.getTime(),
    );

    const events = viewEvents(written);
    expect(events).toHaveLength(1);
    expect(events[0].indexes).toEqual(["scan.viewed"]);
    expect(events[0].blobs).toEqual([
      "1",
      "scan.viewed",
      owner.organizationId,
      "npm",
      "auto_discovery",
      "web",
      "none",
      "undecided",
    ]);
    expect(events[0].doubles[0]).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(events[0])).not.toContain(scanId);
  });

  test("a landing from a notification link is recorded as its surface", async () => {
    const written = withAnalytics();
    const owner = await seedUser();
    const scanId = await seedTrackedScan(owner, { registryVersionStatus: "staged" });

    await getDetail(owner, `/api/v1/scans/${scanId}?via=notification`);
    expect(await viewColumns(owner.db, scanId)).toMatchObject({
      viewCount: 1,
      surface: "notification",
    });
    expect(viewEvents(written)[0].blobs.slice(5, 7)).toEqual(["notification", "staged"]);
  });

  test("an unrecognised via value is a web view", async () => {
    const owner = await seedUser();
    const scanId = await seedTrackedScan(owner);
    await getDetail(owner, `/api/v1/scans/${scanId}?via=%3Cscript%3E`);
    expect((await viewColumns(owner.db, scanId)).surface).toBe("web");
  });

  test("loads of a review with no report yet are not views", async () => {
    const written = withAnalytics();
    const owner = await seedUser();
    const scanId = `scan_${crypto.randomUUID()}`;
    await seedLegacyScanJob(owner.db, {
      id: scanId,
      stageId: `stage-${scanId}`,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
    });
    await owner.db.update(scans).set({ reportViewCount: 0 }).where(eq(scans.id, scanId));

    expect((await getDetail(owner, `/api/v1/scans/${scanId}`)).status).toBe(200);
    expect(await viewColumns(owner.db, scanId)).toMatchObject({
      viewCount: 0,
      firstViewedAt: null,
    });
    expect(viewEvents(written)).toHaveLength(0);
  });

  test("another organization's member reads 404 and records nothing", async () => {
    const owner = await seedUser();
    const outsider = await seedUser();
    const scanId = await seedTrackedScan(owner);

    const res = await getDetail(outsider, `/api/v1/scans/${scanId}`);
    expect(res.status).toBe(404);
    expect(await viewColumns(owner.db, scanId)).toMatchObject({
      viewCount: 0,
      firstViewedAt: null,
    });
  });

  test("a review older than view tracking records its loads without claiming a first view", async () => {
    const written = withAnalytics();
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    expect((await viewColumns(owner.db, scanId)).viewCount).toBeNull();

    await getDetail(owner, `/api/v1/scans/${scanId}`);
    const row = await viewColumns(owner.db, scanId);
    expect(row.firstViewedAt).toBeInstanceOf(Date);
    expect(row.viewCount).toBeNull();
    expect(viewEvents(written)).toHaveLength(0);
  });

  test("the detail says whether the report was opened before npm published", async () => {
    const owner = await seedUser();
    const publishedAt = new Date("2026-10-01T12:00:00Z");
    const scanId = await seedTrackedScan(owner, {
      registryPublishedAt: publishedAt,
      reportFirstViewedAt: new Date(publishedAt.getTime() - 60 * 60 * 1000),
      reportViewCount: 1,
    });

    const res = await getDetail(owner, `/api/v1/scans/${scanId}`);
    const body = (await res.json()) as { scan: { reportOpenedBeforePublication: unknown } };
    expect(body.scan.reportOpenedBeforePublication).toBe("opened");
    // A later load leaves the earlier first view, and so the answer, alone.
    const again = (await (await getDetail(owner, `/api/v1/scans/${scanId}`)).json()) as {
      scan: { reportOpenedBeforePublication: unknown; reportViewCount: unknown };
    };
    expect(again.scan).toMatchObject({
      reportOpenedBeforePublication: "opened",
      reportViewCount: 2,
    });
  });

  test("a failed view write never fails the read path's bookkeeping", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = {
      update: () => {
        throw new Error("D1_ERROR: database is locked");
      },
    } as unknown as AppDb;
    await expect(
      recordReportView(
        env,
        failing,
        {
          id: "scan_1",
          organizationId: "org_1",
          source: "manual",
          status: "complete",
          summaryJson: null,
          decision: null,
          completedAt: new Date(),
          registryVersionStatus: null,
          registryStatusSupersededAt: null,
        },
        "web",
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "scan.report_view_record_failed",
      expect.objectContaining({ organizationId: "org_1", scanId: "scan_1" }),
    );
  });
});
