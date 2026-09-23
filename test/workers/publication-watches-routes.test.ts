import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { and, eq } from "drizzle-orm";
import { savePublicationObservation } from "../../server/db/publication-alerts";
import { createPublicationWatch } from "../../server/db/publication-watches";
import { scanEvents, scans } from "../../server/db/schema";
import { npmPublicationWatchRoutes } from "../../server/routes/npm-publication-watches";
import { buildTestApp, call, type TestApp } from "./helpers/app";
import { seedUser } from "./helpers/seed";

const seedOwner = () => seedUser({ name: "Publication reviewer" });

const mountPublicationWatches = (app: TestApp) => {
  app.route("/api/v1/publication-watches", npmPublicationWatchRoutes);
};

function request(
  owner: { userId: string },
  method: string,
  path = "",
  body?: unknown,
  requestedOrganizationId?: string,
) {
  return call(
    buildTestApp(mountPublicationWatches, owner),
    method,
    `/api/v1/publication-watches${path}`,
    { body, activeOrganizationId: requestedOrganizationId },
  );
}

test("enrolls a public package without an existing scan or npm connection", async () => {
  const owner = await seedOwner();
  const created = await request(owner, "POST", "", { packageName: "@scope/new-package" });
  expect(created.status).toBe(201);
  const { watch } = await created.json<{
    watch: { id: string; packageName: string; createdAt: string };
  }>();
  expect(watch.packageName).toBe("@scope/new-package");
  expect(Number.isFinite(Date.parse(watch.createdAt))).toBe(true);
  const listed = await request(owner, "GET");
  expect(listed.headers.get("cache-control")).toBe("private, no-store");
  expect(await listed.json()).toMatchObject({ watches: [{ id: watch.id }] });
  const detail = await request(owner, "GET", `/${watch.id}`);
  expect(await detail.json()).toMatchObject({ watch: { id: watch.id }, observations: [] });
  expect((await request(owner, "DELETE", `/${watch.id}`)).status).toBe(200);
  expect((await request(owner, "GET", `/${watch.id}`)).status).toBe(404);
});

test("watch IDs and organization selectors never grant access to another organization", async () => {
  const owner = await seedOwner();
  const outsider = await seedOwner();
  const created = await request(owner, "POST", "", { packageName: "preact" });
  const { watch } = await created.json<{ watch: { id: string } }>();
  for (const [method, suffix] of [
    ["GET", ""],
    ["DELETE", ""],
    ["POST", "/check"],
  ]) {
    const response = await request(
      outsider,
      method!,
      `/${watch.id}${suffix}`,
      undefined,
      owner.organizationId!,
    );
    expect(response.status).toBe(404);
  }
  const response = await request(outsider, "GET", "", undefined, owner.organizationId!);
  expect(await response.json()).toMatchObject({
    watches: [],
    autoEnrollment: { deferred: 0, suggestions: [] },
  });
  expect((await request(owner, "GET", `/${watch.id}`)).status).toBe(200);
});

test("rejects URL and malformed package enrollment and preserves enrollment time on duplicates", async () => {
  const owner = await seedOwner();
  for (const packageName of ["https://example.com/pkg", "../package", "bad name", "", 42]) {
    expect((await request(owner, "POST", "", { packageName })).status).toBe(400);
  }
  const first = await request(owner, "POST", "", { packageName: "preact" });
  const second = await request(owner, "POST", "", { packageName: "preact" });
  expect(await second.json()).toEqual(await first.json());
});

test("GET derives historical public publishers, preserves opt-out and permits explicit reenrollment", async () => {
  const owner = await seedOwner();
  const now = new Date();
  await createDb(env.DB)
    .insert(scans)
    .values({
      id: crypto.randomUUID(),
      stageId: "stage-auto-history",
      organizationId: owner.organizationId!,
      source: "auto_discovery",
      status: "complete",
      packageName: "@scope/history",
      stagedVersion: "1.0.0",
      registryUrl: "https://registry.npmjs.org",
      registryPackageName: "@scope/history",
      registryVersion: "1.0.0",
      registryVersionStatus: "published",
      registryVersionStatusAt: now,
      summaryJson: { stagedPublish: { access: "public" } },
      createdAt: new Date(0),
      updatedAt: now,
    });
  const listed = await request(owner, "GET");
  const body = await listed.json<{
    watches: Array<{ id: string; source: string; createdAt: string }>;
    autoEnrollment: { deferred: number };
  }>();
  expect(body.watches).toHaveLength(1);
  expect(body.watches[0]?.source).toBe("published_history");
  expect(Date.parse(body.watches[0]!.createdAt)).toBeGreaterThanOrEqual(now.getTime());
  expect(body.autoEnrollment.deferred).toBe(0);
  await request(owner, "DELETE", `/${body.watches[0]!.id}`);
  expect(await (await request(owner, "GET")).json()).toMatchObject({ watches: [] });
  const reenrolled = await request(owner, "POST", "", { packageName: "@scope/history" });
  expect(await reenrolled.json()).toMatchObject({ watch: { source: "manual" } });
  expect(await (await request(owner, "GET")).json()).toMatchObject({
    watches: [{ source: "manual" }],
  });
});

test("acknowledgment is scoped, idempotent, audited and preserves discrepancy evidence", async () => {
  const owner = await seedOwner();
  const outsider = await seedOwner();
  const db = createDb(env.DB);
  const watch = await createPublicationWatch(db, owner.organizationId, "alerted-package");
  const otherWatch = await createPublicationWatch(db, owner.organizationId, "different-package");
  await createPublicationWatch(db, outsider.organizationId, "alerted-package");
  const observationId = crypto.randomUUID();
  const now = new Date();
  await savePublicationObservation(
    db,
    {
      id: observationId,
      watchId: watch.id,
      organizationId: owner.organizationId,
      version: "1.0.0",
      publishedAt: now,
      firstSeenAt: now,
      checkedAt: now,
      status: "artifact_mismatch",
    },
    watch.packageName,
  );
  const listed = await request(owner, "GET");
  expect(await listed.json()).toMatchObject({
    watches: expect.arrayContaining([
      { ...otherWatch, createdAt: otherWatch.createdAt.toISOString(), unresolvedAlertCount: 0 },
      expect.objectContaining({ id: watch.id, unresolvedAlertCount: 1 }),
    ]),
  });
  expect(await (await request(outsider, "GET")).json()).toMatchObject({
    watches: [expect.objectContaining({ unresolvedAlertCount: 0 })],
  });
  const path = `/${watch.id}/observations/${observationId}/acknowledge`;
  expect((await request(outsider, "POST", path)).status).toBe(404);
  expect(
    (await request(owner, "POST", `/${otherWatch.id}/observations/${observationId}/acknowledge`))
      .status,
  ).toBe(404);
  const first = await request(owner, "POST", path);
  expect(first.status).toBe(200);
  const result = await first.json<{ observations: { acknowledgedAt: string }[] }>();
  expect(result).toMatchObject({
    watch: { unresolvedAlertCount: 0 },
    observations: [{ status: "artifact_mismatch", acknowledgedAt: expect.any(String) }],
  });
  expect(await (await request(owner, "POST", path)).json()).toEqual(result);
  const events = await db
    .select()
    .from(scanEvents)
    .where(
      and(
        eq(scanEvents.organizationId, owner.organizationId),
        eq(scanEvents.type, "publication.acknowledged"),
      ),
    );
  expect(events).toHaveLength(1);
  expect(events[0]?.actorUserId).toBe(owner.userId);
});
