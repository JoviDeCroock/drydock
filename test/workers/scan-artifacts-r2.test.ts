import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import {
  createDb,
  createScanJob,
  ensurePersonalOrganization,
  getScan,
  markScanArtifactBacked,
  persistScan,
} from "../../server/db";
import * as schema from "../../server/db/schema";
import { sha256Hex, stableJson } from "../../server/lib/canonical-json";
import {
  artifactBackfillEnabled,
  runArtifactBackfillSweep,
} from "../../server/lib/artifact-backfill";
import {
  buildPipelineArtifactBundle,
  readScanArtifact,
  SCAN_ARTIFACT_STORAGE_VERSION,
  scanArtifactKey,
  writeScanArtifact,
} from "../../server/lib/scan-artifacts";

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
    name: "Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, organizationId };
}

async function seedCompletedScan(
  owner: SeededUser,
  overrides: { textSample?: string } = {},
): Promise<string> {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${scanId.slice(-12)}`;
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
    packageJson: { name: "@org/pkg", version: "1.0.0" },
    risk: "low",
    status: "complete",
    summary: { diff: [{ path: "index.js", status: "modified" }] },
    ai: null,
    files: [
      {
        path: "index.js",
        size: 12,
        sha256: "abc",
        flags: [],
        textSample: overrides.textSample ?? "D1-SAMPLE",
      },
    ],
    diff: [{ path: "index.js", status: "modified", flags: [] }],
    findings: [],
    report: { version: 1, digest: "report-digest" },
  });
  return scanId;
}

/** Env shim exposing only the bindings the backfill sweep reads. */
function backfillEnv(enabled: boolean): Cloudflare.Env {
  return {
    ARTIFACTS: env.ARTIFACTS,
    ARTIFACT_BACKFILL: enabled ? "1" : undefined,
  } as unknown as Cloudflare.Env;
}

describe("R2 scan artifact dual-write", () => {
  test("writes a digest-verified pipeline bundle and marks the row artifact-backed", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const db = createDb(env.DB);
    const reportPayload = { version: 1, findings: [], summary: "ok" };
    const reportDigest = await sha256Hex(stableJson(reportPayload));

    const bundle = buildPipelineArtifactBundle({
      scanId,
      organizationId: owner.organizationId,
      reportVersion: 1,
      reportDigest,
      reportPayload,
      summary: { diff: [{ path: "index.js", status: "modified" }] },
      fileSamples: [{ path: "index.js", textSample: "R2-SAMPLE" }],
    });
    const written = await writeScanArtifact(env.ARTIFACTS, bundle);
    await markScanArtifactBacked(db, {
      scanId,
      organizationId: owner.organizationId,
      storageVersion: written.storageVersion,
      key: written.key,
      digest: written.digest,
      size: written.size,
    });

    expect(written.key).toBe(scanArtifactKey(owner.organizationId, scanId));
    const [row] = await db
      .select({
        artifactStorageVersion: schema.scans.artifactStorageVersion,
        artifactKey: schema.scans.artifactKey,
        artifactDigest: schema.scans.artifactDigest,
        artifactSize: schema.scans.artifactSize,
      })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId))
      .limit(1);
    expect(row?.artifactStorageVersion).toBe(SCAN_ARTIFACT_STORAGE_VERSION);
    expect(row?.artifactKey).toBe(written.key);
    expect(row?.artifactDigest).toBe(written.digest);
    expect(row?.artifactSize).toBe(written.size);

    const object = await env.ARTIFACTS.get(written.key);
    expect(object).not.toBeNull();
    expect(await sha256Hex(await object!.text())).toBe(written.digest);
  });

  test("rejects a pipeline bundle whose report digest does not match the payload", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const bundle = buildPipelineArtifactBundle({
      scanId,
      organizationId: owner.organizationId,
      reportVersion: 1,
      reportDigest: "deadbeef",
      reportPayload: { version: 1, findings: [] },
      summary: {},
      fileSamples: [],
    });
    await expect(writeScanArtifact(env.ARTIFACTS, bundle)).rejects.toMatchObject({
      code: "report_digest_mismatch",
    });
  });
});

describe("R2 scan artifact shadow-read", () => {
  test("getScan hydrates file samples from R2 and falls back to D1 without a bucket", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, { textSample: "D1-SAMPLE" });
    const db = createDb(env.DB);
    const reportPayload = { version: 1 };
    const reportDigest = await sha256Hex(stableJson(reportPayload));
    const written = await writeScanArtifact(
      env.ARTIFACTS,
      buildPipelineArtifactBundle({
        scanId,
        organizationId: owner.organizationId,
        reportVersion: 1,
        reportDigest,
        reportPayload,
        summary: {},
        fileSamples: [{ path: "index.js", textSample: "R2-SAMPLE" }],
      }),
    );
    await markScanArtifactBacked(db, {
      scanId,
      organizationId: owner.organizationId,
      storageVersion: written.storageVersion,
      key: written.key,
      digest: written.digest,
      size: written.size,
    });

    const withR2 = await getScan(db, scanId, owner.organizationId, { artifacts: env.ARTIFACTS });
    expect(withR2?.files.find((f) => f.path === "index.js")?.textSample).toBe("R2-SAMPLE");

    const withoutR2 = await getScan(db, scanId, owner.organizationId);
    expect(withoutR2?.files.find((f) => f.path === "index.js")?.textSample).toBe("D1-SAMPLE");

    // Detail is otherwise identical between the two reads.
    expect(withR2?.scan.id).toBe(withoutR2?.scan.id);
    expect(withR2?.findings.length).toBe(withoutR2?.findings.length);
    expect(withR2?.riskSummary).toEqual(withoutR2?.riskSummary);
  });

  test("falls back to D1 on a digest mismatch", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, { textSample: "D1-SAMPLE" });
    const db = createDb(env.DB);
    const reportPayload = { version: 1 };
    const written = await writeScanArtifact(
      env.ARTIFACTS,
      buildPipelineArtifactBundle({
        scanId,
        organizationId: owner.organizationId,
        reportVersion: 1,
        reportDigest: await sha256Hex(stableJson(reportPayload)),
        reportPayload,
        summary: {},
        fileSamples: [{ path: "index.js", textSample: "R2-SAMPLE" }],
      }),
    );
    // Persist a digest that no longer matches the stored object.
    await markScanArtifactBacked(db, {
      scanId,
      organizationId: owner.organizationId,
      storageVersion: written.storageVersion,
      key: written.key,
      digest: "0".repeat(64),
      size: written.size,
    });

    const scan = await getScan(db, scanId, owner.organizationId, { artifacts: env.ARTIFACTS });
    expect(scan?.files.find((f) => f.path === "index.js")?.textSample).toBe("D1-SAMPLE");
  });

  test("falls back to D1 when the R2 object is missing", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, { textSample: "D1-SAMPLE" });
    const db = createDb(env.DB);
    const reportPayload = { version: 1 };
    const written = await writeScanArtifact(
      env.ARTIFACTS,
      buildPipelineArtifactBundle({
        scanId,
        organizationId: owner.organizationId,
        reportVersion: 1,
        reportDigest: await sha256Hex(stableJson(reportPayload)),
        reportPayload,
        summary: {},
        fileSamples: [{ path: "index.js", textSample: "R2-SAMPLE" }],
      }),
    );
    await markScanArtifactBacked(db, {
      scanId,
      organizationId: owner.organizationId,
      storageVersion: written.storageVersion,
      key: written.key,
      digest: written.digest,
      size: written.size,
    });
    await env.ARTIFACTS.delete(written.key);

    const scan = await getScan(db, scanId, owner.organizationId, { artifacts: env.ARTIFACTS });
    expect(scan?.files.find((f) => f.path === "index.js")?.textSample).toBe("D1-SAMPLE");
  });
});

describe("R2 scan artifact backfill", () => {
  test("artifactBackfillEnabled reads the flag", () => {
    expect(artifactBackfillEnabled(backfillEnv(true))).toBe(true);
    expect(artifactBackfillEnabled(backfillEnv(false))).toBe(false);
    expect(artifactBackfillEnabled({ ARTIFACT_BACKFILL: "ON" } as unknown as Cloudflare.Env)).toBe(
      true,
    );
    expect(artifactBackfillEnabled({ ARTIFACT_BACKFILL: "0" } as unknown as Cloudflare.Env)).toBe(
      false,
    );
  });

  test("does nothing while disabled", async () => {
    const owner = await seedUser();
    await seedCompletedScan(owner);
    const db = createDb(env.DB);
    const result = await runArtifactBackfillSweep(backfillEnv(false), db);
    expect(result).toEqual({ considered: 0, written: 0, failed: 0 });
  });

  test("backfills completed scans in idempotent batches", async () => {
    const db = createDb(env.DB);
    // Drain any candidates left behind by earlier tests so the batch counts
    // below reflect only the three scans this test seeds.
    while (
      (await runArtifactBackfillSweep(backfillEnv(true), db, { batchSize: 100 })).written > 0
    ) {
      // keep sweeping until convergence
    }

    const owner = await seedUser();
    const scanIds = [
      await seedCompletedScan(owner),
      await seedCompletedScan(owner),
      await seedCompletedScan(owner),
    ];

    // First batch of two leaves one candidate behind.
    const first = await runArtifactBackfillSweep(backfillEnv(true), db, { batchSize: 2 });
    expect(first.considered).toBe(2);
    expect(first.written).toBe(2);
    expect(first.failed).toBe(0);

    // Second batch sweeps the remaining one; a third converges to no work.
    const second = await runArtifactBackfillSweep(backfillEnv(true), db, { batchSize: 2 });
    expect(second.written).toBe(1);
    const third = await runArtifactBackfillSweep(backfillEnv(true), db, { batchSize: 2 });
    expect(third.considered).toBe(0);
    expect(third.written).toBe(0);

    for (const scanId of scanIds) {
      const [row] = await db
        .select({
          artifactStorageVersion: schema.scans.artifactStorageVersion,
          artifactKey: schema.scans.artifactKey,
          artifactDigest: schema.scans.artifactDigest,
        })
        .from(schema.scans)
        .where(eq(schema.scans.id, scanId))
        .limit(1);
      expect(row?.artifactStorageVersion).toBe(SCAN_ARTIFACT_STORAGE_VERSION);
      expect(row?.artifactKey).toBe(scanArtifactKey(owner.organizationId, scanId));

      const bundle = await readScanArtifact(env.ARTIFACTS, {
        key: row!.artifactKey!,
        expectedDigest: row!.artifactDigest,
      });
      expect(bundle?.origin).toBe("backfill");
      expect(bundle?.report.payload).toBeNull();
      expect(bundle?.fileSamples).toEqual([{ path: "index.js", textSample: "D1-SAMPLE" }]);
    }
  });
});
