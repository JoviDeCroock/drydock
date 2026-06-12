import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  createDb,
  ensurePersonalOrganization,
  listScans,
  updateNpmConnectionValidation,
  upsertNpmConnection,
} from "../../server/db";
import * as schema from "../../server/db/schema";
import { encryptNpmToken } from "../../server/lib/npm-connection";
import { STAGE_WITHDRAWN_CONFIRMATION_MS } from "../../server/lib/release-detection";
import worker from "../../server/index";

const REGISTRY_URL = "https://registry.npmjs.org";
const TOKEN = "npm_valid_aaaaaaaaaaaa";
const STAGED_SHASUM = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";

interface SeededScan {
  id: string;
  stageId: string;
  packageName: string;
}

async function seedOrg(): Promise<{ organizationId: string; userId: string }> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Reconciliation Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  const encrypted = await encryptNpmToken(env, TOKEN);
  await upsertNpmConnection(db, {
    organizationId,
    registryUrl: REGISTRY_URL,
    label: "npm registry",
    createdByUserId: userId,
    ...encrypted,
  });
  await updateNpmConnectionValidation(db, {
    organizationId,
    validationStatus: "valid",
    validatedAt: now,
  });
  return { organizationId, userId };
}

async function seedCompletedScan(input: {
  organizationId: string;
  ownerUserId: string;
  packageName: string;
  stagedShasum?: string | null;
  stageMissingSince?: Date | null;
  decision?: string | null;
}): Promise<SeededScan> {
  const db = createDb(env.DB);
  const now = new Date();
  const id = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${input.packageName}-000001`;
  await db.insert(schema.scans).values({
    id,
    stageId,
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId,
    packageName: input.packageName,
    stagedVersion: "1.2.3",
    stagedShasum: input.stagedShasum === undefined ? STAGED_SHASUM : input.stagedShasum,
    stageMissingSince: input.stageMissingSince ?? null,
    decision: input.decision ?? null,
    risk: "low",
    status: "complete",
    source: "auto_discovery",
    createdAt: now,
    updatedAt: now,
  });
  return { id, stageId, packageName: input.packageName };
}

async function scanRow(id: string) {
  const rows = await createDb(env.DB)
    .select({
      releaseStatus: schema.scans.releaseStatus,
      releasedAt: schema.scans.releasedAt,
      stageMissingSince: schema.scans.stageMissingSince,
      decision: schema.scans.decision,
    })
    .from(schema.scans)
    .where(eq(schema.scans.id, id));
  return rows[0]!;
}

async function eventsForScan(scanId: string) {
  const rows = await createDb(env.DB)
    .select({ type: schema.scanEvents.type, metadata: schema.scanEvents.metadataJson })
    .from(schema.scanEvents)
    .where(eq(schema.scanEvents.scanId, scanId));
  return rows;
}

function scheduledController(): ScheduledController {
  return {
    scheduledTime: Date.now(),
    cron: "*/15 * * * *",
    noRetry() {},
  } as unknown as ScheduledController;
}

function packumentResponse(input: { packageName: string; shasum: string; publishedAt: string }) {
  return Response.json({
    name: input.packageName,
    versions: { "1.2.3": { dist: { shasum: input.shasum } } },
    time: { "1.2.3": input.publishedAt },
  });
}

async function runScheduledSweep() {
  const queue = { send: vi.fn(async () => undefined) };
  const send = vi.fn(async () => undefined);
  const ctx = createExecutionContext();
  await worker.scheduled(
    scheduledController(),
    { ...env, SCAN_QUEUE: queue, SEND_EMAIL: { send } } as unknown as Cloudflare.Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
}

describe("release reconciliation during the discovery cron", () => {
  beforeEach(async () => {
    await createDb(env.DB).delete(schema.npmConnections);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("resolves disappeared stages from the packument", async () => {
    const org = await seedOrg();
    const released = await seedCompletedScan({
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      packageName: "pkg-released",
    });
    const mismatch = await seedCompletedScan({
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      packageName: "pkg-mismatch",
    });
    const firstMiss = await seedCompletedScan({
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      packageName: "pkg-first-miss",
    });
    const withdrawn = await seedCompletedScan({
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      packageName: "pkg-withdrawn",
      stageMissingSince: new Date(Date.now() - STAGE_WITHDRAWN_CONFIRMATION_MS - 60_000),
    });
    const stillLive = await seedCompletedScan({
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      packageName: "pkg-live",
      stageMissingSince: new Date(Date.now() - 10 * 60_000),
    });

    const publishedAt = "2026-06-12T11:00:00.000Z";
    const fetchMock = vi.fn(async (input: Request | string | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/-/stage")) {
        // pkg-live's stage reappears in the listing; every other stage is gone.
        return Response.json({
          items: [{ id: stillLive.stageId, name: "pkg-live", version: "1.2.3" }],
          total: 1,
          perPage: 50,
          page: 0,
        });
      }
      if (url.endsWith("/pkg-released")) {
        return packumentResponse({
          packageName: "pkg-released",
          shasum: STAGED_SHASUM,
          publishedAt,
        });
      }
      if (url.endsWith("/pkg-mismatch")) {
        return packumentResponse({
          packageName: "pkg-mismatch",
          shasum: "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
          publishedAt,
        });
      }
      // Neither pkg-first-miss nor pkg-withdrawn ever published.
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runScheduledSweep();

    const releasedRow = await scanRow(released.id);
    expect(releasedRow.releaseStatus).toBe("released");
    expect(releasedRow.releasedAt?.toISOString()).toBe(publishedAt);
    const releasedEvents = await eventsForScan(released.id);
    expect(releasedEvents.map((e) => e.type)).toContain("scan.release_detected");
    expect(releasedEvents.find((e) => e.type === "scan.release_detected")?.metadata).toMatchObject({
      stageId: released.stageId,
      packageName: "pkg-released",
      stagedVersion: "1.2.3",
      shasumVerified: true,
    });

    const mismatchRow = await scanRow(mismatch.id);
    expect(mismatchRow.releaseStatus).toBe("released_mismatch");
    const mismatchEvents = await eventsForScan(mismatch.id);
    expect(mismatchEvents.map((e) => e.type)).toContain("scan.release_mismatch_detected");
    expect(
      mismatchEvents.find((e) => e.type === "scan.release_mismatch_detected")?.metadata,
    ).toMatchObject({
      stagedShasum: STAGED_SHASUM,
      publishedShasum: "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
    });

    // First miss starts the withdrawal clock instead of concluding anything.
    const firstMissRow = await scanRow(firstMiss.id);
    expect(firstMissRow.releaseStatus).toBeNull();
    expect(firstMissRow.stageMissingSince).not.toBeNull();

    const withdrawnRow = await scanRow(withdrawn.id);
    expect(withdrawnRow.releaseStatus).toBe("withdrawn");
    expect(withdrawnRow.releasedAt).toBeNull();
    expect((await eventsForScan(withdrawn.id)).map((e) => e.type)).toContain(
      "scan.stage_withdrawn",
    );

    // The reappeared stage stops accruing time toward withdrawal.
    const liveRow = await scanRow(stillLive.id);
    expect(liveRow.releaseStatus).toBeNull();
    expect(liveRow.stageMissingSince).toBeNull();

    // The review queue keeps only the unresolved scans and the mismatch alert.
    const undecided = await listScans(createDb(env.DB), org.organizationId, {
      decisionFilter: "undecided",
    });
    const undecidedIds = undecided.scans.map((scan) => scan.id);
    expect(undecidedIds).toContain(mismatch.id);
    expect(undecidedIds).toContain(firstMiss.id);
    expect(undecidedIds).toContain(stillLive.id);
    expect(undecidedIds).not.toContain(released.id);
    expect(undecidedIds).not.toContain(withdrawn.id);
  });

  test("a transient packument failure defers the scan to the next sweep", async () => {
    const org = await seedOrg();
    const scan = await seedCompletedScan({
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      packageName: "pkg-flaky",
    });

    const fetchMock = vi.fn(async (input: Request | string | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/-/stage")) {
        return Response.json({ items: [], total: 0, perPage: 50, page: 0 });
      }
      return new Response("upstream boom", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runScheduledSweep();

    const row = await scanRow(scan.id);
    expect(row.releaseStatus).toBeNull();
    expect(row.stageMissingSince).toBeNull();
    expect(await eventsForScan(scan.id)).toHaveLength(0);
  });

  test("records a release even after a human no_publish decision", async () => {
    const org = await seedOrg();
    const scan = await seedCompletedScan({
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      packageName: "pkg-overridden",
      decision: "no_publish",
    });

    const fetchMock = vi.fn(async (input: Request | string | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/-/stage")) {
        return Response.json({ items: [], total: 0, perPage: 50, page: 0 });
      }
      return packumentResponse({
        packageName: "pkg-overridden",
        shasum: STAGED_SHASUM,
        publishedAt: "2026-06-12T11:00:00.000Z",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runScheduledSweep();

    const row = await scanRow(scan.id);
    expect(row.releaseStatus).toBe("released");
    expect(row.decision).toBe("no_publish");
    expect((await eventsForScan(scan.id)).map((e) => e.type)).toContain("scan.release_detected");
  });
});
