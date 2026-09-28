import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createPublicationWatch,
  listPublicationWatches,
} from "../../server/db/publication-watches";
import { npmPackageClaims, publicationWatches, scans } from "../../server/db/schema";
import { sweepNpmPublicationWatches } from "../../server/lib/ecosystems/npm/publication-monitor";
import worker from "../../server";
import { seedUser } from "./helpers/seed";

// The sweep considers every organization's watches, so these suites live in
// their own file: the per-file storage reset keeps other suites' watches out
// of the batch under test.

const name = "@drydock/publication-test";

afterEach(() => vi.restoreAllMocks());

function runScheduled() {
  const ctx = createExecutionContext();
  return worker
    .scheduled(
      { scheduledTime: Date.now(), cron: "*/15 * * * *", noRetry() {} } as ScheduledController,
      env,
      ctx,
    )
    .then(() => waitOnExecutionContext(ctx));
}

test("without an npm connection, the scheduled handler checks due watches but enrolls no history", async () => {
  const { db, organizationId } = await seedUser({ name: "Watcher" });
  await createPublicationWatch(db, organizationId, name);
  await db.insert(npmPackageClaims).values({
    registryUrl: "https://registry.npmjs.org",
    ecosystem: "npm",
    packageName: "history-package",
    organizationId,
    firstStageId: "history-stage",
    claimedAt: new Date(),
    managementConfirmedAt: new Date(),
  });
  // With no npm connection there is no discovery sweep, so this history waits
  // for the organization to list its watches.
  await db.insert(scans).values({
    id: crypto.randomUUID(),
    stageId: "history-stage",
    organizationId,
    source: "auto_discovery",
    status: "complete",
    packageName: "history-package",
    stagedVersion: "1.0.0",
    registryUrl: "https://registry.npmjs.org",
    registryPackageName: "history-package",
    registryVersion: "1.0.0",
    registryVersionStatus: "published",
    summaryJson: { stagedPublish: { access: "public" } },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const packageName = decodeURIComponent(url.slice("https://registry.npmjs.org/".length));
    return Response.json({ name: packageName, versions: {}, time: {} });
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  await runScheduled();
  const watches = await listPublicationWatches(db, organizationId);
  expect(watches.map((item) => [item.packageName, item.source])).toEqual([[name, "manual"]]);
  expect(watches.map((item) => [item.lastCheckedAt !== null, item.lastError])).toEqual([
    [true, null],
  ]);
  expect(fetcher).toHaveBeenCalledWith(
    "https://registry.npmjs.org/@drydock%2Fpublication-test",
    expect.objectContaining({ redirect: "manual" }),
  );
});

function emptyRegistry() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const packageName = decodeURIComponent(
      String(input).slice("https://registry.npmjs.org/".length),
    );
    return Response.json({ name: packageName, versions: {}, time: {} });
  });
}

/** An organization with `count` watches, all last checked at `lastCheckedAt`. */
async function organizationWithWatches(count: number, lastCheckedAt: Date | null) {
  const owner = await seedUser();
  const watchIds: string[] = [];
  for (let index = 0; index < count; index++) {
    const watch = await createPublicationWatch(owner.db, owner.organizationId, `pkg-${index}`);
    watchIds.push(watch.id);
  }
  await owner.db
    .update(publicationWatches)
    .set({ lastCheckedAt })
    .where(eq(publicationWatches.organizationId, owner.organizationId));
  return { ...owner, watchIds };
}

async function watchesOf(organization: {
  db: Awaited<ReturnType<typeof seedUser>>["db"];
  organizationId: string;
}) {
  return listPublicationWatches(organization.db, organization.organizationId);
}

function flagsSwitchedOffFor(organizationId: string, behavior: "off" | "throws" = "off") {
  return {
    ...env,
    FLAGS: {
      getBooleanValue: vi.fn(
        async (_flag: string, fallback: boolean, context: { organizationId: string }) => {
          if (context.organizationId !== organizationId) return fallback;
          if (behavior === "throws") throw new Error("flag evaluation failed");
          return false;
        },
      ),
    },
  } as unknown as Cloudflare.Env;
}

describe("the sweep", () => {
  test("a switched-off organization with many due watches cannot starve another", async () => {
    // The switched-off organization holds the oldest watches, which is what
    // used to pin every slot of every tick.
    const switchedOff = await organizationWithWatches(12, null);
    const other = await organizationWithWatches(1, new Date(Date.now() - 10 * 60_000));
    const fetcher = emptyRegistry();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await sweepNpmPublicationWatches(
      switchedOff.db,
      flagsSwitchedOffFor(switchedOff.organizationId),
      {
        budget: 1,
      },
    );
    const [checked] = await watchesOf(other);
    expect(checked?.lastCheckedAt?.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(fetcher).toHaveBeenCalledWith("https://registry.npmjs.org/pkg-0", expect.anything());
    // Every due watch of the switched-off organization moves to the back and
    // says why, without spending the check budget or any egress.
    const deferred = await watchesOf(switchedOff);
    expect(deferred.map((watch) => watch.lastError)).toEqual(Array(12).fill("monitoring_disabled"));
    expect(deferred.every((watch) => watch.lastCheckedAt !== null)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("a watch whose check throws does not stop the sweep or keep its slot", async () => {
    const failing = await organizationWithWatches(3, null);
    const other = await organizationWithWatches(1, new Date(Date.now() - 10 * 60_000));
    emptyRegistry();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await sweepNpmPublicationWatches(
      failing.db,
      flagsSwitchedOffFor(failing.organizationId, "throws"),
      { budget: 2 },
    );
    const [checked] = await watchesOf(other);
    expect(checked).toMatchObject({ lastError: null, lastCheckedAt: expect.any(Date) });
    const failed = await watchesOf(failing);
    expect(failed.map((watch) => watch.lastError)).toEqual([
      "check_failed",
      "check_failed",
      "check_failed",
    ]);
    expect(failed.every((watch) => watch.lastCheckedAt !== null)).toBe(true);
    expect(errors).toHaveBeenCalledWith(
      "npm.publication_monitor.watch_failed",
      expect.objectContaining({ organizationId: failing.organizationId }),
    );
  });

  test("each organization gets at most its round-robin share of a tick", async () => {
    const large = await organizationWithWatches(20, null);
    const medium = await organizationWithWatches(2, null);
    const small = await organizationWithWatches(1, null);
    emptyRegistry();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await sweepNpmPublicationWatches(large.db, env, { budget: 6 });
    const checkedCount = async (organization: typeof large) =>
      (await watchesOf(organization)).filter((watch) => watch.lastCheckedAt !== null).length;
    expect(await checkedCount(small)).toBe(1);
    expect(await checkedCount(medium)).toBe(2);
    expect(await checkedCount(large)).toBe(3);
  });

  test("no check starts once the tick's time budget is spent", async () => {
    const organization = await organizationWithWatches(2, null);
    const fetcher = emptyRegistry();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await sweepNpmPublicationWatches(organization.db, env, { deadlineMs: -1 });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await watchesOf(organization)).every((watch) => watch.lastCheckedAt === null)).toBe(
      true,
    );
  });
});
