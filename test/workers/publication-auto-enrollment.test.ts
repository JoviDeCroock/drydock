import { env } from "cloudflare:test";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import {
  createPublicationWatch,
  deletePublicationWatch,
  listPublicationWatches,
  PUBLICATION_WATCH_LIMIT,
} from "../../server/db/publication-watches";
import { npmPackageClaims, publicationWatchCandidates, scans } from "../../server/db/schema";
import {
  getPublicationAutoEnrollment,
  reconcileDuePublicationEnrollments,
  reconcilePublicationWatches,
  registerStagedPublicationCandidates,
} from "../../server/lib/ecosystems/npm/publication-auto-enrollment";
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
      pending: 0,
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
      pending: 0,
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
    pending: 0,
    suggestions: [],
  });
  expect(await listPublicationWatches(outsider.db, outsider.organizationId)).toEqual([]);
  await reconcilePublicationWatches(owner.db, owner.organizationId);
  expect(await listPublicationWatches(owner.db, owner.organizationId)).toMatchObject([
    { packageName: "claimed-package" },
  ]);
});

describe("scheduled enrollment", () => {
  // Every organization in the shared test database is due at most once per
  // call; a generous limit keeps the random order from skipping this one.
  const reconcileDue = () =>
    reconcileDuePublicationEnrollments(createDb(env.DB), env, { limit: 1_000 });

  test("reading the enrollment summary enrolls nothing; the cron enrolls history and records gate suggestions", async () => {
    const { db, organizationId } = await seed();
    await historicalScan(organizationId, "cron-history");
    await historicalScan(organizationId, "cron-gate", {
      source: "workflow_gate",
      registryUrl: null,
      summaryJson: gateSummary("cron-gate"),
    });
    expect(await getPublicationAutoEnrollment(db, organizationId)).toEqual({
      deferred: 0,
      pending: 1,
      suggestions: [],
    });
    expect(await listPublicationWatches(db, organizationId)).toEqual([]);

    await reconcileDue();
    const watches = await listPublicationWatches(db, organizationId);
    expect(watches.map((watch) => [watch.packageName, watch.source])).toEqual([
      ["cron-history", "published_history"],
    ]);
    expect(await getPublicationAutoEnrollment(db, organizationId)).toEqual({
      deferred: 0,
      pending: 0,
      suggestions: [{ packageName: "cron-gate" }],
    });
  });

  test("the cron fills a freed slot with a deferred package and never restores a stopped one", async () => {
    const { db, organizationId } = await seed();
    await seedPublicationWatches(db, organizationId, PUBLICATION_WATCH_LIMIT - 1);
    await historicalScan(organizationId, "first-history");
    await historicalScan(organizationId, "second-history", { createdAt: new Date(2) });
    await reconcileDue();
    expect(await getPublicationAutoEnrollment(db, organizationId)).toMatchObject({
      deferred: 1,
      pending: 0,
    });
    const first = (await listPublicationWatches(db, organizationId)).find(
      (watch) => watch.packageName === "first-history",
    )!;
    expect(first).toBeDefined();

    await deletePublicationWatch(db, organizationId, first.id);
    await reconcileDue();
    const names = (await listPublicationWatches(db, organizationId)).map(
      (watch) => watch.packageName,
    );
    expect(names).toContain("second-history");
    expect(names).not.toContain("first-history");
    expect(names).toHaveLength(PUBLICATION_WATCH_LIMIT);
  });
});
