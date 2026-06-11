import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createDb,
  ensurePersonalOrganization,
  pruneRetentionData,
  SCAN_EVENT_RETENTION_DAYS,
  SCAN_RETENTION_DAYS,
} from "../../server/db";
import * as schema from "../../server/db/schema";
import worker from "../../server/index";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_CRON = "30 3 * * *";

type AppDb = ReturnType<typeof createDb>;

function retentionController(): ScheduledController {
  return {
    scheduledTime: Date.now(),
    cron: RETENTION_CRON,
    noRetry() {},
  } as unknown as ScheduledController;
}

async function seedOrg(db: AppDb): Promise<{ organizationId: string; userId: string }> {
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { organizationId, userId };
}

async function insertScan(
  db: AppDb,
  input: { id: string; organizationId: string; userId: string; ageDays: number },
) {
  const createdAt = new Date(Date.now() - input.ageDays * DAY_MS);
  await db.insert(schema.scans).values({
    id: input.id,
    stageId: `stage-${input.id}`,
    organizationId: input.organizationId,
    ownerUserId: input.userId,
    risk: "low",
    status: "complete",
    source: "auto_discovery",
    createdAt,
    updatedAt: createdAt,
  });
}

async function insertFile(db: AppDb, id: string, scanId: string) {
  await db.insert(schema.scanFiles).values({
    id,
    scanId,
    path: "index.js",
    status: "added",
    flagsJson: [],
  });
}

async function insertFinding(db: AppDb, id: string, scanId: string) {
  await db.insert(schema.scanFindings).values({
    id,
    scanId,
    severity: "high",
    file: "index.js",
    evidence: "evidence",
    reason: "reason",
  });
}

async function insertEvent(
  db: AppDb,
  input: { id: string; organizationId: string; scanId: string | null; ageDays: number },
) {
  await db.insert(schema.scanEvents).values({
    id: input.id,
    organizationId: input.organizationId,
    scanId: input.scanId,
    type: "scan.created",
    createdAt: new Date(Date.now() - input.ageDays * DAY_MS),
  });
}

async function existingIds<T extends { id: string }>(
  rows: Promise<T[]>,
  expected: string[],
): Promise<Set<string>> {
  const found = new Set((await rows).map((row) => row.id));
  return new Set(expected.filter((id) => found.has(id)));
}

describe("retention prune cron", () => {
  // The prune sweeps every row in D1 regardless of org, and storage can carry
  // across tests, so start each from a clean slate to keep counts deterministic.
  beforeEach(async () => {
    const db = createDb(env.DB);
    await db.batch([
      db.delete(schema.scanFindings),
      db.delete(schema.scanFiles),
      db.delete(schema.scanEvents),
      db.delete(schema.githubWorkflowGates),
      db.delete(schema.githubReleaseTargets),
      db.delete(schema.githubAppInstallations),
      db.delete(schema.scans),
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("prunes aged scans + events via the scheduled handler and preserves younger rows", async () => {
    const db = createDb(env.DB);
    const { organizationId, userId } = await seedOrg(db);

    // Two scans past the 180-day window and one comfortably inside it.
    await insertScan(db, { id: "old", organizationId, userId, ageDays: 200 });
    await insertScan(db, { id: "old-decided", organizationId, userId, ageDays: 200 });
    await insertScan(db, { id: "young", organizationId, userId, ageDays: 5 });

    await insertFile(db, "file-old", "old");
    await insertFile(db, "file-young", "young");
    await insertFinding(db, "finding-old", "old");
    await insertFinding(db, "finding-young", "young");

    // Event tied to the aged scan; an event tied to an aged scan but itself young
    // (a late decision); a young event on the young scan; a standalone event past
    // its own 90-day window; and a standalone event inside it.
    await insertEvent(db, { id: "ev-old", organizationId, scanId: "old", ageDays: 200 });
    await insertEvent(db, {
      id: "ev-old-decided",
      organizationId,
      scanId: "old-decided",
      ageDays: 10,
    });
    await insertEvent(db, { id: "ev-young", organizationId, scanId: "young", ageDays: 5 });
    await insertEvent(db, { id: "ev-standalone-old", organizationId, scanId: null, ageDays: 100 });
    await insertEvent(db, { id: "ev-standalone-young", organizationId, scanId: null, ageDays: 30 });

    // A workflow gate whose representative scan is being pruned: ON DELETE SET
    // NULL is not enforced by D1, so the prune must clear the pointer by hand.
    const gateRequestedAt = new Date(Date.now() - 200 * DAY_MS);
    const installAt = new Date(Date.now() - 300 * DAY_MS);
    await db.insert(schema.githubAppInstallations).values({
      id: "inst-dummy",
      organizationId,
      installationId: "123",
      accountLogin: "acme",
      accountType: "Organization",
      installedAt: installAt,
      createdAt: installAt,
      updatedAt: installAt,
    });
    await db.insert(schema.githubReleaseTargets).values({
      id: "rt-dummy",
      organizationId,
      installationRowId: "inst-dummy",
      repositoryId: 1,
      repositoryFullName: "acme/app",
      environment: "production",
      createdAt: installAt,
      updatedAt: installAt,
    });
    await db.insert(schema.githubWorkflowGates).values({
      id: "gate-1",
      organizationId,
      installationRowId: "inst-dummy",
      releaseTargetId: "rt-dummy",
      deliveryId: `delivery_${crypto.randomUUID()}`,
      repositoryId: 1,
      repositoryFullName: "acme/app",
      environment: "production",
      runId: 1,
      deploymentCallbackUrl: "https://api.github.com/callback",
      eventAction: "requested",
      scanId: "old",
      requestedAt: gateRequestedAt,
      createdAt: gateRequestedAt,
      updatedAt: gateRequestedAt,
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = createExecutionContext();
    await worker.scheduled(retentionController(), env, ctx);
    await waitOnExecutionContext(ctx);

    // Aged scans and their child evidence are gone; the young scan and its
    // children survive.
    expect(
      await existingIds(db.select().from(schema.scans), ["old", "old-decided", "young"]),
    ).toEqual(new Set(["young"]));
    expect(
      await existingIds(db.select().from(schema.scanFiles), ["file-old", "file-young"]),
    ).toEqual(new Set(["file-young"]));
    expect(
      await existingIds(db.select().from(schema.scanFindings), ["finding-old", "finding-young"]),
    ).toEqual(new Set(["finding-young"]));

    // Events: aged-by-window and cascade-from-pruned-scan removed; young ones kept.
    expect(
      await existingIds(db.select().from(schema.scanEvents), [
        "ev-old",
        "ev-old-decided",
        "ev-young",
        "ev-standalone-old",
        "ev-standalone-young",
      ]),
    ).toEqual(new Set(["ev-young", "ev-standalone-young"]));

    // The gate row stays but its dangling representative-scan pointer is cleared.
    const [gate] = await db
      .select({ id: schema.githubWorkflowGates.id, scanId: schema.githubWorkflowGates.scanId })
      .from(schema.githubWorkflowGates)
      .where(inArray(schema.githubWorkflowGates.id, ["gate-1"]));
    expect(gate).toBeTruthy();
    expect(gate?.scanId).toBeNull();

    // The structured observability event carries exact per-table counts.
    const sweptCall = logSpy.mock.calls.find((call) => call[0] === "retention.prune.swept");
    expect(sweptCall).toBeDefined();
    expect(sweptCall![1]).toMatchObject({
      event: "retention.prune.swept",
      scansPruned: 2,
      scanFilesPruned: 1,
      scanFindingsPruned: 1,
      scanEventsPruned: 3,
      gateScanRefsCleared: 1,
      scanRetentionDays: SCAN_RETENTION_DAYS,
      scanEventRetentionDays: SCAN_EVENT_RETENTION_DAYS,
    });
  });

  test("retention windows are exact at the day boundary", async () => {
    const db = createDb(env.DB);
    const { organizationId, userId } = await seedOrg(db);
    // Freeze "now" so the cutoffs land precisely between the seeded rows.
    const nowMs = Date.UTC(2026, 0, 1);

    const scanAt = (id: string, ageDays: number) =>
      db.insert(schema.scans).values({
        id,
        stageId: `stage-${id}`,
        organizationId,
        ownerUserId: userId,
        risk: "low",
        status: "complete",
        source: "manual",
        createdAt: new Date(nowMs - ageDays * DAY_MS),
        updatedAt: new Date(nowMs - ageDays * DAY_MS),
      });
    const eventAt = (id: string, ageDays: number) =>
      db.insert(schema.scanEvents).values({
        id,
        organizationId,
        scanId: null,
        type: "scan.created",
        createdAt: new Date(nowMs - ageDays * DAY_MS),
      });

    await scanAt("scan-181", 181);
    await scanAt("scan-179", 179);
    await eventAt("event-91", 91);
    await eventAt("event-89", 89);

    const result = await pruneRetentionData(db, nowMs);
    expect(result).toMatchObject({ scansPruned: 1, scanEventsPruned: 1 });

    expect(await existingIds(db.select().from(schema.scans), ["scan-181", "scan-179"])).toEqual(
      new Set(["scan-179"]),
    );
    expect(
      await existingIds(db.select().from(schema.scanEvents), ["event-91", "event-89"]),
    ).toEqual(new Set(["event-89"]));
  });
});
