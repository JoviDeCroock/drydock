import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import {
  createPublicationWatch,
  listPublicationWatches,
  PUBLICATION_WATCH_LIMIT,
} from "../../server/db/publication-watches";
import { npmPackageClaims, scans } from "../../server/db/schema";
import { reconcileDuePublicationEnrollments } from "../../server/lib/ecosystems/npm/publication-auto-enrollment";
import { npmPublicationMonitor } from "../../server/lib/ecosystems/npm/publication-monitor";
import worker from "../../server";
import { seedPublicationWatches, seedUser } from "./helpers/seed";

// Which organizations the cron picks depends on every organization in the
// database, so these tests live in their own file: the per-file storage reset
// leaves only what they seed, and each test leaves nothing due behind it.

const registry = "https://registry.npmjs.org";

afterEach(() => vi.restoreAllMocks());

async function addHistory(organizationId: string, packageName: string) {
  const db = createDb(env.DB);
  await db.insert(npmPackageClaims).values({
    registryUrl: registry,
    ecosystem: "npm",
    packageName,
    organizationId,
    firstStageId: `stage-${packageName}`,
    claimedAt: new Date(),
    managementConfirmedAt: new Date(),
  });
  await db.insert(scans).values({
    id: crypto.randomUUID(),
    stageId: `stage-${packageName}`,
    organizationId,
    source: "auto_discovery",
    status: "complete",
    packageName,
    stagedVersion: "1.0.0",
    registryUrl: registry,
    registryPackageName: packageName,
    registryVersion: "1.0.0",
    registryVersionStatus: "published",
    summaryJson: { stagedPublish: { access: "public" } },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function organizationWithHistory(packageName: string) {
  const owner = await seedUser();
  await addHistory(owner.organizationId, packageName);
  return owner;
}

async function watchedNames(organization: Awaited<ReturnType<typeof seedUser>>) {
  return (await listPublicationWatches(organization.db, organization.organizationId)).map(
    (watch) => watch.packageName,
  );
}

function reconciledEvents() {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  return () =>
    log.mock.calls
      .filter(([event]) => event === "npm.publication_monitor.enrollment_reconciled")
      .map(([, fields]) => fields);
}

test("an enrollment failure does not skip checking the watches that already exist", async () => {
  const owner = await seedUser();
  await createPublicationWatch(owner.db, owner.organizationId, "existing-package");
  vi.spyOn(npmPublicationMonitor, "reconcileEnrollment").mockRejectedValue(
    new Error("enrollment unavailable"),
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    Response.json({
      name: decodeURIComponent(String(input).slice(`${registry}/`.length)),
      versions: {},
      time: {},
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const ctx = createExecutionContext();
  await worker.scheduled(
    { scheduledTime: Date.now(), cron: "*/15 * * * *", noRetry() {} } as ScheduledController,
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);

  const [watch] = await listPublicationWatches(owner.db, owner.organizationId);
  expect(watch).toMatchObject({ lastCheckedAt: expect.any(Date), lastError: null });
  expect(errors).toHaveBeenCalledWith(
    "publication_monitor.enrollment_cron_failed",
    expect.objectContaining({ ecosystem: "npm" }),
  );
});

test("a full organization is due once to record its history, then not again until a slot frees", async () => {
  const full = await organizationWithHistory("full-history");
  await seedPublicationWatches(full.db, full.organizationId, PUBLICATION_WATCH_LIMIT);
  const events = reconciledEvents();

  await reconcileDuePublicationEnrollments(full.db, env);
  await reconcileDuePublicationEnrollments(full.db, env);
  expect(events()).toEqual([
    expect.objectContaining({ organizations: 1, failed: 0 }),
    expect.objectContaining({ organizations: 0, failed: 0 }),
  ]);
  expect(await watchedNames(full)).not.toContain("full-history");
});

test("one organization's failed reconciliation does not stop the others, and the next tick retries it", async () => {
  const first = await organizationWithHistory("first-org-history");
  const second = await organizationWithHistory("second-org-history");
  const db = createDb(env.DB);
  // Whichever organization enrolls first gets the failing batch.
  vi.spyOn(db, "batch").mockRejectedValueOnce(new Error("D1 unavailable"));
  const events = reconciledEvents();
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

  await reconcileDuePublicationEnrollments(db, env);
  const watched = [...(await watchedNames(first)), ...(await watchedNames(second))];
  expect(watched).toHaveLength(1);
  expect(events()).toEqual([expect.objectContaining({ organizations: 2, failed: 1 })]);
  expect(warnings).toHaveBeenCalledWith(
    "npm.publication_monitor.enrollment_failed",
    expect.objectContaining({ organizationId: expect.any(String) }),
  );

  await reconcileDuePublicationEnrollments(db, env);
  expect(await watchedNames(first)).toEqual(["first-org-history"]);
  expect(await watchedNames(second)).toEqual(["second-org-history"]);
});

test("a tick reconciles at most its limit of organizations; the rest wait for the next", async () => {
  const organizations = await Promise.all(
    ["capped-a", "capped-b", "capped-c"].map((name) => organizationWithHistory(name)),
  );
  const events = reconciledEvents();
  const watchedCount = async () =>
    (await Promise.all(organizations.map(watchedNames))).filter((names) => names.length > 0).length;

  await reconcileDuePublicationEnrollments(organizations[0]!.db, env, { limit: 2 });
  expect(await watchedCount()).toBe(2);
  await reconcileDuePublicationEnrollments(organizations[0]!.db, env, { limit: 2 });
  expect(await watchedCount()).toBe(3);
  expect(events()).toEqual([
    expect.objectContaining({ organizations: 2 }),
    expect.objectContaining({ organizations: 1 }),
  ]);
});
