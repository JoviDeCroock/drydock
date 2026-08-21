import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import {
  claimScanForRun,
  createScanJob,
  discardScanAttempt,
  failStalledScans,
  getScanRecord,
  listExistingScanStageIds,
  listScans,
  listStalledAiReviewScans,
  markAiReviewStarted,
  persistScan,
  STALLED_QUEUED_TIMEOUT_MS,
  STALLED_RUNNING_TIMEOUT_MS,
} from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { pendingAiReview } from "../../server/lib/ai-review/types";
import { closeAbandonedAiReview } from "../../server/lib/scan/ai-review-job";
import worker from "../../server";

interface SeededUser {
  userId: string;
  organizationId: string;
}

async function seedUser(): Promise<SeededUser> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Reaper Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, organizationId };
}

/** Backdate a row's lifecycle timestamps to simulate a scan that stalled. */
async function ageScan(scanId: string, minutes: number) {
  const db = createDb(env.DB);
  const when = new Date(Date.now() - minutes * 60_000);
  await db
    .update(schema.scans)
    .set({ createdAt: when, updatedAt: when, startedAt: when, completedAt: when })
    .where(eq(schema.scans.id, scanId));
}

async function ageAiReviewStart(scanId: string, minutes: number) {
  const db = createDb(env.DB);
  await db
    .update(schema.scans)
    .set({ aiStartedAt: new Date(Date.now() - minutes * 60_000) })
    .where(eq(schema.scans.id, scanId));
}

async function newScan(
  owner: SeededUser,
  suffix: string,
  options: { source?: "auto_discovery" | "workflow_gate"; ecosystem?: string } = {},
) {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const source = options.source ?? "auto_discovery";
  const stageId =
    source === "workflow_gate"
      ? `workflow-gate:gate-${suffix}:${options.ecosystem ?? "npm"}:pkg-${suffix}`
      : `stage-${suffix}-${scanId.slice(-8)}`;
  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    source,
  });
  return scanId;
}

describe("stalled scan reaper", () => {
  test("closes running scans that stalled and leaves fresh ones alone", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const stalled = await newScan(owner, "stalled");
    const fresh = await newScan(owner, "fresh");
    await claimScanForRun(db, stalled, owner.organizationId);
    await claimScanForRun(db, fresh, owner.organizationId);
    await ageScan(stalled, 45);

    const sweep = await failStalledScans(db, { runningTimeoutMs: STALLED_RUNNING_TIMEOUT_MS });
    expect(sweep).toMatchObject({ running: 1, pending: 0 });
    expect(sweep.scans).toEqual([
      expect.objectContaining({
        id: stalled,
        organizationId: owner.organizationId,
        ownerUserId: owner.userId,
        source: "auto_discovery",
        priorStatus: "running",
        error: expect.objectContaining({ code: "scan_stalled" }),
      }),
    ]);

    const closed = await getScanRecord(db, stalled, owner.organizationId);
    expect(closed?.status).toBe("failed");
    expect(closed?.risk).toBe("unknown");
    expect(closed?.errorJson).toMatchObject({ code: "scan_stalled", retryable: false });
    expect(closed?.completedAt).not.toBeNull();

    expect((await getScanRecord(db, fresh, owner.organizationId))?.status).toBe("running");
  });

  test("closes pending scans whose queue message never arrived, with a distinct reason", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const stranded = await newScan(owner, "stranded");
    await ageScan(stranded, 8 * 60);

    const sweep = await failStalledScans(db);
    expect(sweep).toMatchObject({ running: 0, pending: 1 });
    const closed = await getScanRecord(db, stranded, owner.organizationId);
    expect(closed?.status).toBe("failed");
    expect(closed?.errorJson).toMatchObject({ code: "scan_never_started" });
  });

  test("leaves a queued scan alone while a backlog could still be draining", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const queued = await newScan(owner, "backlog");
    // Well past the running timeout, but this row was never claimed: it is the
    // tail of a backlog, and reaping it would be the wrong answer to load.
    await ageScan(queued, 90);

    expect(await failStalledScans(db)).toMatchObject({ running: 0, pending: 0 });
    expect((await getScanRecord(db, queued, owner.organizationId))?.status).toBe("pending");
    expect(STALLED_QUEUED_TIMEOUT_MS).toBeGreaterThan(STALLED_RUNNING_TIMEOUT_MS);
  });

  test("never touches terminal scans and honors the per-sweep limit", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const first = await newScan(owner, "limit-a");
    const second = await newScan(owner, "limit-b");
    const done = await newScan(owner, "done");
    await claimScanForRun(db, done, owner.organizationId);
    await persistScan(db, {
      id: done,
      stageId: `stage-done-${done.slice(-8)}`,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
      risk: "low",
      status: "complete",
      summary: {},
      ai: null,
      files: [],
      diff: [],
      findings: [],
    });
    await ageScan(first, 8 * 60);
    await ageScan(second, 8 * 60);
    await ageScan(done, 8 * 60);

    expect(await failStalledScans(db, { limit: 1 })).toMatchObject({ running: 0, pending: 1 });
    expect(await failStalledScans(db, { limit: 5 })).toMatchObject({ running: 0, pending: 1 });
    expect(await failStalledScans(db, { limit: 5 })).toMatchObject({ running: 0, pending: 0 });
    expect((await getScanRecord(db, done, owner.organizationId))?.status).toBe("complete");
  });

  test("finds completed scans whose deferred AI review never came back", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const scanId = await newScan(owner, "ai-pending");
    const fresh = await newScan(owner, "ai-fresh");
    for (const id of [scanId, fresh]) {
      await claimScanForRun(db, id, owner.organizationId);
      await persistScan(db, {
        id,
        stageId: `stage-ai-${id.slice(-8)}`,
        organizationId: owner.organizationId,
        ownerUserId: owner.userId,
        risk: "medium",
        status: "complete",
        summary: {},
        ai: pendingAiReview(),
        files: [],
        diff: [],
        findings: [],
      });
    }
    await ageScan(scanId, 8 * 60);

    const abandoned = await listStalledAiReviewScans(db);
    expect(abandoned.map((row) => row.id)).toEqual([scanId]);
    // A completed scan whose review is still in flight is not a candidate.
    expect((await getScanRecord(db, fresh, owner.organizationId))?.aiStatus).toBe("pending");
  });

  test("ages an active AI review from its own start and revalidates before closing it", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const scanId = await newScan(owner, "ai-started");
    await claimScanForRun(db, scanId, owner.organizationId);
    await persistScan(db, {
      id: scanId,
      stageId: `stage-ai-${scanId.slice(-8)}`,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
      risk: "medium",
      status: "complete",
      summary: {},
      ai: pendingAiReview(),
      files: [],
      diff: [],
      findings: [],
    });
    await ageScan(scanId, 8 * 60);
    const sweepNow = new Date();
    const candidates = await listStalledAiReviewScans(db, { now: sweepNow });
    expect(candidates.map((row) => row.id)).toContain(scanId);

    // The queue delivery starts after the SELECT but before the closer's patch.
    // Its fresh start timestamp must make the atomic age guard refuse the stale
    // candidate, and refusal must leave the live evidence lifecycle pending.
    expect(await markAiReviewStarted(db, scanId, owner.organizationId)).toBe(true);
    expect(
      await closeAbandonedAiReview(env, db, scanId, owner.organizationId, {
        now: sweepNow,
        queuedTimeoutMs: STALLED_QUEUED_TIMEOUT_MS,
        runningTimeoutMs: STALLED_RUNNING_TIMEOUT_MS,
      }),
    ).toBe(false);
    expect((await getScanRecord(db, scanId, owner.organizationId))?.aiStatus).toBe("pending");
    expect((await listStalledAiReviewScans(db)).map((row) => row.id)).not.toContain(scanId);

    await ageAiReviewStart(scanId, 45);
    expect((await listStalledAiReviewScans(db)).map((row) => row.id)).toContain(scanId);
  });

  test("does not return candidates the closer would refuse", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    // `ai_status = "pending"` on a row that is not `complete` — a scan that was
    // re-run and failed, say. `closeAbandonedAiReview` refuses it, so returning
    // it would hand back the same row every tick and, with an ordered `limit`,
    // starve every real candidate queued behind it.
    const notComplete = await newScan(owner, "ai-not-complete");
    await db
      .update(schema.scans)
      .set({ aiStatus: "pending", status: "failed" })
      .where(eq(schema.scans.id, notComplete));
    await ageScan(notComplete, 8 * 60);

    const candidates = await listStalledAiReviewScans(db);
    expect(candidates.map((row) => row.id)).not.toContain(notComplete);
  });

  test("the scheduled reaper notifies the owner and records a terminal failure", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const stranded = await newScan(owner, "scheduled-notification");
    await ageScan(stranded, 8 * 60);

    const send = vi.fn(async () => undefined);
    const points: Array<{ blobs?: string[] }> = [];
    const ctx = createExecutionContext();
    await worker.scheduled(
      {
        scheduledTime: Date.now(),
        cron: "*/15 * * * *",
        noRetry() {},
      } as unknown as ScheduledController,
      {
        ...env,
        SEND_EMAIL: { send },
        PRODUCT_ANALYTICS: { writeDataPoint: (point: { blobs?: string[] }) => points.push(point) },
      } as unknown as Cloudflare.Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(send).toHaveBeenCalled();
    const events = await db
      .select({ type: schema.scanEvents.type, metadata: schema.scanEvents.metadataJson })
      .from(schema.scanEvents)
      .where(eq(schema.scanEvents.scanId, stranded));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "scan.notification_sent",
        metadata: expect.objectContaining({ outcome: "failed", channel: "email" }),
      }),
    );
    expect(points).toContainEqual(
      expect.objectContaining({
        blobs: expect.arrayContaining(["scan.failed", "auto_discovery", "scan_never_started"]),
      }),
    );
  });

  test("the scheduled reaper attributes workflow-gate failures to their ecosystem", async () => {
    const owner = await seedUser();
    const stranded = await newScan(owner, "pypi-gate", {
      source: "workflow_gate",
      ecosystem: "pypi",
    });
    await ageScan(stranded, 8 * 60);

    const points: Array<{ blobs?: string[] }> = [];
    const ctx = createExecutionContext();
    await worker.scheduled(
      {
        scheduledTime: Date.now(),
        cron: "*/15 * * * *",
        noRetry() {},
      } as unknown as ScheduledController,
      {
        ...env,
        PRODUCT_ANALYTICS: { writeDataPoint: (point: { blobs?: string[] }) => points.push(point) },
      } as unknown as Cloudflare.Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(points).toContainEqual(
      expect.objectContaining({
        blobs: [
          "1",
          "scan.failed",
          owner.organizationId,
          "pypi",
          "workflow_gate",
          "scan_never_started",
        ],
      }),
    );
  });
});

describe("withdrawn stage tombstones", () => {
  test("a discarded scan keeps suppressing rediscovery and stays out of the list", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const scanId = await newScan(owner, "withdrawn");
    const scan = await getScanRecord(db, scanId, owner.organizationId);
    const stageId = scan!.stageId;
    await claimScanForRun(db, scanId, owner.organizationId);

    await discardScanAttempt(db, scanId, owner.organizationId);

    const discarded = await getScanRecord(db, scanId, owner.organizationId);
    expect(discarded?.status).toBe("discarded");
    expect(discarded?.errorJson).toMatchObject({ code: "staged_tarball_withdrawn" });

    // The whole point of the tombstone: discovery still sees the stage id as
    // known, so the next cron tick does not re-create and re-queue the scan.
    const known = await listExistingScanStageIds(db, owner.organizationId, [stageId]);
    expect(known.has(stageId)).toBe(true);

    // It was never a review, so it is absent from every list — including "all",
    // which backs the has-ever-scanned probe.
    for (const filter of ["undecided", "all"] as const) {
      const listed = await listScans(db, owner.organizationId, { decisionFilter: filter });
      expect(listed.scans.map((row) => row.id)).not.toContain(scanId);
    }

    const rows = await db
      .select()
      .from(schema.scans)
      .where(
        and(eq(schema.scans.id, scanId), eq(schema.scans.organizationId, owner.organizationId)),
      );
    expect(rows).toHaveLength(1);
  });

  test("the reaper ignores discarded rows", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const scanId = await newScan(owner, "withdrawn-old");
    await claimScanForRun(db, scanId, owner.organizationId);
    await discardScanAttempt(db, scanId, owner.organizationId);
    await ageScan(scanId, 120);

    expect(await failStalledScans(db)).toMatchObject({ running: 0, pending: 0 });
    expect((await getScanRecord(db, scanId, owner.organizationId))?.status).toBe("discarded");
  });
});
