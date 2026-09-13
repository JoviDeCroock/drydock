import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
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
  user,
} from "../../server/db/schema";

const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../server/lib/notify", () => ({ notifyPublicationDiscrepancy: notify }));
afterEach(() => {
  vi.restoreAllMocks();
  notify.mockClear();
});

async function setup() {
  const db = createDb(env.DB);
  const id = crypto.randomUUID();
  const now = new Date();
  await db
    .insert(user)
    .values({ id, name: "Watcher", email: `${id}@example.com`, createdAt: now, updatedAt: now });
  const organizationId = await ensurePersonalOrganization(db, { userId: id });
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

test("a monitor check notifies once and the killswitch prevents acquisition", async () => {
  vi.resetModules();
  const { checkNpmPublicationWatch } =
    await import("../../server/lib/ecosystems/npm/publication-monitor");
  const { db, organizationId, watch } = await setup();
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith(".tgz")) return new Response("inert artifact");
    return Response.json({
      name: watch.packageName,
      versions: {
        "1.0.0": {
          name: watch.packageName,
          version: "1.0.0",
          dist: { tarball: "https://registry.npmjs.org/alert-package/-/alert-package-1.0.0.tgz" },
        },
      },
      time: { "1.0.0": watch.createdAt.toISOString() },
    });
  });
  const disabled = {
    ...env,
    FLAGS: { getBooleanValue: vi.fn(async () => false) },
  } as unknown as Cloudflare.Env;
  await checkNpmPublicationWatch(db, disabled, watch);
  expect(fetcher).not.toHaveBeenCalled();
  await checkNpmPublicationWatch(db, env, watch);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({
      organizationId,
      packageName: watch.packageName,
      version: "1.0.0",
      status: "published_without_approval",
    }),
  );
  await db
    .update(publicationWatches)
    .set({ lastCheckedAt: null })
    .where(eq(publicationWatches.id, watch.id));
  await checkNpmPublicationWatch(
    db,
    env,
    (await getPublicationWatch(db, organizationId, watch.id))!,
  );
  expect(notify).toHaveBeenCalledTimes(1);
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
