import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import { savePublicationObservation } from "../../server/db/publication-alerts";
import {
  createPublicationWatch,
  deletePublicationWatch,
  getPublicationWatch,
  listPublicationObservations,
} from "../../server/db/publication-watches";
import {
  publicationAlerts,
  publicationObservations,
  publicationWatches,
  scanEvents,
  scans,
} from "../../server/db/schema";
import { seedUser } from "./helpers/seed";

const { notify, notifyCoverage } = vi.hoisted(() => ({
  notify: vi.fn(async (): Promise<"delivered" | "failed" | "no_destination"> => "delivered"),
  notifyCoverage: vi.fn(
    async (_input: {
      version: string | null;
      reason: string;
    }): Promise<"delivered" | "failed" | "no_destination"> => "delivered",
  ),
}));
vi.mock("../../server/lib/notify", () => ({
  notifyPublicationDiscrepancy: notify,
  notifyPublicationCoverageGap: notifyCoverage,
}));
afterEach(() => {
  vi.restoreAllMocks();
  for (const mock of [notify, notifyCoverage]) {
    mock.mockReset();
    mock.mockImplementation(async () => "delivered");
  }
});

async function setup() {
  const { db, organizationId } = await seedUser({ name: "Watcher" });
  const watch = await createPublicationWatch(db, organizationId, "alert-package");
  return { db, organizationId, watch };
}

test("observation and durable alert roll back together and concurrent writes deduplicate", async () => {
  const { db, organizationId, watch } = await setup();
  const now = new Date();
  const observation = {
    id: crypto.randomUUID(),
    organizationId,
    watchId: watch.id,
    version: "1.0.0",
    status: "artifact_mismatch" as const,
    firstSeenAt: now,
    checkedAt: now,
  };
  await expect(
    savePublicationObservation(db, observation, null as unknown as string),
  ).rejects.toThrow();
  expect(
    await db
      .select()
      .from(publicationObservations)
      .where(eq(publicationObservations.id, observation.id)),
  ).toEqual([]);
  const results = await Promise.all([
    savePublicationObservation(db, observation, watch.packageName),
    savePublicationObservation(db, observation, watch.packageName),
  ]);
  expect(results.sort()).toEqual([false, true]);
  expect(
    await db
      .select()
      .from(publicationAlerts)
      .where(eq(publicationAlerts.organizationId, organizationId)),
  ).toHaveLength(1);
  expect(
    await db
      .select()
      .from(scanEvents)
      .where(
        and(
          eq(scanEvents.organizationId, organizationId),
          eq(scanEvents.type, "publication.discrepancy"),
        ),
      ),
  ).toHaveLength(1);
  await deletePublicationWatch(db, organizationId, watch.id);
  const replacement = await createPublicationWatch(db, organizationId, watch.packageName);
  expect(
    (await getPublicationWatch(db, organizationId, replacement.id))?.unresolvedAlertCount,
  ).toBe(0);
  expect(
    await savePublicationObservation(
      db,
      { ...observation, id: crypto.randomUUID(), watchId: replacement.id },
      watch.packageName,
    ),
  ).toBe(false);
});

test("all confirmed discrepancy classes alarm but approved and unknown observations do not", async () => {
  const { db, organizationId, watch } = await setup();
  const now = new Date();
  const statuses = [
    "published_without_approval",
    "published_despite_rejection",
    "artifact_mismatch",
    "approved_match",
    "unknown",
  ] as const;
  for (const [index, status] of statuses.entries()) {
    expect(
      await savePublicationObservation(
        db,
        {
          id: crypto.randomUUID(),
          organizationId,
          watchId: watch.id,
          version: `1.0.${index}`,
          status,
          firstSeenAt: now,
          checkedAt: now,
        },
        watch.packageName,
      ),
    ).toBe(index < 3);
  }
  expect(
    await db
      .select()
      .from(publicationAlerts)
      .where(eq(publicationAlerts.organizationId, organizationId)),
  ).toHaveLength(3);
});

function unreviewedRelease(watch: { packageName: string; createdAt: Date }, release = "1.0.0") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({
      name: watch.packageName,
      versions: {
        [release]: {
          name: watch.packageName,
          version: release,
          dist: {
            tarball: `https://registry.npmjs.org/alert-package/-/alert-package-${release}.tgz`,
          },
        },
      },
      time: { [release]: watch.createdAt.toISOString() },
    }),
  );
}

async function recheck(
  db: Awaited<ReturnType<typeof setup>>["db"],
  organizationId: string,
  watchId: string,
  checkEnv: Cloudflare.Env = env,
) {
  const { checkNpmPublicationWatch } =
    await import("../../server/lib/ecosystems/npm/publication-monitor");
  await db
    .update(publicationWatches)
    .set({ lastCheckedAt: null })
    .where(eq(publicationWatches.id, watchId));
  await checkNpmPublicationWatch(
    db,
    checkEnv,
    (await getPublicationWatch(db, organizationId, watchId))!,
  );
}

async function alertRow(db: Awaited<ReturnType<typeof setup>>["db"], organizationId: string) {
  const [alert] = await db
    .select()
    .from(publicationAlerts)
    .where(eq(publicationAlerts.organizationId, organizationId));
  return alert;
}

test("a monitor check notifies once and the killswitch prevents acquisition", async () => {
  vi.resetModules();
  const { db, organizationId, watch } = await setup();
  const fetcher = unreviewedRelease(watch);
  const disabled = {
    ...env,
    FLAGS: { getBooleanValue: vi.fn(async () => false) },
  } as unknown as Cloudflare.Env;
  await recheck(db, organizationId, watch.id, disabled);
  expect(fetcher).not.toHaveBeenCalled();
  // Switched off still leases the watch and says why, so it cannot hold a slot.
  expect(await getPublicationWatch(db, organizationId, watch.id)).toMatchObject({
    lastCheckedAt: expect.any(Date),
    lastError: "monitoring_disabled",
  });
  await recheck(db, organizationId, watch.id);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({
      organizationId,
      packageName: watch.packageName,
      version: "1.0.0",
      status: "published_without_approval",
    }),
  );
  expect((await getPublicationWatch(db, organizationId, watch.id))?.lastError).toBeNull();
  await recheck(db, organizationId, watch.id);
  expect(notify).toHaveBeenCalledTimes(1);
});

test("a failed delivery stays pending and is re-sent on the next check until one lands", async () => {
  vi.resetModules();
  const { db, organizationId, watch } = await setup();
  unreviewedRelease(watch);
  notify.mockImplementation(async () => "failed");
  await recheck(db, organizationId, watch.id);
  // One attempt per check: the alert that just failed is not redriven at once.
  expect(notify).toHaveBeenCalledTimes(1);
  expect((await alertRow(db, organizationId))?.notifiedAt).toBeNull();

  await recheck(db, organizationId, watch.id);
  expect(notify).toHaveBeenCalledTimes(2);
  expect((await alertRow(db, organizationId))?.notifiedAt).toBeNull();

  notify.mockImplementation(async () => "delivered");
  await recheck(db, organizationId, watch.id);
  expect(notify).toHaveBeenCalledTimes(3);
  expect(notify).toHaveBeenLastCalledWith(
    expect.objectContaining({ version: "1.0.0", status: "published_without_approval" }),
  );
  expect((await alertRow(db, organizationId))?.notifiedAt).toBeInstanceOf(Date);

  await recheck(db, organizationId, watch.id);
  expect(notify).toHaveBeenCalledTimes(3);
});

test("an organization with nowhere to deliver is recorded once rather than retried forever", async () => {
  vi.resetModules();
  const { db, organizationId, watch } = await setup();
  unreviewedRelease(watch);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  notify.mockImplementation(async () => "no_destination");
  await recheck(db, organizationId, watch.id);
  expect((await alertRow(db, organizationId))?.notifiedAt).toBeInstanceOf(Date);
  expect(warn).toHaveBeenCalledWith(
    "npm.publication_monitor.notification_undeliverable",
    expect.objectContaining({ organizationId, watchId: watch.id }),
  );
  await recheck(db, organizationId, watch.id);
  expect(notify).toHaveBeenCalledTimes(1);
});

test("a re-enrolled watch never re-sends an alert from the window that was stopped", async () => {
  vi.resetModules();
  const { db, organizationId, watch } = await setup();
  unreviewedRelease(watch);
  notify.mockImplementation(async () => "failed");
  await recheck(db, organizationId, watch.id);
  expect(notify).toHaveBeenCalledTimes(1);
  expect((await alertRow(db, organizationId))?.notifiedAt).toBeNull();

  await deletePublicationWatch(db, organizationId, watch.id);
  const replacement = await createPublicationWatch(db, organizationId, watch.packageName);
  notify.mockImplementation(async () => "delivered");
  vi.restoreAllMocks();
  unreviewedRelease(replacement, "2.0.0");
  await recheck(db, organizationId, replacement.id);
  // The replacement's own new release alerts; the stopped window's does not.
  expect(notify).toHaveBeenCalledTimes(2);
  expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ version: "2.0.0" }));
  await recheck(db, organizationId, replacement.id);
  expect(notify).toHaveBeenCalledTimes(2);
});

test("a stale conflicting verdict cannot alarm after an approval observation wins", async () => {
  const { db, organizationId, watch } = await setup();
  const now = new Date();
  const observation = {
    id: crypto.randomUUID(),
    organizationId,
    watchId: watch.id,
    version: "1.0.0",
    status: "approved_match" as const,
    firstSeenAt: now,
    checkedAt: now,
  };
  await savePublicationObservation(db, observation, watch.packageName);
  expect(
    await savePublicationObservation(
      db,
      { ...observation, status: "artifact_mismatch" },
      watch.packageName,
    ),
  ).toBe(false);
  expect(
    await db
      .select()
      .from(publicationAlerts)
      .where(eq(publicationAlerts.organizationId, organizationId)),
  ).toEqual([]);
  expect(
    await db
      .select()
      .from(publicationObservations)
      .where(eq(publicationObservations.id, observation.id)),
  ).toMatchObject([{ status: "approved_match" }]);
});

test("unacknowledged alerts remain actionable beyond the newest hundred observations", async () => {
  const { db, organizationId, watch } = await setup();
  const id = crypto.randomUUID();
  await savePublicationObservation(
    db,
    {
      id,
      organizationId,
      watchId: watch.id,
      version: "1.0.0",
      status: "artifact_mismatch",
      firstSeenAt: new Date(0),
      checkedAt: new Date(0),
    },
    watch.packageName,
  );
  for (let offset = 0; offset < 100; offset += 10) {
    await db.insert(publicationObservations).values(
      Array.from({ length: 10 }, (_, index) => ({
        id: crypto.randomUUID(),
        organizationId,
        watchId: watch.id,
        version: `2.0.${offset + index}`,
        status: "approved_match" as const,
        firstSeenAt: new Date(),
        checkedAt: new Date(),
      })),
    );
  }
  const observations = await listPublicationObservations(db, organizationId, watch.id);
  expect(observations).toHaveLength(100);
  expect(observations[0]?.id).toBe(id);
});

async function pendingAlert(
  db: Awaited<ReturnType<typeof setup>>["db"],
  organizationId: string,
  watch: { id: string; packageName: string },
  reason: string | null,
) {
  const now = new Date();
  await savePublicationObservation(
    db,
    {
      id: crypto.randomUUID(),
      organizationId,
      watchId: watch.id,
      version: "1.0.0",
      publishedAt: now,
      firstSeenAt: now,
      checkedAt: now,
      status: "published_without_approval",
      reason,
    },
    watch.packageName,
  );
}

async function setDeliveryClaim(
  db: Awaited<ReturnType<typeof setup>>["db"],
  organizationId: string,
  claimedAt: Date | null,
) {
  await db
    .update(publicationAlerts)
    .set({ deliveryClaimedAt: claimedAt })
    .where(eq(publicationAlerts.organizationId, organizationId));
}

test("a redelivered alert carries the reason recorded on its observation", async () => {
  vi.resetModules();
  const { db, organizationId, watch } = await setup();
  unreviewedRelease(watch);
  await pendingAlert(db, organizationId, watch, "review_pending");
  await setDeliveryClaim(db, organizationId, null);
  await recheck(db, organizationId, watch.id);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({
      version: "1.0.0",
      status: "published_without_approval",
      reason: "review_pending",
    }),
  );
});

test("an alert another check is delivering is not sent again until its claim lapses", async () => {
  vi.resetModules();
  const { db, organizationId, watch } = await setup();
  unreviewedRelease(watch);
  // Created by a check that is still delivering it (a long check overlapping
  // a manual one): the claim is fresh.
  await pendingAlert(db, organizationId, watch, null);
  await recheck(db, organizationId, watch.id);
  expect(notify).not.toHaveBeenCalled();

  // That delivery died without releasing its claim; once the lease lapses,
  // a later check takes it over.
  await setDeliveryClaim(db, organizationId, new Date(Date.now() - 10 * 60_000));
  await recheck(db, organizationId, watch.id);
  expect(notify).toHaveBeenCalledTimes(1);
  expect((await alertRow(db, organizationId))?.notifiedAt).toBeInstanceOf(Date);
});

function oversizedMetadata() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () => new Response("{}", { headers: { "content-length": String(65 * 1024 * 1024) } }),
    );
}

test("a package-wide coverage gap is told once, after it persists, in its own words", async () => {
  vi.resetModules();
  const { db, organizationId, watch } = await setup();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  oversizedMetadata();
  await recheck(db, organizationId, watch.id);
  // A fresh problem is only the watch's last problem, not yet a gap to report.
  expect(notifyCoverage).not.toHaveBeenCalled();
  expect(await getPublicationWatch(db, organizationId, watch.id)).toMatchObject({
    coverageGap: "registry_metadata_too_large",
    coverageGapNotifiedAt: null,
  });

  await db
    .update(publicationWatches)
    .set({ coverageGapSince: new Date(Date.now() - 2 * 60 * 60 * 1000) })
    .where(eq(publicationWatches.id, watch.id));
  notifyCoverage.mockImplementationOnce(async () => "failed");
  await recheck(db, organizationId, watch.id);
  // A failed delivery gives the notice back for the next check.
  expect(
    (await getPublicationWatch(db, organizationId, watch.id))?.coverageGapNotifiedAt,
  ).toBeNull();
  await recheck(db, organizationId, watch.id);
  await recheck(db, organizationId, watch.id);
  expect(notifyCoverage).toHaveBeenCalledTimes(2);
  expect(notifyCoverage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      organizationId,
      packageName: watch.packageName,
      version: null,
      reason: "registry_metadata_too_large",
    }),
  );
  expect(notify).not.toHaveBeenCalled();

  // A check that reads the package again clears the gap.
  vi.restoreAllMocks();
  unreviewedRelease(watch);
  await recheck(db, organizationId, watch.id);
  expect(await getPublicationWatch(db, organizationId, watch.id)).toMatchObject({
    coverageGap: null,
    coverageGapSince: null,
  });
});

test("a release that stays unverifiable with nothing vouching is told once", async () => {
  vi.resetModules();
  const { db, organizationId, watch } = await setup();
  const now = new Date(Date.now() - 2 * 60 * 60 * 1000);
  unreviewedRelease(watch);
  for (const [version, reason, scanId] of [
    ["1.0.0", "artifact_too_large", null],
    ["1.0.1", "artifact_timeout", null],
    // Resting on a record (npm's shasum matched an approval): not a gap.
    ["1.0.2", "artifact_too_large", "scan"],
  ] as const) {
    if (scanId) {
      await db.insert(scans).values({
        id: scanId,
        stageId: "stage",
        organizationId,
        packageName: watch.packageName,
        stagedVersion: version,
        status: "complete",
        source: "auto_discovery",
        createdAt: now,
        updatedAt: now,
      });
    }
    await savePublicationObservation(
      db,
      {
        id: crypto.randomUUID(),
        organizationId,
        watchId: watch.id,
        version,
        publishedAt: now,
        firstSeenAt: now,
        checkedAt: new Date(),
        status: "unknown",
        reason,
        scanId,
      },
      watch.packageName,
    );
  }
  await recheck(db, organizationId, watch.id);
  await recheck(db, organizationId, watch.id);
  expect(notifyCoverage).toHaveBeenCalledTimes(2);
  expect(notifyCoverage.mock.calls.map(([input]) => [input.version, input.reason]).sort()).toEqual([
    ["1.0.0", "artifact_too_large"],
    ["1.0.1", "artifact_timeout"],
  ]);
  expect((await getPublicationWatch(db, organizationId, watch.id))?.unverifiedReleaseCount).toBe(2);
});
