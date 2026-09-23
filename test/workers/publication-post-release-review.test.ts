import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import {
  createPublicationWatch,
  listPublicationObservations,
} from "../../server/db/publication-watches";
import * as schema from "../../server/db/schema";
import { checkNpmPublicationWatch } from "../../server/lib/ecosystems/npm/publication-monitor";
import type { ScanQueueMessage } from "../../server/lib/scan/job";
import { call, type TestApp } from "./helpers/app";
import {
  PUBLIC_NPM,
  PUBLISHED,
  alertRow,
  appFor,
  decide,
  linkReview,
  newPackage,
  publishedBytes,
  seedAlert,
  seedPublishedReview,
} from "./helpers/post-release";
import { seedUser } from "./helpers/seed";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubRegistry(packageName: string, versions: string[]) {
  const tarball = (version: string) =>
    `${PUBLIC_NPM}/${packageName}/-/${packageName}-${version}.tgz`;
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${PUBLIC_NPM}/${packageName}`) {
      return Response.json({
        name: packageName,
        "dist-tags": { latest: versions[versions.length - 1] },
        versions: Object.fromEntries(
          versions.map((version) => [
            version,
            {
              name: packageName,
              version,
              dist: { tarball: tarball(version), shasum: PUBLISHED.sha1 },
            },
          ]),
        ),
        time: Object.fromEntries(versions.map((version) => [version, "2026-09-01T00:00:00.000Z"])),
      });
    }
    if (versions.some((version) => url === tarball(version))) return new Response(publishedBytes);
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function startReview(
  app: TestApp,
  target: { watchId: string; observationId: string },
  options: {
    organizationId?: string;
    queue?: { send: (message: ScanQueueMessage) => Promise<void> };
  } = {},
) {
  return call(
    app,
    "POST",
    `/api/v1/publication-watches/${target.watchId}/observations/${target.observationId}/review`,
    {
      activeOrganizationId: options.organizationId,
      envOverride: options.queue ? { SCAN_QUEUE: options.queue as unknown as Queue } : undefined,
    },
  );
}

describe("Scan on a publication alert", () => {
  test("starts a published-pair review of the release against the version it follows, linked to the alert", async () => {
    const owner = await seedUser();
    const app = appFor(owner);
    const packageName = newPackage();
    // A release with no Drydock record: decided from metadata, never hashed.
    const target = await seedAlert(owner, packageName, "1.1.0", {
      digests: { sha1: null, sha256: null },
    });
    const fetchMock = stubRegistry(packageName, ["0.9.0", "1.0.0", "1.1.0"]);
    const queue = { send: vi.fn(async (_message: ScanQueueMessage) => undefined) };

    const res = await startReview(app, target, { queue });
    expect(res.status).toBe(202);
    const { scanId, started } = await res.json<{ scanId: string; started: boolean }>();
    expect(started).toBe(true);

    const db = createDb(env.DB);
    const [scan] = await db.select().from(schema.scans).where(eq(schema.scans.id, scanId));
    expect(scan).toMatchObject({
      source: "published",
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
      packageName,
      stagedVersion: "1.1.0",
      // A post-release review claims no registry coordinates either.
      registryUrl: null,
    });
    // Against the predecessor the monitor recorded, not whatever npm lists next.
    expect(queue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        scanId,
        source: "published",
        published: { ecosystem: "npm", packageName, version: "1.1.0", baselineVersion: "1.0.0" },
      }),
    );
    expect(await alertRow(owner.organizationId, packageName, "1.1.0")).toMatchObject({
      reviewScanId: scanId,
      reviewRequestedBy: owner.userId,
      resolution: null,
    });
    const [event] = await db
      .select()
      .from(schema.scanEvents)
      .where(
        and(
          eq(schema.scanEvents.organizationId, owner.organizationId),
          eq(schema.scanEvents.type, "publication.review_started"),
        ),
      );
    expect(event).toMatchObject({
      actorUserId: owner.userId,
      metadataJson: { packageName, stagedVersion: "1.1.0", scanId },
    });

    // The monitor hashed the published bytes for the decision to be bound to,
    // credential-free, and left the historical verdict alone.
    const [observation] = await listPublicationObservations(
      db,
      owner.organizationId,
      target.watchId,
    );
    expect(observation).toMatchObject({
      status: "published_without_approval",
      sha1: PUBLISHED.sha1,
      sha256: PUBLISHED.sha256,
      reviewScanId: scanId,
      reviewStatus: "pending",
      reviewDecision: null,
      resolution: null,
    });
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
    }
  });

  test("a second Scan opens the review that exists instead of starting another", async () => {
    const owner = await seedUser();
    const app = appFor(owner);
    const packageName = newPackage();
    const target = await seedAlert(owner, packageName, "1.1.0");
    stubRegistry(packageName, ["1.0.0", "1.1.0"]);
    const queue = { send: vi.fn(async (_message: ScanQueueMessage) => undefined) };

    const first = await (await startReview(app, target, { queue })).json<{ scanId: string }>();
    const again = await startReview(app, target, { queue });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ scanId: first.scanId, started: false });
    expect(queue.send).toHaveBeenCalledTimes(1);
    const reviews = await createDb(env.DB)
      .select({ id: schema.scans.id })
      .from(schema.scans)
      .where(
        and(
          eq(schema.scans.organizationId, owner.organizationId),
          eq(schema.scans.source, "published"),
        ),
      );
    expect(reviews).toHaveLength(1);
  });

  test("another organization cannot start a review of this alert, and a release without an alert has none", async () => {
    const owner = await seedUser();
    const outsider = await seedUser();
    const packageName = newPackage();
    const target = await seedAlert(owner, packageName, "1.1.0");
    stubRegistry(packageName, ["1.0.0", "1.1.0"]);
    const res = await startReview(appFor(outsider), target, {
      organizationId: owner.organizationId,
    });
    expect(res.status).toBe(404);

    const matched = await seedAlert(owner, packageName, "1.2.0");
    await createDb(env.DB)
      .delete(schema.publicationAlerts)
      .where(eq(schema.publicationAlerts.version, "1.2.0"));
    expect((await startReview(appFor(owner), matched)).status).toBe(404);
    expect((await alertRow(owner.organizationId, packageName, "1.1.0"))?.reviewScanId).toBeNull();
  });

  test("a first release with nothing to compare against is refused and links nothing", async () => {
    const owner = await seedUser();
    const packageName = newPackage();
    const target = await seedAlert(owner, packageName, "1.0.0", { previousVersion: null });
    stubRegistry(packageName, ["1.0.0"]);
    const res = await startReview(appFor(owner), target);
    expect(res.status).toBe(400);
    expect((await alertRow(owner.organizationId, packageName, "1.0.0"))?.reviewScanId).toBeNull();
  });
});

describe("deciding a post-release review resolves its alert", () => {
  test("approve resolves the alert beside its verdict; decline reopens it", async () => {
    const owner = await seedUser();
    const app = appFor(owner);
    const packageName = newPackage();
    const target = await seedAlert(owner, packageName, "1.1.0");
    const scanId = await seedPublishedReview(owner, packageName, "1.1.0");
    await linkReview(owner, packageName, "1.1.0", scanId);

    const approved = await decide(app, scanId, "publish");
    expect(approved.postRelease).toMatchObject({
      packageName,
      version: "1.1.0",
      resolution: "approved_after_release",
      // Only watching the package is no tie to its name.
      resolutionBadge: "not_a_verified_publisher",
    });
    expect(await alertRow(owner.organizationId, packageName, "1.1.0")).toMatchObject({
      status: "published_without_approval",
      resolution: "approved_after_release",
      resolvedBy: owner.userId,
      resolvedAt: expect.any(Date),
      acknowledgedAt: null,
    });
    const listed = await call(app, "GET", `/api/v1/publication-watches/${target.watchId}`);
    const body = await listed.json<{
      watch: { unresolvedAlertCount: number };
      observations: Array<Record<string, unknown>>;
    }>();
    expect(body.watch.unresolvedAlertCount).toBe(0);
    // The observation still says what happened: published without approval.
    expect(body.observations[0]).toMatchObject({
      status: "published_without_approval",
      reviewScanId: scanId,
      reviewStatus: "complete",
      reviewDecision: "publish",
      resolution: "approved_after_release",
    });
    const detail = await call(app, "GET", `/api/v1/scans/${scanId}`);
    expect((await detail.json<{ postRelease: unknown }>()).postRelease).toMatchObject({
      resolution: "approved_after_release",
    });

    await decide(app, scanId, "no_publish");
    expect((await alertRow(owner.organizationId, packageName, "1.1.0"))?.resolution).toBe(
      "declined_after_release",
    );
    const reopened = await call(app, "GET", `/api/v1/publication-watches/${target.watchId}`);
    expect(
      (await reopened.json<{ watch: { unresolvedAlertCount: number } }>()).watch,
    ).toMatchObject({ unresolvedAlertCount: 1 });
    const events = await createDb(env.DB)
      .select({ scanId: schema.scanEvents.scanId, metadata: schema.scanEvents.metadataJson })
      .from(schema.scanEvents)
      .where(
        and(
          eq(schema.scanEvents.organizationId, owner.organizationId),
          eq(schema.scanEvents.type, "publication.review_resolved"),
        ),
      );
    expect(events.map((event) => event.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resolution: "approved_after_release", stagedVersion: "1.1.0" }),
        expect.objectContaining({ resolution: "declined_after_release", stagedVersion: "1.1.0" }),
      ]),
    );
    expect(events.every((event) => event.scanId === scanId)).toBe(true);
  });

  test("a published-pair review nobody started from the alert resolves nothing", async () => {
    const owner = await seedUser();
    const app = appFor(owner);
    const packageName = newPackage();
    await seedAlert(owner, packageName, "1.1.0");
    const scanId = await seedPublishedReview(owner, packageName, "1.1.0");
    expect((await decide(app, scanId, "publish")).postRelease).toBeNull();
    expect(await alertRow(owner.organizationId, packageName, "1.1.0")).toMatchObject({
      resolution: null,
      resolvedAt: null,
    });
  });

  test("a failed review can be deleted, which unlinks it so Scan is offered again", async () => {
    const owner = await seedUser();
    const app = appFor(owner);
    const packageName = newPackage();
    await seedAlert(owner, packageName, "1.1.0");
    const scanId = await seedPublishedReview(owner, packageName, "1.1.0");
    await linkReview(owner, packageName, "1.1.0", scanId);
    await createDb(env.DB)
      .update(schema.scans)
      .set({ status: "failed" })
      .where(eq(schema.scans.id, scanId));
    expect((await call(app, "DELETE", `/api/v1/scans/${scanId}`)).status).toBe(200);
    expect((await alertRow(owner.organizationId, packageName, "1.1.0"))?.reviewScanId).toBeNull();
  });

  test("a decided post-release review never counts as a release record for the monitor", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const packageName = newPackage();
    // An approved review of exactly this version's published bytes, recorded
    // before the monitor ever sees the version.
    const scanId = await seedPublishedReview(owner, packageName, "2.0.0");
    await decide(appFor(owner), scanId, "publish");
    const watch = await createPublicationWatch(db, owner.organizationId, packageName);
    const tarball = `${PUBLIC_NPM}/${packageName}/-/${packageName}-2.0.0.tgz`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input) === tarball
        ? new Response(publishedBytes)
        : Response.json({
            name: packageName,
            versions: {
              "2.0.0": { name: packageName, version: "2.0.0", dist: { tarball } },
            },
            time: { "2.0.0": new Date(watch.createdAt.getTime() + 1).toISOString() },
          }),
    );
    await checkNpmPublicationWatch(db, env, watch);
    expect(await listPublicationObservations(db, owner.organizationId, watch.id)).toMatchObject([
      { version: "2.0.0", status: "published_without_approval" },
    ]);
  });
});
