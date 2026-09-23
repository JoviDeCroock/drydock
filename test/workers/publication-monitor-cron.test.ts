import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import {
  createPublicationWatch,
  listPublicationWatches,
} from "../../server/db/publication-watches";
import { scans } from "../../server/db/schema";
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

test("the scheduled handler backfills watches from review history and checks due watches", async () => {
  const { db, organizationId } = await seedUser({ name: "Watcher" });
  await createPublicationWatch(db, organizationId, name);
  // A published public release reviewed through staged discovery is the
  // history the backfill enrolls from.
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
  expect(watches.map((item) => [item.packageName, item.source]).sort()).toEqual([
    [name, "manual"],
    ["history-package", "published_history"],
  ]);
  expect(watches.map((item) => [item.lastCheckedAt !== null, item.lastError])).toEqual([
    [true, null],
    [true, null],
  ]);
  expect(fetcher).toHaveBeenCalledWith(
    "https://registry.npmjs.org/@drydock%2Fpublication-test",
    expect.objectContaining({ redirect: "manual" }),
  );
});
