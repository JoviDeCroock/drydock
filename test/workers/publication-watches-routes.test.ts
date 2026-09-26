import { env } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import { and, eq } from "drizzle-orm";
import { addOrganizationMember } from "../../server/db/invitations";
import { savePublicationObservation } from "../../server/db/publication-alerts";
import {
  createPublicationWatch,
  deletePublicationWatch,
} from "../../server/db/publication-watches";
import {
  npmPackageClaims,
  publicationWatchCandidates,
  scanEvents,
  scans,
} from "../../server/db/schema";
import { npmPublicationWatchRoutes } from "../../server/routes/npm-publication-watches";
import type { Bindings } from "../../server/types";
import { buildTestApp, call, type TestApp } from "./helpers/app";
import { seedUser } from "./helpers/seed";
import { seedLegacyScanJob } from "./helpers/seed-scan-job";

const seedOwner = () => seedUser({ name: "Publication reviewer" });

/** Staged reviews make an organization a competing (or former) package manager. */
async function seedStagedHistory(
  seeded: Awaited<ReturnType<typeof seedOwner>>,
  packageName: string,
  registryUrl: string | null = "https://registry.npmjs.org",
) {
  await seedLegacyScanJob(createDb(env.DB), {
    id: crypto.randomUUID(),
    stageId: crypto.randomUUID(),
    organizationId: seeded.organizationId,
    ownerUserId: seeded.userId,
    source: "manual",
    packageName,
    stagedVersion: "0.9.0",
    registryUrl,
  });
}

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
    {
      body:
        method === "POST" && path === "" && body && typeof body === "object"
          ? { confirmPersonalOrganization: true, ...body }
          : body,
      activeOrganizationId: requestedOrganizationId,
    },
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
  await createDb(env.DB).insert(npmPackageClaims).values({
    registryUrl: "https://registry.npmjs.org",
    ecosystem: "npm",
    packageName: "@scope/history",
    organizationId: owner.organizationId,
    firstStageId: "historical-stage",
    claimedAt: new Date(),
    managementConfirmedAt: new Date(),
  });

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

test("only integration managers can stop a watch; enrolling and stopping are audited", async () => {
  const owner = await seedOwner();
  const member = await seedUser({ name: "Member" });
  const admin = await seedUser({ name: "Admin" });
  const db = createDb(env.DB);
  await addOrganizationMember(db, {
    organizationId: owner.organizationId,
    userId: member.userId,
    role: "member",
  });
  await addOrganizationMember(db, {
    organizationId: owner.organizationId,
    userId: admin.userId,
    role: "admin",
  });
  // Any member may add monitoring.
  const created = await request(
    member,
    "POST",
    "",
    { packageName: "audited-package" },
    owner.organizationId,
  );
  expect(created.status).toBe(201);
  const { watch } = await created.json<{ watch: { id: string } }>();

  // Stopping deletes alert history and persists an opt-out: members are refused.
  const refused = await request(member, "DELETE", `/${watch.id}`, undefined, owner.organizationId);
  expect(refused.status).toBe(403);
  expect(
    (await request(member, "GET", `/${watch.id}`, undefined, owner.organizationId)).status,
  ).toBe(200);
  expect(
    (await request(admin, "DELETE", `/${watch.id}`, undefined, owner.organizationId)).status,
  ).toBe(200);

  const events = await db
    .select()
    .from(scanEvents)
    .where(eq(scanEvents.organizationId, owner.organizationId));
  expect(
    events
      .filter((event) => event.type.startsWith("publication_watch."))
      .map((event) => [event.type, event.actorUserId, event.metadataJson])
      .sort(),
  ).toEqual([
    ["publication_watch.started", member.userId, { packageName: "audited-package" }],
    ["publication_watch.stopped", admin.userId, { packageName: "audited-package" }],
  ]);
});

describe("one package's monitoring for the package page", () => {
  const path = (name: string) => `/packages/${name}`;

  test("returns the organization's own watch and observations, never another's", async () => {
    const owner = await seedOwner();
    const outsider = await seedOwner();
    const db = createDb(env.DB);
    const watch = await createPublicationWatch(db, owner.organizationId, "@scope/watched");
    const now = new Date();
    await savePublicationObservation(
      db,
      {
        id: crypto.randomUUID(),
        watchId: watch.id,
        organizationId: owner.organizationId,
        version: "1.0.0",
        publishedAt: now,
        firstSeenAt: now,
        checkedAt: now,
        status: "unknown",
        reason: "review_pending",
      },
      watch.packageName,
    );
    const mine = await request(owner, "GET", path("@scope/watched"));
    expect(mine.status).toBe(200);
    expect(mine.headers.get("cache-control")).toBe("private, no-store");
    expect(await mine.json()).toMatchObject({
      packageName: "@scope/watched",
      watch: { id: watch.id, unresolvedAlertCount: 0 },
      observations: [{ version: "1.0.0", status: "unknown", reason: "review_pending" }],
      enrollment: { state: "watched" },
      viewer: { canStop: true },
    });
    // The name is a filter over the caller's organization, and an explicit
    // selector for an organization they do not belong to grants nothing.
    for (const selector of [undefined, owner.organizationId]) {
      const theirs = await request(outsider, "GET", path("@scope/watched"), undefined, selector);
      expect(await theirs.json()).toEqual({
        packageName: "@scope/watched",
        ownershipConflict: false,
        managementPending: false,
        watch: null,
        observations: [],
        alerts: [],
        moreAlerts: false,
        enrollment: { state: "not_enrolled" },
        viewer: { canStop: true },
      });
    }
  });

  test("keeps the alert ledger visible across a stop and a re-enrollment", async () => {
    const owner = await seedOwner();
    const db = createDb(env.DB);
    const first = await createPublicationWatch(db, owner.organizationId, "ledger-package");
    const now = new Date();
    await savePublicationObservation(
      db,
      {
        id: crypto.randomUUID(),
        watchId: first.id,
        organizationId: owner.organizationId,
        version: "1.0.0",
        publishedAt: now,
        firstSeenAt: now,
        checkedAt: now,
        status: "published_without_approval",
      },
      first.packageName,
    );
    await deletePublicationWatch(db, owner.organizationId, first.id);
    const second = await createPublicationWatch(db, owner.organizationId, "ledger-package");
    const load = async () =>
      (await request(owner, "GET", path("ledger-package"))).json<{
        observations: unknown[];
        alerts: unknown[];
        moreAlerts: boolean;
      }>();
    const body = await load();
    expect(body.observations).toEqual([]);
    expect(body.alerts).toEqual([
      {
        version: "1.0.0",
        status: "published_without_approval",
        createdAt: expect.any(String),
        acknowledgedAt: null,
        inCurrentWatch: false,
      },
    ]);
    // An alert of the current window says so, whether or not its observation
    // is among those the page lists.
    await savePublicationObservation(
      db,
      {
        id: crypto.randomUUID(),
        watchId: second.id,
        organizationId: owner.organizationId,
        version: "2.0.0",
        publishedAt: now,
        firstSeenAt: now,
        checkedAt: now,
        status: "artifact_mismatch",
      },
      second.packageName,
    );
    const alerts = (await load()).alerts;
    expect(alerts).toHaveLength(2);
    expect(alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: "2.0.0", inCurrentWatch: true }),
        expect.objectContaining({ version: "1.0.0", inCurrentWatch: false }),
      ]),
    );
  });

  test("lists the latest fifty alerts and says when the ledger holds more", async () => {
    const owner = await seedOwner();
    const db = createDb(env.DB);
    const watch = await createPublicationWatch(db, owner.organizationId, "busy-package");
    for (let index = 0; index < 51; index++) {
      const at = new Date(Date.now() - (51 - index) * 1000);
      await savePublicationObservation(
        db,
        {
          id: crypto.randomUUID(),
          watchId: watch.id,
          organizationId: owner.organizationId,
          version: `1.0.${index}`,
          publishedAt: at,
          firstSeenAt: at,
          checkedAt: at,
          status: "published_without_approval",
        },
        watch.packageName,
      );
    }
    const body = await (
      await request(owner, "GET", path("busy-package"))
    ).json<{ alerts: { version: string }[]; moreAlerts: boolean }>();
    expect(body.alerts).toHaveLength(50);
    expect(body.moreAlerts).toBe(true);
  });

  test("explains why a package is not watched", async () => {
    const owner = await seedOwner();
    const db = createDb(env.DB);
    const stopped = await createPublicationWatch(db, owner.organizationId, "stopped-package");
    await deletePublicationWatch(db, owner.organizationId, stopped.id);
    const candidate = (packageName: string, source: "workflow_gate" | "staged_discovery") => ({
      id: crypto.randomUUID(),
      organizationId: owner.organizationId,
      packageName,
      source,
      createdAt: new Date(),
      stoppedAt: null,
    });
    await db
      .insert(publicationWatchCandidates)
      .values([
        candidate("gate-package", "workflow_gate"),
        candidate("discovered-package", "staged_discovery"),
      ]);
    const state = async (name: string) =>
      (await (await request(owner, "GET", path(name))).json<{ enrollment: unknown }>()).enrollment;
    expect(await state("stopped-package")).toEqual({
      state: "stopped",
      stoppedAt: expect.any(String),
    });
    expect(await state("gate-package")).toEqual({ state: "suggested" });
    expect(await state("discovered-package")).toEqual({ state: "pending" });
    expect(await state("never-seen")).toEqual({ state: "not_enrolled" });
    for (let index = 0; index < 20; index++) {
      await createPublicationWatch(db, owner.organizationId, `filler-${index}`);
    }
    expect(await state("discovered-package")).toEqual({ state: "deferred" });
  });

  test("tells a member they cannot stop the watch and rejects an invalid name", async () => {
    const owner = await seedOwner();
    const member = await seedUser({ name: "Member" });
    const db = createDb(env.DB);
    await addOrganizationMember(db, {
      organizationId: owner.organizationId,
      userId: member.userId,
      role: "member",
    });
    await createPublicationWatch(db, owner.organizationId, "shared-package");
    const response = await request(
      member,
      "GET",
      path("shared-package"),
      undefined,
      owner.organizationId,
    );
    expect(await response.json()).toMatchObject({
      watch: { packageName: "shared-package" },
      viewer: { canStop: false },
    });
    expect((await request(owner, "GET", path("Not A Package"))).status).toBe(400);
  });
});

test("a manual check that fails after claiming the watch reports the failure, not coverage", async () => {
  const owner = await seedOwner();
  const db = createDb(env.DB);
  const watch = await createPublicationWatch(db, owner.organizationId, "failing-package");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await call(
    buildTestApp(mountPublicationWatches, owner),
    "POST",
    `/api/v1/publication-watches/${watch.id}/check`,
    {
      envOverride: {
        FLAGS: {
          getBooleanValue: async () => {
            throw new Error("flag store unavailable");
          },
        } as unknown as Bindings["FLAGS"],
      },
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    watch: { id: watch.id, lastCheckedAt: expect.any(String), lastError: "check_failed" },
    observations: [],
  });
  expect(error).toHaveBeenCalledWith(
    "npm.publication_monitor.watch_failed",
    expect.objectContaining({ organizationId: owner.organizationId, watchId: watch.id }),
  );
  error.mockRestore();
});

test("another organization's claim leaves third-party monitoring and its answers unchanged", async () => {
  const owner = await seedOwner();
  const bystander = await seedOwner();
  const db = createDb(env.DB);
  const packageName = `bystander-${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(npmPackageClaims).values({
    registryUrl: "https://registry.npmjs.org",
    ecosystem: "npm",
    packageName,
    organizationId: owner.organizationId,
    firstStageId: "stage-owner",
    claimedAt: new Date(),
    managementConfirmedAt: new Date(),
  });
  const unwatched = await (await request(bystander, "GET", `/packages/${packageName}`)).json();
  expect(unwatched).toMatchObject({ packageName, ownershipConflict: false, watch: null });
  const created = await request(bystander, "POST", "", { packageName });
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({ watch: { ownershipConflict: false } });
  await db
    .update(npmPackageClaims)
    .set({ organizationId: null })
    .where(eq(npmPackageClaims.packageName, packageName));
  expect(await (await request(bystander, "GET", `/packages/${packageName}`)).json()).toMatchObject({
    ownershipConflict: false,
    watch: { ownershipConflict: false },
  });
});

test("claim conflicts reject a competing manager's enrollment and checks while retaining existing observation history", async () => {
  const owner = await seedOwner();
  const outsider = await seedOwner();
  const db = createDb(env.DB);
  await seedStagedHistory(outsider, "claimed-package");
  const watch = await createPublicationWatch(db, outsider.organizationId, "claimed-package");
  const observationId = crypto.randomUUID();
  const now = new Date();
  await savePublicationObservation(
    db,
    {
      id: observationId,
      watchId: watch.id,
      organizationId: outsider.organizationId,
      version: "1.0.0",
      firstSeenAt: now,
      checkedAt: now,
      status: "unknown",
    },
    "claimed-package",
  );
  await db.insert(npmPackageClaims).values({
    registryUrl: "https://registry.npmjs.org",
    ecosystem: "npm",
    packageName: "claimed-package",
    organizationId: owner.organizationId,
    firstStageId: "stage-owner",
    claimedAt: new Date(),
    managementConfirmedAt: new Date(),
  });
  expect((await request(outsider, "POST", "", { packageName: "claimed-package" })).status).toBe(
    409,
  );
  expect((await request(outsider, "POST", `/${watch.id}/check`)).status).toBe(409);
  expect(await (await request(outsider, "GET", `/${watch.id}`)).json()).toMatchObject({
    watch: { id: watch.id, ownershipConflict: true, lastCheckedAt: null },
    observations: [{ id: observationId, version: "1.0.0" }],
  });
  expect(await (await request(outsider, "GET")).json()).toMatchObject({
    watches: [{ id: watch.id, ownershipConflict: true }],
  });
  expect((await request(owner, "POST", "", { packageName: "claimed-package" })).status).toBe(201);
  expect((await request(outsider, "DELETE", `/${watch.id}`)).status).toBe(200);
  expect(await (await request(outsider, "GET", "/packages/claimed-package")).json()).toMatchObject({
    packageName: "claimed-package",
    ownershipConflict: true,
    watch: null,
  });
  expect(
    await db
      .select()
      .from(npmPackageClaims)
      .where(eq(npmPackageClaims.packageName, "claimed-package")),
  ).toHaveLength(1);
});

test("wildcard reservations block a competing manager's watches until an exact registry claim resolves ownership", async () => {
  const owner = await seedOwner();
  const bystander = await seedOwner();
  const db = createDb(env.DB);
  const packageName = `reserved-${crypto.randomUUID().slice(0, 8)}`;
  await seedStagedHistory(owner, packageName, null);
  const claim = {
    ecosystem: "npm" as const,
    packageName,
    firstStageId: "legacy-stage",
    claimedAt: new Date(),
    managementConfirmedAt: new Date(),
  };
  await db.insert(npmPackageClaims).values({ ...claim, registryUrl: "*", organizationId: null });
  expect((await request(owner, "POST", "", { packageName })).status).toBe(409);
  expect((await request(bystander, "POST", "", { packageName })).status).toBe(201);
  await db.insert(npmPackageClaims).values({
    ...claim,
    registryUrl: "https://registry.npmjs.org",
    organizationId: owner.organizationId,
  });
  const response = await request(owner, "POST", "", { packageName });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ watch: { ownershipConflict: false } });
});

test("personal watch enrollment requires an explicit boolean confirmation", async () => {
  const owner = await seedOwner();
  const app = buildTestApp(mountPublicationWatches, owner);
  for (const confirmPersonalOrganization of [undefined, false, "true"]) {
    const response = await call(app, "POST", "/api/v1/publication-watches", {
      body: { packageName: "personal-watch-choice", confirmPersonalOrganization },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "package_management_required" });
  }
  const confirmed = await call(app, "POST", "/api/v1/publication-watches", {
    body: { packageName: "personal-watch-choice", confirmPersonalOrganization: true },
  });
  expect(confirmed.status).toBe(201);
});
