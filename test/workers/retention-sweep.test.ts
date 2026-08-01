import { env } from "cloudflare:test";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AUDIT_LOG_RETENTION_DAYS, pruneAuditEventsOlderThan } from "../../server/db/audit-log";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import {
  pruneExpiredSessions,
  pruneExpiredVerifications,
  listScansOlderThan,
} from "../../server/db/retention";
import { createScanJob, persistScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import {
  parseScanRetentionDays,
  runRetentionSweep,
  SCAN_RETENTION_MIN_DAYS,
} from "../../server/lib/retention";
import { writeScanArtifacts } from "../../server/lib/scan/artifacts";
import { sha256Hex, stableJson } from "../../server/lib/platform/stable-json";
import type { DiffEntry, FileRecord } from "../../server/lib/review";

const DAY_MS = 24 * 60 * 60 * 1000;

function safeSegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "~");
}

const files: FileRecord[] = [
  { path: "index.js", size: 14, sha256: "a".repeat(64), textSample: "console.log(1)", flags: [] },
];
const diff: DiffEntry[] = [
  { path: "index.js", status: "added", stagedSize: 14, stagedSha256: "a".repeat(64), flags: [] },
];

async function seedUser() {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Retention Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { db, userId, organizationId };
}

/** An artifact-backed completed scan whose row is then aged past the window. */
async function seedAgedScan(
  owner: { db: ReturnType<typeof createDb>; userId: string; organizationId: string },
  ageDays: number,
) {
  const { db } = owner;
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${scanId.slice(-12)}`;
  const reportJson = stableJson({ version: 1, diff, ruleFindings: [], findingAnnotations: [] });
  const reportDigest = await sha256Hex(reportJson);
  const artifacts = await writeScanArtifacts(env.ARTIFACTS, {
    organizationId: owner.organizationId,
    scanId,
    reportJson,
    reportDigest,
    files,
    diff,
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
  });
  await persistScan(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    packageJson: { name: "pkg", version: "1.0.0" },
    risk: "low",
    status: "complete",
    summary: {},
    ai: null,
    files,
    diff,
    findings: [],
    report: { version: 1, digest: reportDigest },
    artifacts,
  });
  await db.insert(schema.scanEvents).values({
    id: `evt_${crypto.randomUUID()}`,
    organizationId: owner.organizationId,
    scanId,
    type: "scan.decided",
    metadataJson: { decision: "publish" },
    createdAt: new Date(),
  });
  const aged = new Date(Date.now() - ageDays * DAY_MS);
  await db.update(schema.scans).set({ createdAt: aged }).where(eq(schema.scans.id, scanId));
  return scanId;
}

async function scanKeys(organizationId: string, scanId: string): Promise<string[]> {
  const listed = await env.ARTIFACTS.list({
    prefix: `orgs/${safeSegment(organizationId)}/scans/${safeSegment(scanId)}/`,
  });
  return listed.objects.map((object) => object.key);
}

async function countRows(table: string): Promise<number> {
  const db = createDb(env.DB);
  const rows = await db.all<{ n: number }>(sql.raw(`select count(*) as n from ${table}`));
  return rows[0]?.n ?? 0;
}

// Every assertion here counts rows and objects, and the retention sweeps are
// deliberately global (no organization scoping), so each test needs the tables it
// sweeps to start empty — the per-file reset in setup.ts is not enough.
beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  const db = createDb(env.DB);
  await db.delete(schema.scanEvents);
  await db.delete(schema.scans);
  await db.delete(schema.session);
  await db.delete(schema.verification);
  let cursor: string | undefined;
  do {
    const listed = await env.ARTIFACTS.list({ cursor });
    if (listed.objects.length > 0) {
      await env.ARTIFACTS.delete(listed.objects.map((object) => object.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
});

describe("parseScanRetentionDays", () => {
  test("unset means no scan deletion", () => {
    expect(parseScanRetentionDays({})).toBeNull();
    expect(parseScanRetentionDays({ SCAN_RETENTION_DAYS: "   " })).toBeNull();
  });

  test("a value below the floor is refused rather than obeyed", () => {
    expect(
      parseScanRetentionDays({ SCAN_RETENTION_DAYS: String(SCAN_RETENTION_MIN_DAYS - 1) }),
    ).toBeNull();
    expect(parseScanRetentionDays({ SCAN_RETENTION_DAYS: "1" })).toBeNull();
    expect(parseScanRetentionDays({ SCAN_RETENTION_DAYS: "0" })).toBeNull();
    expect(parseScanRetentionDays({ SCAN_RETENTION_DAYS: "-400" })).toBeNull();
  });

  test("junk is refused rather than coerced", () => {
    expect(parseScanRetentionDays({ SCAN_RETENTION_DAYS: "forever" })).toBeNull();
    expect(parseScanRetentionDays({ SCAN_RETENTION_DAYS: "Infinity" })).toBeNull();
  });

  test("an in-range value is accepted and floored", () => {
    expect(parseScanRetentionDays({ SCAN_RETENTION_DAYS: "400" })).toBe(400);
    expect(parseScanRetentionDays({ SCAN_RETENTION_DAYS: "365.9" })).toBe(365);
  });
});

describe("bounded auth sweeps", () => {
  test("expired sessions are deleted in bounded batches and live ones are kept", async () => {
    const { db, userId } = await seedUser();
    const now = new Date();
    const rows = Array.from({ length: 7 }, (_unused, index) => ({
      id: `sess_${crypto.randomUUID()}`,
      token: `tok_${crypto.randomUUID()}`,
      userId,
      expiresAt: new Date(now.getTime() + (index < 2 ? DAY_MS : -DAY_MS)),
      createdAt: now,
      updatedAt: now,
    }));
    await db.insert(schema.session).values(rows);

    // batchSize 2 over 5 expired rows: three statements, and the sweep reports
    // that it drained rather than that it hit the cap.
    const outcome = await pruneExpiredSessions(db, now, { batchSize: 2, maxBatches: 10 });
    expect(outcome.deleted).toBe(5);
    expect(outcome.batches).toBe(3);
    expect(outcome.moreRemaining).toBe(false);
    expect(await countRows("session")).toBe(2);
  });

  test("the batch cap stops the sweep and says more remain", async () => {
    const { db, userId } = await seedUser();
    const now = new Date();
    await db.insert(schema.session).values(
      Array.from({ length: 6 }, () => ({
        id: `sess_${crypto.randomUUID()}`,
        token: `tok_${crypto.randomUUID()}`,
        userId,
        expiresAt: new Date(now.getTime() - DAY_MS),
        createdAt: now,
        updatedAt: now,
      })),
    );

    const outcome = await pruneExpiredSessions(db, now, { batchSize: 2, maxBatches: 2 });
    expect(outcome.deleted).toBe(4);
    expect(outcome.moreRemaining).toBe(true);
    expect(await countRows("session")).toBe(2);
  });

  test("expired verification tokens are swept, unexpired ones are not", async () => {
    const db = createDb(env.DB);
    const now = new Date();
    await db.insert(schema.verification).values([
      {
        id: `ver_${crypto.randomUUID()}`,
        identifier: "stale@example.com",
        value: "token-a",
        expiresAt: new Date(now.getTime() - DAY_MS),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `ver_${crypto.randomUUID()}`,
        identifier: "fresh@example.com",
        value: "token-b",
        expiresAt: new Date(now.getTime() + DAY_MS),
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const outcome = await pruneExpiredVerifications(db, now);
    expect(outcome.deleted).toBe(1);
    const remaining = await db.select().from(schema.verification);
    expect(remaining.map((row) => row.identifier)).toEqual(["fresh@example.com"]);
  });

  test("audit-event pruning is bounded instead of one unbounded DELETE", async () => {
    const { db, organizationId } = await seedUser();
    const old = new Date(Date.now() - (AUDIT_LOG_RETENTION_DAYS + 5) * DAY_MS);
    await db.insert(schema.scanEvents).values(
      Array.from({ length: 5 }, () => ({
        id: `evt_${crypto.randomUUID()}`,
        organizationId,
        type: "scan.decided",
        metadataJson: {},
        createdAt: old,
      })),
    );
    await db.insert(schema.scanEvents).values({
      id: `evt_${crypto.randomUUID()}`,
      organizationId,
      type: "scan.decided",
      metadataJson: {},
      createdAt: new Date(),
    });

    const cutoff = new Date(Date.now() - AUDIT_LOG_RETENTION_DAYS * DAY_MS);
    const outcome = await pruneAuditEventsOlderThan(db, cutoff, { batchSize: 2, maxBatches: 10 });
    expect(outcome.deleted).toBe(5);
    expect(outcome.batches).toBe(3);
    expect(await countRows("scan_events")).toBe(1);
  });
});

describe("scan retention", () => {
  test("is off by default: an ancient scan and its artifacts survive", async () => {
    const owner = await seedUser();
    const scanId = await seedAgedScan(owner, 5000);

    const result = await runRetentionSweep(env as unknown as Cloudflare.Env);
    expect(result.scans).toBeNull();

    const [row] = await owner.db.select().from(schema.scans).where(eq(schema.scans.id, scanId));
    expect(row).toBeDefined();
    expect(await scanKeys(owner.organizationId, scanId)).toHaveLength(4);
  });

  test("deletes aged scans, their D1 children, and their R2 prefix when enabled", async () => {
    const owner = await seedUser();
    const doomed = await seedAgedScan(owner, 400);
    const kept = await seedAgedScan(owner, 10);

    const result = await runRetentionSweep({
      ...env,
      SCAN_RETENTION_DAYS: "365",
    } as unknown as Cloudflare.Env);

    expect(result.scans).toMatchObject({ retentionDays: 365, candidates: 1, deleted: 1 });
    expect(result.scans?.objectsDeleted).toBe(4);

    const remaining = await owner.db.select({ id: schema.scans.id }).from(schema.scans);
    expect(remaining.map((row) => row.id)).toEqual([kept]);
    // Children go with the parent, evidence first.
    expect(
      await owner.db.select().from(schema.scanEvents).where(eq(schema.scanEvents.scanId, doomed)),
    ).toEqual([]);
    // And no redacted evidence outlives the metadata that pointed at it.
    expect(await scanKeys(owner.organizationId, doomed)).toEqual([]);
    expect(await scanKeys(owner.organizationId, kept)).toHaveLength(4);
  });

  test("holds the D1 delete back when the R2 prefix cannot be swept", async () => {
    const owner = await seedUser();
    const scanId = await seedAgedScan(owner, 400);
    const brokenBucket = {
      list: async () => {
        throw new Error("R2 unavailable");
      },
      delete: async () => undefined,
    } as unknown as R2Bucket;

    const result = await runRetentionSweep({
      ...env,
      ARTIFACTS: brokenBucket,
      SCAN_RETENTION_DAYS: "365",
    } as unknown as Cloudflare.Env);

    expect(result.scans).toMatchObject({ candidates: 1, deleted: 0, deferred: 1 });
    // The row stays so the next tick retries; deleting it first would strand the
    // objects with nothing left pointing at them.
    const [row] = await owner.db.select().from(schema.scans).where(eq(schema.scans.id, scanId));
    expect(row).toBeDefined();
    expect(await scanKeys(owner.organizationId, scanId)).toHaveLength(4);
  });

  test("is skipped entirely without the ARTIFACTS binding", async () => {
    const owner = await seedUser();
    const scanId = await seedAgedScan(owner, 400);

    const { ARTIFACTS: _omitted, ...withoutBucket } = env as unknown as Cloudflare.Env;
    const result = await runRetentionSweep({
      ...withoutBucket,
      SCAN_RETENTION_DAYS: "365",
    } as unknown as Cloudflare.Env);

    expect(result.scans).toBeNull();
    const [row] = await owner.db.select().from(schema.scans).where(eq(schema.scans.id, scanId));
    expect(row).toBeDefined();
    expect(await scanKeys(owner.organizationId, scanId)).toHaveLength(4);
  });

  test("the candidate query is bounded per tick and ordered oldest-first", async () => {
    const owner = await seedUser();
    await seedAgedScan(owner, 500);
    await seedAgedScan(owner, 400);
    await seedAgedScan(owner, 300);

    const cutoff = new Date(Date.now() - 200 * DAY_MS);
    const page = await listScansOlderThan(owner.db, cutoff, 2);
    expect(page).toHaveLength(2);
    const [first, second] = page;
    const rows = await owner.db.select().from(schema.scans);
    const byId = new Map(rows.map((row) => [row.id, row.createdAt.getTime()]));
    expect(byId.get(first.id)!).toBeLessThan(byId.get(second.id)!);
  });

  test("the candidate scan is served by an index on created_at", async () => {
    const db = createDb(env.DB);
    const plan = await db.all<{ detail: string }>(sql`
      explain query plan
      select id from scans where created_at < 0 order by created_at, id limit 50
    `);
    expect(plan.map((row) => row.detail).join(" | ")).toContain("scans_created_idx");
  });

  test("a failing sweep does not stop the others", async () => {
    const brokenDb = {
      prepare(): never {
        throw new Error("D1_ERROR: simulated outage");
      },
    } as unknown as D1Database;

    const result = await runRetentionSweep({
      ...env,
      DB: brokenDb,
    } as unknown as Cloudflare.Env);
    expect(result.auditEvents).toBeNull();
    expect(result.sessions).toBeNull();
    expect(result.verifications).toBeNull();
    expect(result.scans).toBeNull();
  });
});
