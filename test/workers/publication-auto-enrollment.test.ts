import { createExecutionContext, env } from "cloudflare:test";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import { upsertNpmConnection } from "../../server/db/npm-connections";
import {
  createPublicationWatch,
  deletePublicationWatch,
  listPublicationWatches,
  PUBLICATION_WATCH_LIMIT,
} from "../../server/db/publication-watches";
import { npmPackageClaims, publicationWatchCandidates, scans } from "../../server/db/schema";
import * as schema from "../../server/db/schema";
import {
  reconcilePublicationWatches,
  registerStagedPublicationCandidates,
} from "../../server/lib/ecosystems/npm/publication-auto-enrollment";
import { discoverAndQueueStagedPublishes } from "../../server/lib/ecosystems/npm/staged-publishes-discovery";
import { seedPublicationWatches, seedUser } from "./helpers/seed";

const registry = "https://registry.npmjs.org";
const seed = () => seedUser({ name: "Monitor" });
async function claimPackages(organizationId: string, names: string[]) {
  const db = createDb(env.DB);
  for (const packageName of names)
    await db
      .insert(npmPackageClaims)
      .values({
        registryUrl: registry,
        ecosystem: "npm",
        packageName,
        organizationId,
        firstStageId: `stage-${crypto.randomUUID()}`,
        claimedAt: new Date(),
        managementConfirmedAt: new Date(),
      })
      .onConflictDoNothing();
}
async function historicalScan(
  organizationId: string,
  name: string,
  overrides: Partial<typeof scans.$inferInsert> = {},
) {
  const db = createDb(env.DB);
  const id = crypto.randomUUID();
  if (!overrides.source || overrides.source === "manual" || overrides.source === "auto_discovery")
    await claimPackages(organizationId, [name]);
  await db.insert(scans).values({
    id,
    stageId: `stage-${id}`,
    organizationId,
    source: "auto_discovery",
    status: "complete",
    packageName: name,
    stagedVersion: "1.0.0",
    registryPackageName: name,
    registryVersion: "1.0.0",
    registryUrl: registry,
    registryVersionStatus: "published",
    summaryJson: { stagedPublish: { access: "public" } },
    createdAt: new Date(1),
    updatedAt: new Date(1),
    ...overrides,
  });
}
const gateSummary = (name: string) => ({
  stagedPublish: {
    mode: "workflow_gate",
    manifest: {
      schema: "drydock.release-artifacts.v1",
      ecosystem: "npm",
      package: name,
      version: "1.0.0",
      artifacts: [{ path: "pkg.tgz", sha256: "a".repeat(64) }],
    },
  },
});

afterEach(() => vi.unstubAllGlobals());

async function discover(
  db: ReturnType<typeof createDb>,
  organizationId: string,
  actorUserId: string,
  releases: { id: string; packageName: string; access: string }[] = [],
  lastUsedAt: Date | null = null,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ items: releases })),
  );
  return discoverAndQueueStagedPublishes(
    {
      db,
      env,
      executionCtx: createExecutionContext(),
      organizationId,
      actorUserId,
      source: "auto_discovery",
      eventSource: "staged_publishes.cron",
      awaitReleaseOutcomes: true,
      admitNewScans: false,
    },
    { token: "npm_discovery_test_token", registryUrl: registry, lastUsedAt },
  );
}

test("idle cron discovery omits three unused summary reads while dashboard reconciliation retains them", async () => {
  const { db, organizationId, userId } = await seed();
  await upsertNpmConnection(db, {
    organizationId,
    registryUrl: registry,
    label: "npm registry",
    tokenCiphertext: "unused",
    tokenNonce: "unused",
    tokenFingerprint: "unused",
    createdByUserId: userId,
  });
  const queries: string[] = [];
  const countedDb = drizzle(env.DB, {
    schema,
    logger: { logQuery: (query) => queries.push(query) },
  });

  expect(await discover(countedDb, organizationId, userId)).toMatchObject({
    found: 0,
    created: 0,
  });
  // The organization-owner read lives outside discovery: together these are
  // six statements per idle org, down from nine with the discarded summary.
  expect(queries).toHaveLength(5);
  expect(queries.filter((query) => query.startsWith("select"))).toHaveLength(4);
  expect(queries.some((query) => query.includes("count(distinct"))).toBe(false);

  queries.length = 0;
  expect(await reconcilePublicationWatches(countedDb, organizationId)).toEqual({
    deferred: 0,
    suggestions: [],
  });
  expect(queries).toHaveLength(6);
  expect(queries.some((query) => query.includes("count(distinct"))).toBe(true);

  queries.length = 0;
  await discover(countedDb, organizationId, userId, [], new Date());
  expect(queries).toHaveLength(4);
  expect(queries.some((query) => query.startsWith("update"))).toBe(false);
});

test("empty cron stages still discover new published history and drain later enrollment batches", async () => {
  const { db, organizationId, userId } = await seed();
  for (let index = 0; index < 55; index++)
    await historicalScan(organizationId, `cron-history-${String(index).padStart(2, "0")}`);

  await discover(db, organizationId, userId);
  expect(await listPublicationWatches(db, organizationId)).toHaveLength(50);
  await discover(db, organizationId, userId);
  expect(await listPublicationWatches(db, organizationId)).toHaveLength(55);

  await historicalScan(organizationId, "cron-history-new");
  await discover(db, organizationId, userId);
  expect(
    (await listPublicationWatches(db, organizationId)).map((watch) => watch.packageName),
  ).toContain("cron-history-new");
});

test("cron enrollment keeps capacity, public stage admission, ownership and stop intent without a summary", async () => {
  const own = await seed();
  const other = await seed();
  const { db, organizationId, userId } = own;
  await seedPublicationWatches(db, organizationId, PUBLICATION_WATCH_LIMIT);
  await historicalScan(organizationId, "cron-history");
  await historicalScan(other.organizationId, "foreign-claim");
  await claimPackages(organizationId, ["cron-stage", "cron-private"]);
  await discover(db, organizationId, userId, [
    { id: "public-stage", packageName: "cron-stage", access: "public" },
    { id: "private-stage", packageName: "cron-private", access: "restricted" },
    { id: "foreign-stage", packageName: "foreign-claim", access: "public" },
  ]);
  expect(await listPublicationWatches(db, organizationId)).toHaveLength(PUBLICATION_WATCH_LIMIT);

  const [filler] = await listPublicationWatches(db, organizationId);
  await deletePublicationWatch(db, organizationId, filler!.id);
  await discover(db, organizationId, userId);
  const staged = (await listPublicationWatches(db, organizationId)).find(
    (watch) => watch.packageName === "cron-stage",
  );
  expect(staged?.source).toBe("staged_discovery");
  expect(await listPublicationWatches(db, organizationId)).toHaveLength(PUBLICATION_WATCH_LIMIT);

  await deletePublicationWatch(db, organizationId, staged!.id);
  await discover(db, organizationId, userId, [
    { id: "public-stage", packageName: "cron-stage", access: "public" },
  ]);
  const watches = await listPublicationWatches(db, organizationId);
  expect(watches).toHaveLength(PUBLICATION_WATCH_LIMIT);
  expect(watches.find((watch) => watch.packageName === "cron-history")?.source).toBe(
    "published_history",
  );
  expect(
    watches.some((watch) =>
      ["cron-stage", "cron-private", "foreign-claim"].includes(watch.packageName),
    ),
  ).toBe(false);
});

describe("automatic publication enrollment", () => {
  test("public staged discovery enrolls once and excludes private/custom registry names", async () => {
    const { db, organizationId } = await seed();
    const items = [
      { packageName: "public-package", access: "public" },
      { packageName: "private-package", access: "restricted" },
      { packageName: "unknown-package", access: null },
    ];
    await claimPackages(
      organizationId,
      items.map((item) => item.packageName),
    );
    await registerStagedPublicationCandidates(db, organizationId, items, "https://private.example");
    expect(await listPublicationWatches(db, organizationId)).toEqual([]);
    await registerStagedPublicationCandidates(db, organizationId, items, registry);
    const [watch] = await listPublicationWatches(db, organizationId);
    expect(watch).toMatchObject({ packageName: "public-package", source: "staged_discovery" });
    await registerStagedPublicationCandidates(db, organizationId, items, registry);
    expect(await listPublicationWatches(db, organizationId)).toEqual([watch]);
  });

  test("published history requires captured public registry, public stage access and actual published status", async () => {
    const { db, organizationId } = await seed();
    await historicalScan(organizationId, "published-package");
    await historicalScan(organizationId, "manual-package", { source: "manual" });
    await historicalScan(organizationId, "private-package", {
      summaryJson: { stagedPublish: { access: "restricted" } },
    });
    await historicalScan(organizationId, "missing-access", { summaryJson: {} });
    await historicalScan(organizationId, "staged-only", { registryVersionStatus: "staged" });
    await historicalScan(organizationId, "deleted-only", { registryVersionStatus: "deleted" });
    await historicalScan(organizationId, "custom-registry", {
      registryUrl: "https://private.example",
    });
    await historicalScan(organizationId, "public-diff", { source: "published" });
    const before = Date.now();
    await reconcilePublicationWatches(db, organizationId);
    const watches = await listPublicationWatches(db, organizationId);
    expect(watches.map((watch) => watch.packageName).sort()).toEqual([
      "manual-package",
      "published-package",
    ]);
    expect(
      watches.every(
        (watch) => watch.source === "published_history" && watch.createdAt.getTime() >= before,
      ),
    ).toBe(true);
  });

  test("gate-only npm reviews are suggestions until explicit opt-in or public stage confirmation", async () => {
    const { db, organizationId } = await seed();
    await historicalScan(organizationId, "gate-package", {
      source: "workflow_gate",
      registryUrl: null,
      summaryJson: gateSummary("gate-package"),
    });
    await historicalScan(organizationId, "not-npm", {
      source: "workflow_gate",
      registryUrl: null,
      summaryJson: {
        stagedPublish: {
          mode: "workflow_gate",
          manifest: { ...gateSummary("not-npm").stagedPublish.manifest, ecosystem: "pypi" },
        },
      },
    });
    expect(await reconcilePublicationWatches(db, organizationId)).toEqual({
      deferred: 0,
      suggestions: [{ packageName: "gate-package" }],
    });
    expect(await listPublicationWatches(db, organizationId)).toEqual([]);
    const watch = await createPublicationWatch(db, organizationId, "gate-package");
    expect(watch.source).toBe("manual");
    expect((await reconcilePublicationWatches(db, organizationId)).suggestions).toEqual([]);
    await historicalScan(organizationId, "promoted-package", {
      source: "workflow_gate",
      registryUrl: null,
      summaryJson: gateSummary("promoted-package"),
    });
    await reconcilePublicationWatches(db, organizationId);
    await claimPackages(organizationId, ["promoted-package"]);
    await registerStagedPublicationCandidates(
      db,
      organizationId,
      [{ packageName: "promoted-package", access: "public" }],
      registry,
    );
    expect(
      (await listPublicationWatches(db, organizationId)).find(
        (item) => item.packageName === "promoted-package",
      )?.source,
    ).toBe("staged_discovery");
    await reconcilePublicationWatches(db, organizationId);
    expect(
      (
        await db
          .select()
          .from(publicationWatchCandidates)
          .where(eq(publicationWatchCandidates.packageName, "promoted-package"))
      )[0]?.source,
    ).toBe("staged_discovery");
  });

  test("stop survives discovery and history, while manual reenrollment creates a fresh identity", async () => {
    const { db, organizationId } = await seed();
    await historicalScan(organizationId, "stoppable");
    await reconcilePublicationWatches(db, organizationId);
    const [initial] = await listPublicationWatches(db, organizationId);
    expect(await deletePublicationWatch(db, "foreign-org", initial!.id)).toBe(false);
    expect(await deletePublicationWatch(db, organizationId, initial!.id)).toBe(true);
    await registerStagedPublicationCandidates(
      db,
      organizationId,
      [{ packageName: "stoppable", access: "public" }],
      registry,
    );
    expect(await listPublicationWatches(db, organizationId)).toEqual([]);
    expect(await reconcilePublicationWatches(db, organizationId)).toEqual({
      deferred: 0,
      suggestions: [],
    });
    const next = await createPublicationWatch(db, organizationId, "stoppable");
    expect(next.id).not.toBe(initial!.id);
    expect(next.source).toBe("manual");
    expect(
      (
        await db
          .select()
          .from(publicationWatchCandidates)
          .where(eq(publicationWatchCandidates.organizationId, organizationId))
      )[0]?.stoppedAt,
    ).toBeNull();
  });

  test("the active cap defers automatic candidates and uses a freed slot without reenrolling the stopped package", async () => {
    const { db, organizationId } = await seed();
    await seedPublicationWatches(db, organizationId, PUBLICATION_WATCH_LIMIT - 20);
    const items = Array.from({ length: 22 }, (_, i) => ({
      packageName: `candidate-${String(i).padStart(2, "0")}`,
      access: "public",
    }));
    await claimPackages(
      organizationId,
      items.map((item) => item.packageName),
    );
    expect(
      (await registerStagedPublicationCandidates(db, organizationId, items, registry)).deferred,
    ).toBe(2);
    const watches = await listPublicationWatches(db, organizationId);
    expect(watches).toHaveLength(PUBLICATION_WATCH_LIMIT);
    const stopped = watches.find((item) => item.packageName.startsWith("candidate-"))!;
    await deletePublicationWatch(db, organizationId, stopped.id);
    expect((await reconcilePublicationWatches(db, organizationId)).deferred).toBe(1);
    const updated = await listPublicationWatches(db, organizationId);
    expect(updated).toHaveLength(PUBLICATION_WATCH_LIMIT);
    expect(updated.some((item) => item.packageName === stopped.packageName)).toBe(false);
  });

  test("a failed manual reenrollment at the cap preserves stop intent", async () => {
    const { db, organizationId } = await seed();
    const initial = await createPublicationWatch(db, organizationId, "stopped-manual");
    await deletePublicationWatch(db, organizationId, initial.id);
    await seedPublicationWatches(db, organizationId, PUBLICATION_WATCH_LIMIT);
    await expect(createPublicationWatch(db, organizationId, "stopped-manual")).rejects.toThrow(
      `At most ${PUBLICATION_WATCH_LIMIT}`,
    );
    const [candidate] = await db
      .select()
      .from(publicationWatchCandidates)
      .where(eq(publicationWatchCandidates.packageName, "stopped-manual"));
    expect(candidate?.stoppedAt).not.toBeNull();
  });

  test("history and candidate inventory remain organization scoped", async () => {
    const own = await seed();
    const other = await seed();
    await historicalScan(other.organizationId, "foreign-package");
    await reconcilePublicationWatches(own.db, own.organizationId);
    expect(await listPublicationWatches(own.db, own.organizationId)).toEqual([]);
    expect(
      await own.db
        .select()
        .from(publicationWatchCandidates)
        .where(
          inArray(publicationWatchCandidates.organizationId, [
            own.organizationId,
            other.organizationId,
          ]),
        ),
    ).toEqual([]);
  });
});

test("large history batches expose the full deferred count and malformed names cannot stall progress", async () => {
  const { db, organizationId } = await seed();
  await seedPublicationWatches(db, organizationId, PUBLICATION_WATCH_LIMIT - 20);
  for (let i = 0; i < 55; i++)
    await historicalScan(organizationId, `old-${String(i).padStart(3, "0")}`);
  for (const name of ["@invalid", "path/traversal", "bad name", "UPPERCASE", "@scope//name"])
    await historicalScan(organizationId, name, { createdAt: new Date(0) });
  const first = await reconcilePublicationWatches(db, organizationId);
  expect(first.deferred).toBe(35);
  expect(await listPublicationWatches(db, organizationId)).toHaveLength(PUBLICATION_WATCH_LIMIT);
  expect(
    await db
      .select()
      .from(publicationWatchCandidates)
      .where(eq(publicationWatchCandidates.organizationId, organizationId)),
  ).toHaveLength(50);
  expect((await reconcilePublicationWatches(db, organizationId)).deferred).toBe(35);
  expect(
    await db
      .select()
      .from(publicationWatchCandidates)
      .where(eq(publicationWatchCandidates.organizationId, organizationId)),
  ).toHaveLength(55);
});

test("concurrent explicit and automatic enrollment share the atomic active cap", async () => {
  const { db, organizationId } = await seed();
  await seedPublicationWatches(db, organizationId, PUBLICATION_WATCH_LIMIT - 20);
  const items = Array.from({ length: 25 }, (_, index) => ({
    packageName: `auto-${index}`,
    access: "public",
  }));
  await claimPackages(
    organizationId,
    items.map((item) => item.packageName),
  );
  const results = await Promise.allSettled([
    registerStagedPublicationCandidates(db, organizationId, items, registry),
    ...Array.from({ length: 10 }, (_, index) =>
      createPublicationWatch(db, organizationId, `explicit-${index}`),
    ),
  ]);
  expect(results[0]!.status).toBe("fulfilled");
  expect(await listPublicationWatches(db, organizationId)).toHaveLength(PUBLICATION_WATCH_LIMIT);
});

test("a backlog beyond one enrollment batch keeps enrolling and only what cannot fit is deferred", async () => {
  const { db, organizationId } = await seed();
  await seedPublicationWatches(db, organizationId, PUBLICATION_WATCH_LIMIT - 55);
  const items = Array.from({ length: 60 }, (_, index) => ({
    packageName: `backlog-${String(index).padStart(2, "0")}`,
    access: "public",
  }));
  await claimPackages(
    organizationId,
    items.map((item) => item.packageName),
  );
  const first = await registerStagedPublicationCandidates(db, organizationId, items, registry);
  expect(first.deferred).toBe(5);
  expect(await listPublicationWatches(db, organizationId)).toHaveLength(
    PUBLICATION_WATCH_LIMIT - 5,
  );
  expect((await reconcilePublicationWatches(db, organizationId)).deferred).toBe(5);
  const watches = await listPublicationWatches(db, organizationId);
  expect(watches).toHaveLength(PUBLICATION_WATCH_LIMIT);
  expect(watches.filter((item) => item.packageName.startsWith("backlog-"))).toHaveLength(55);
});

test("automatic enrollment skips foreign claims and unaudited legacy history", async () => {
  const owner = await seed();
  const outsider = await seed();
  await historicalScan(owner.organizationId, "claimed-package");
  await historicalScan(outsider.organizationId, "claimed-package");
  await historicalScan(outsider.organizationId, "legacy-package");
  await outsider.db
    .delete(npmPackageClaims)
    .where(eq(npmPackageClaims.packageName, "legacy-package"));
  await registerStagedPublicationCandidates(
    outsider.db,
    outsider.organizationId,
    [
      { packageName: "claimed-package", access: "public" },
      { packageName: "legacy-package", access: "public" },
    ],
    registry,
  );
  expect(await reconcilePublicationWatches(outsider.db, outsider.organizationId)).toEqual({
    deferred: 0,
    suggestions: [],
  });
  expect(await listPublicationWatches(outsider.db, outsider.organizationId)).toEqual([]);
  await reconcilePublicationWatches(owner.db, owner.organizationId);
  expect(await listPublicationWatches(owner.db, owner.organizationId)).toMatchObject([
    { packageName: "claimed-package" },
  ]);
});
