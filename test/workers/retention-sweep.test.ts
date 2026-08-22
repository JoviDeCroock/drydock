import { env } from "cloudflare:test";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AUDIT_LOG_RETENTION_DAYS, pruneAuditEventsOlderThan } from "../../server/db/audit-log";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { AUTH_ROW_RETENTION_GRACE_MS, pruneExpiredAuthRows } from "../../server/db/auth-retention";
import { listScansOlderThan } from "../../server/db/retention";
import { enablePublicShare, revokePublicShare } from "../../server/db/scan-share";
import { createScanJob, persistScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { createReleaseTarget, upsertInstallation } from "../../server/lib/github-app/persistence";
import {
  parseScanRetentionDays,
  resetRetentionMisconfigurationLatch,
  runRetentionSweep,
  SCAN_RETENTION_CLAIM_LEASE_MS,
  SCAN_RETENTION_MIN_DAYS,
} from "../../server/lib/retention";
import { writeScanArtifacts } from "../../server/lib/scan/artifacts";
import { sha256Hex } from "../../server/lib/platform/crypto-utils";
import { stableJson } from "../../server/lib/platform/stable-json";
import type { DiffEntry, FileRecord, Finding } from "../../server/lib/review";

const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = AUTH_ROW_RETENTION_GRACE_MS;

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
  options: { artifactBacked?: boolean; findings?: Finding[] } = {},
) {
  const { db } = owner;
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${scanId.slice(-12)}`;
  const findings = options.findings ?? [];
  const reportJson = stableJson({
    version: 1,
    diff,
    ruleFindings: findings,
    findingAnnotations: [],
  });
  const reportDigest = await sha256Hex(reportJson);
  const artifacts =
    options.artifactBacked === false
      ? null
      : await writeScanArtifacts(env.ARTIFACTS, {
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
    findings,
    report: { version: 1, digest: reportDigest },
    ...(artifacts ? { artifacts } : {}),
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

/**
 * A pending workflow gate pointing at `scanId`. `scans.gate_id` and
 * `github_workflow_gates.scan_id` are enforced FKs in the test D1, so the whole
 * installation → release-target → gate chain has to exist.
 */
async function seedPendingGate(
  owner: { db: ReturnType<typeof createDb>; organizationId: string },
  scanId: string,
): Promise<string> {
  const installation = await upsertInstallation(owner.db, {
    organizationId: owner.organizationId,
    installationId: `inst_${crypto.randomUUID()}`,
    accountLogin: "octo",
    accountType: "Organization",
    targetType: "Organization",
    status: "active",
    createdByUserId: null,
  });
  const releaseTarget = await createReleaseTarget(owner.db, {
    organizationId: owner.organizationId,
    installationRowId: installation.id,
    repositoryId: 1234,
    repositoryFullName: "octo/pkg",
    environment: "release",
    ecosystem: null,
    artifactName: null,
    createdByUserId: null,
  });
  const now = new Date();
  const gateId = `gate_${crypto.randomUUID()}`;
  await owner.db.insert(schema.githubWorkflowGates).values({
    id: gateId,
    organizationId: owner.organizationId,
    installationRowId: installation.id,
    releaseTargetId: releaseTarget.id,
    deliveryId: `delivery_${crypto.randomUUID()}`,
    repositoryId: 1234,
    repositoryFullName: "octo/pkg",
    environment: "release",
    runId: 99,
    deploymentCallbackUrl: "https://api.github.com/callback",
    eventAction: "requested",
    status: "pending",
    scanId,
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return gateId;
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
  resetRetentionMisconfigurationLatch();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  const db = createDb(env.DB);
  await db.delete(schema.scanEvents);
  await db.delete(schema.githubWorkflowGates);
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
  // The grace period and the "what is eligible" rules live in
  // test/workers/auth-retention.test.ts; these cover the batching this phase added
  // on top of them.
  test("expired auth rows are deleted in bounded batches and live ones are kept", async () => {
    const { db, userId } = await seedUser();
    const now = new Date();
    const expired = new Date(now.getTime() - 2 * GRACE_MS);
    const live = new Date(now.getTime() + DAY_MS);
    await db.insert(schema.session).values(
      Array.from({ length: 7 }, (_unused, index) => ({
        id: `sess_${crypto.randomUUID()}`,
        token: `tok_${crypto.randomUUID()}`,
        userId,
        expiresAt: index < 2 ? live : expired,
        createdAt: now,
        updatedAt: now,
      })),
    );

    // batchSize 2 over 5 expired rows: three statements, and the sweep reports
    // that it drained rather than that it hit the cap.
    const outcome = await pruneExpiredAuthRows(db, now, { batchSize: 2, maxBatches: 10 });
    expect(outcome.sessions).toBe(5);
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
        expiresAt: new Date(now.getTime() - 2 * GRACE_MS),
        createdAt: now,
        updatedAt: now,
      })),
    );

    const outcome = await pruneExpiredAuthRows(db, now, { batchSize: 2, maxBatches: 2 });
    expect(outcome.sessions).toBe(4);
    expect(outcome.moreRemaining).toBe(true);
    expect(await countRows("session")).toBe(2);
  });

  test("a row inside the refresh grace period is not touched", async () => {
    const { db, userId } = await seedUser();
    const now = new Date();
    // Expired seconds ago: Better Auth refreshes by rewriting expires_at on the
    // same row, so this may be mid-refresh.
    await db.insert(schema.session).values({
      id: `sess_${crypto.randomUUID()}`,
      token: `tok_${crypto.randomUUID()}`,
      userId,
      expiresAt: new Date(now.getTime() - 1000),
      createdAt: now,
      updatedAt: now,
    });

    expect(await pruneExpiredAuthRows(db, now)).toMatchObject({ sessions: 0 });
    expect(await countRows("session")).toBe(1);
  });

  test("the scheduled pass sweeps auth rows through the graced helper", async () => {
    const { db, userId } = await seedUser();
    const now = new Date();
    await db.insert(schema.session).values({
      id: `sess_${crypto.randomUUID()}`,
      token: `tok_${crypto.randomUUID()}`,
      userId,
      expiresAt: new Date(now.getTime() - 2 * GRACE_MS),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.verification).values({
      id: `ver_${crypto.randomUUID()}`,
      identifier: "stale@example.com",
      value: "token-a",
      expiresAt: new Date(now.getTime() - 2 * GRACE_MS),
      createdAt: now,
      updatedAt: now,
    });

    const result = await runRetentionSweep(env as unknown as Cloudflare.Env);
    expect(result.authRows).toMatchObject({ sessions: 1, verifications: 1 });
    expect(await countRows("session")).toBe(0);
    expect(await countRows("verification")).toBe(0);
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
    expect(await countRows("scan_files")).toBe(0);
    expect(await countRows("scan_findings")).toBe(0);
    // And no redacted evidence outlives the metadata that pointed at it.
    expect(await scanKeys(owner.organizationId, doomed)).toEqual([]);
    expect(await scanKeys(owner.organizationId, kept)).toHaveLength(4);
  });

  test("keeps audit events that are younger than the audit window", async () => {
    const owner = await seedUser();
    const doomed = await seedAgedScan(owner, 400);
    // The scan is 400 days old; this decision was recorded yesterday. The two
    // retention windows are independent, so a one-day-old audit row must not be
    // deleted just because its scan aged out.
    const recent = `evt_${crypto.randomUUID()}`;
    await owner.db.insert(schema.scanEvents).values({
      id: recent,
      organizationId: owner.organizationId,
      scanId: doomed,
      type: "scan.decided",
      metadataJson: { decision: "publish" },
      createdAt: new Date(Date.now() - DAY_MS),
    });
    // ...while this one is past the audit window and goes with the scan.
    const stale = `evt_${crypto.randomUUID()}`;
    await owner.db.insert(schema.scanEvents).values({
      id: stale,
      organizationId: owner.organizationId,
      scanId: doomed,
      type: "scan.decided",
      metadataJson: { decision: "publish" },
      createdAt: new Date(Date.now() - (AUDIT_LOG_RETENTION_DAYS + 5) * DAY_MS),
    });

    await runRetentionSweep({
      ...env,
      SCAN_RETENTION_DAYS: "365",
    } as unknown as Cloudflare.Env);

    const events = await owner.db.select().from(schema.scanEvents);
    const ids = events.map((row) => row.id);
    expect(ids).toContain(recent);
    expect(ids).not.toContain(stale);
    // Detached rather than cascaded away: the deep link is gone because the scan
    // is, but the audit record survives to its own 90-day window.
    const survivor = events.find((row) => row.id === recent);
    expect(survivor?.scanId).toBeNull();
    expect(survivor?.organizationId).toBe(owner.organizationId);
    // Nothing still points at the deleted scan.
    expect(events.every((row) => row.scanId === null)).toBe(true);
  });

  test("clears artifact metadata after the R2 sweep, so a failed row delete stays honest", async () => {
    const owner = await seedUser();
    const scanId = await seedAgedScan(owner, 400);
    // Let the R2 sweep and the metadata update through, then fail the row delete.
    // Without the metadata clear this leaves an artifact-backed row whose
    // evidence is already gone, rendering as a clean, finding-free scan.
    const prepare = env.DB.prepare.bind(env.DB);
    const failingDb = {
      prepare(query: string) {
        if (/^\s*delete\s+from\s+"?scans"?/i.test(query)) {
          throw new Error("D1_ERROR: simulated outage");
        }
        return prepare(query);
      },
      batch: env.DB.batch?.bind(env.DB),
      dump: env.DB.dump?.bind(env.DB),
      exec: env.DB.exec?.bind(env.DB),
    } as unknown as D1Database;

    const result = await runRetentionSweep({
      ...env,
      DB: failingDb,
      SCAN_RETENTION_DAYS: "365",
    } as unknown as Cloudflare.Env);

    expect(result.scans).toMatchObject({ deleted: 0, deferred: 1 });
    const [row] = await owner.db.select().from(schema.scans).where(eq(schema.scans.id, scanId));
    // The row survives, but it no longer claims artifacts it does not have — so
    // no reader chases R2 for deleted evidence, and the next tick finishes.
    expect(row).toBeDefined();
    expect(row?.artifactStorageVersion).toBeNull();
    expect(row?.reportArtifactKey).toBeNull();
    expect(row?.diffArtifactKey).toBeNull();
    expect(row?.retentionClaimToken).toEqual(expect.any(String));
    expect(row?.retentionClaimedAt?.getTime()).toBe(0);

    // Evidence is already gone, so sharing stays fenced; the expired claim lets
    // the next tick finish immediately instead of waiting out the normal lease.
    await expect(
      enablePublicShare(owner.db, {
        scanId,
        organizationId: owner.organizationId,
        actorUserId: owner.userId,
      }),
    ).resolves.toBeNull();
    await expect(
      runRetentionSweep({
        ...env,
        SCAN_RETENTION_DAYS: "365",
      } as unknown as Cloudflare.Env),
    ).resolves.toMatchObject({ scans: { deleted: 1 } });
  });

  test("rolls back D1 detail and audit mutations when the parent delete fails", async () => {
    const owner = await seedUser();
    const retainedFinding: Finding = {
      severity: "medium",
      file: "index.js",
      evidence: "fetch('https://example.com')",
      reason: "network access",
      line: 1,
      ruleId: "code.network-access",
      ruleVersion: "1.8.0",
    };
    const scanId = await seedAgedScan(owner, 400, {
      artifactBacked: false,
      findings: [retainedFinding],
    });
    // Fail the final statement from inside a real D1 batch. The trigger makes the
    // parent DELETE abort after the preceding child/event statements have run, so
    // this only preserves them when D1 rolls the whole batch back atomically.
    const triggerName = `fail_retention_delete_${crypto.randomUUID().replaceAll("-", "_")}`;
    await env.DB.prepare(
      `create trigger ${triggerName}
       before delete on scans
       when old.id = '${scanId}'
       begin
         select raise(abort, 'simulated retention delete failure');
       end`,
    ).run();
    let result: Awaited<ReturnType<typeof runRetentionSweep>>;
    try {
      result = await runRetentionSweep({
        ...env,
        SCAN_RETENTION_DAYS: "365",
      } as unknown as Cloudflare.Env);
    } finally {
      await env.DB.exec(`drop trigger if exists ${triggerName}`);
    }

    expect(result.scans).toMatchObject({ deleted: 0, deferred: 1 });
    expect(
      await owner.db.select().from(schema.scans).where(eq(schema.scans.id, scanId)),
    ).toHaveLength(1);
    expect(
      await owner.db.select().from(schema.scanFiles).where(eq(schema.scanFiles.scanId, scanId)),
    ).toHaveLength(1);
    expect(
      await owner.db
        .select()
        .from(schema.scanFindings)
        .where(eq(schema.scanFindings.scanId, scanId)),
    ).toHaveLength(1);
    const events = await owner.db
      .select()
      .from(schema.scanEvents)
      .where(eq(schema.scanEvents.organizationId, owner.organizationId));
    expect(events.some((event) => event.scanId === scanId)).toBe(true);
  });

  test("a failed R2 sweep leaves the scan row completely intact", async () => {
    const owner = await seedUser();
    const scanId = await seedAgedScan(owner, 400);
    // The sweep is the only teardown step that leaves D1, so it is the likeliest
    // to fail. Clearing the artifact columns first would strand a live, expired
    // scan that renders with zero files and zero findings while its `risk` and
    // `finding_count` still advertise them — and with its manifest key gone, its
    // still-present R2 objects could not be re-linked.
    const failingBucket = {
      list: async () => {
        throw new Error("R2 unavailable");
      },
      delete: async () => {},
    } as unknown as R2Bucket;

    const result = await runRetentionSweep({
      ...env,
      ARTIFACTS: failingBucket,
      SCAN_RETENTION_DAYS: "365",
    } as unknown as Cloudflare.Env);

    expect(result.scans).toMatchObject({ deleted: 0, deferred: 1 });
    const [row] = await owner.db.select().from(schema.scans).where(eq(schema.scans.id, scanId));
    expect(row?.artifactStorageVersion).not.toBeNull();
    expect(row?.artifactManifestKey).not.toBeNull();
    expect(row?.artifactManifestDigest).not.toBeNull();
    expect(row?.reportArtifactKey).not.toBeNull();
    expect(row?.diffArtifactKey).not.toBeNull();
    // Nothing was deleted, so the next tick can still read and finish it.
    expect(await scanKeys(owner.organizationId, scanId)).not.toEqual([]);
  });

  test("a deferred scan does not starve the deletable ones behind it", async () => {
    const owner = await seedUser();
    const stuck = await seedAgedScan(owner, 500);
    const deletable = await seedAgedScan(owner, 400);
    // The oldest candidate's prefix can never be swept. Without paging past it,
    // an oldest-first fixed-size window would return it forever and nothing
    // behind it would ever be deleted.
    const partialBucket = {
      list: async (options: R2ListOptions) => {
        if (options?.prefix?.includes(stuck)) throw new Error("R2 unavailable");
        return env.ARTIFACTS.list(options);
      },
      delete: async (keys: string | string[]) => env.ARTIFACTS.delete(keys),
    } as unknown as R2Bucket;

    const result = await runRetentionSweep({
      ...env,
      ARTIFACTS: partialBucket,
      SCAN_RETENTION_DAYS: "365",
    } as unknown as Cloudflare.Env);

    expect(result.scans).toMatchObject({ deleted: 1, deferred: 1 });
    const remaining = await owner.db.select({ id: schema.scans.id }).from(schema.scans);
    expect(remaining.map((row) => row.id)).toEqual([stuck]);
    expect(await scanKeys(owner.organizationId, deletable)).toEqual([]);
  });

  test("skips scans with no organization instead of deferring them forever", async () => {
    const owner = await seedUser();
    const orphan = await seedAgedScan(owner, 500);
    await seedAgedScan(owner, 400);
    // An org deletion already swept this scan's artifacts and nulled its owner;
    // the sweep can neither scope a delete nor derive a prefix for it.
    await env.ARTIFACTS.delete(await scanKeys(owner.organizationId, orphan));
    await owner.db
      .update(schema.scans)
      .set({ organizationId: null })
      .where(eq(schema.scans.id, orphan));

    const result = await runRetentionSweep({
      ...env,
      SCAN_RETENTION_DAYS: "365",
    } as unknown as Cloudflare.Env);

    // The orphan is never even a candidate, so it cannot occupy a slot each tick.
    expect(result.scans).toMatchObject({ candidates: 1, deleted: 1, deferred: 0 });
    const remaining = await owner.db.select({ id: schema.scans.id }).from(schema.scans);
    expect(remaining.map((row) => row.id)).toEqual([orphan]);
  });

  test("leaves every package scan attached to a still-pending workflow gate alone", async () => {
    const owner = await seedUser();
    const representative = await seedAgedScan(owner, 400);
    const sibling = await seedAgedScan(owner, 400);
    const gateId = await seedPendingGate(owner, representative);
    // A monorepo gate points `github_workflow_gates.scan_id` at only one
    // representative package. Leave that row on the representative fallback;
    // the sibling exercises the authoritative `scans.gate_id` membership link.
    await owner.db.update(schema.scans).set({ gateId }).where(eq(schema.scans.id, sibling));

    const pending = await runRetentionSweep({
      ...env,
      SCAN_RETENTION_DAYS: "365",
    } as unknown as Cloudflare.Env);
    expect(pending.scans).toMatchObject({ candidates: 0, deleted: 0 });
    expect(await scanKeys(owner.organizationId, representative)).toHaveLength(4);
    expect(await scanKeys(owner.organizationId, sibling)).toHaveLength(4);

    // Once the gate is decided every package scan is eligible again.
    await owner.db
      .update(schema.githubWorkflowGates)
      .set({ status: "approved" })
      .where(eq(schema.githubWorkflowGates.id, gateId));
    const decided = await runRetentionSweep({
      ...env,
      SCAN_RETENTION_DAYS: "365",
    } as unknown as Cloudflare.Env);
    expect(decided.scans).toMatchObject({ candidates: 2, deleted: 2 });
  });

  test("never deletes a scan whose public share link is still live", async () => {
    const owner = await seedUser();
    const shared = await seedAgedScan(owner, 400);
    await seedAgedScan(owner, 400);
    const share = await enablePublicShare(owner.db, {
      scanId: shared,
      organizationId: owner.organizationId,
      actorUserId: owner.userId,
    });
    expect(share?.publicShareToken).toBeTruthy();

    // docs/public-reports.md promises revocation is the owner's action: the
    // sweep must not silently unpublish a distributed link — and the feed
    // listing and badge that hang off its token — because the scan aged out.
    // Like the org-less and pending-gate rows, a shared scan is excluded from
    // the candidate query rather than deferred, so it costs no page slot.
    const first = await runRetentionSweep({
      ...env,
      SCAN_RETENTION_DAYS: "365",
    } as unknown as Cloudflare.Env);
    expect(first.scans).toMatchObject({ candidates: 1, deleted: 1, deferred: 0 });
    const remaining = await owner.db.select({ id: schema.scans.id }).from(schema.scans);
    expect(remaining.map((row) => row.id)).toEqual([shared]);
    expect(await scanKeys(owner.organizationId, shared)).toHaveLength(4);

    // Revoking the share is what returns the scan to the retention window.
    await revokePublicShare(owner.db, {
      scanId: shared,
      organizationId: owner.organizationId,
      actorUserId: owner.userId,
    });
    const second = await runRetentionSweep({
      ...env,
      SCAN_RETENTION_DAYS: "365",
    } as unknown as Cloudflare.Env);
    expect(second.scans).toMatchObject({ candidates: 1, deleted: 1 });
    expect(await countRows("scans")).toBe(0);
  });

  test("does not mint a public share after retention has claimed the scan", async () => {
    const owner = await seedUser();
    const scanId = await seedAgedScan(owner, 400);
    let releaseList!: () => void;
    const listReleased = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let reportListStarted!: () => void;
    const listStarted = new Promise<void>((resolve) => {
      reportListStarted = resolve;
    });
    const blockingBucket = {
      async list(options: R2ListOptions) {
        reportListStarted();
        await listReleased;
        return env.ARTIFACTS.list(options);
      },
      delete(keys: string | string[]) {
        return env.ARTIFACTS.delete(keys);
      },
    } as unknown as R2Bucket;

    const sweep = runRetentionSweep({
      ...env,
      ARTIFACTS: blockingBucket,
      SCAN_RETENTION_DAYS: "365",
    } as unknown as Cloudflare.Env);
    await listStarted;

    // The candidate read has completed and teardown is paused at the first R2
    // operation. This is the exact window where sharing used to mint a token
    // that the already-running sweep immediately deleted.
    const share = await enablePublicShare(owner.db, {
      scanId,
      organizationId: owner.organizationId,
      actorUserId: owner.userId,
    });
    expect(share).toBeNull();

    releaseList();
    await expect(sweep).resolves.toMatchObject({ scans: { deleted: 1 } });
    expect(
      await owner.db.select().from(schema.scans).where(eq(schema.scans.id, scanId)),
    ).toHaveLength(0);
  });

  test("recovers an expired retention claim after an interrupted tick", async () => {
    const owner = await seedUser();
    const scanId = await seedAgedScan(owner, 400);
    await owner.db
      .update(schema.scans)
      .set({
        retentionClaimToken: "abandoned-claim",
        retentionClaimedAt: new Date(Date.now() - SCAN_RETENTION_CLAIM_LEASE_MS - 1),
      })
      .where(eq(schema.scans.id, scanId));

    const result = await runRetentionSweep({
      ...env,
      SCAN_RETENTION_DAYS: "365",
    } as unknown as Cloudflare.Env);

    expect(result.scans).toMatchObject({ candidates: 1, deleted: 1, deferred: 0 });
  });

  test("a misconfigured window is reported once, not on every tick", async () => {
    // beforeEach already installed a console spy for this file, and vitest hands
    // back the same one; clear it so only this test's calls are counted.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    errorSpy.mockClear();
    const misconfigured = { ...env, SCAN_RETENTION_DAYS: "7" } as unknown as Cloudflare.Env;

    await runRetentionSweep(misconfigured);
    await runRetentionSweep(misconfigured);
    await runRetentionSweep(misconfigured);

    // The cron fires every 15 minutes; a standing misconfiguration must not
    // contribute ~96 identical error lines a day.
    const reports = errorSpy.mock.calls.filter(
      (call) => call[0] === "retention.scans.misconfigured",
    );
    expect(reports).toHaveLength(1);
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
    expect(row?.retentionClaimToken).toBeNull();
    expect(row?.retentionClaimedAt).toBeNull();

    // A pre-R2 failure releases the lease, so disabling retention after an
    // outage does not leave an otherwise-readable scan permanently unshareable.
    await expect(
      enablePublicShare(owner.db, {
        scanId,
        organizationId: owner.organizationId,
        actorUserId: owner.userId,
      }),
    ).resolves.toMatchObject({ publicShareToken: expect.any(String) });
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
    expect(result.authRows).toBeNull();
    expect(result.scans).toBeNull();
  });
});
