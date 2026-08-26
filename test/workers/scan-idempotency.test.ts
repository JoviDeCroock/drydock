import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import {
  chunkForD1,
  claimScanForRun,
  createScanJob,
  getScan,
  listExistingScanStageIds,
  markScanFailed,
} from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { createPackageDiff } from "../../server/lib/review";
import { persistScanWithArtifacts } from "./helpers/persist-scan";

async function seedUserAndOrg() {
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
  return { db, userId, organizationId };
}

async function readStatus(db: ReturnType<typeof createDb>, scanId: string) {
  const [row] = await db
    .select({ status: schema.scans.status, reportDigest: schema.scans.reportDigest })
    .from(schema.scans)
    .where(eq(schema.scans.id, scanId))
    .limit(1);
  return row;
}

const baseScan = {
  packageJson: { name: "demo", version: "1.0.0" },
  diff: [],
  files: [],
  findings: [],
  ai: null,
  summary: { ok: true },
  report: { version: 1, digest: "digest-1" },
};

describe("scan persistence idempotency", () => {
  test("claimScanForRun transitions pending → running once and refuses terminal rows", async () => {
    const { db, organizationId, userId } = await seedUserAndOrg();
    const scanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(db, {
      id: scanId,
      stageId: "stage-aaaa",
      organizationId,
      ownerUserId: userId,
    });

    expect(await claimScanForRun(db, scanId, organizationId)).toBe(true);
    expect((await readStatus(db, scanId))?.status).toBe("running");

    // Re-claiming a running scan still succeeds (same in-flight execution).
    expect(await claimScanForRun(db, scanId, organizationId)).toBe(true);

    // Complete the scan, then a redelivery must not roll it back to running.
    await persistScanWithArtifacts(db, {
      ...baseScan,
      id: scanId,
      stageId: "stage-aaaa",
      organizationId,
      ownerUserId: userId,
      risk: "low",
      status: "complete",
    });
    expect((await readStatus(db, scanId))?.status).toBe("complete");

    expect(await claimScanForRun(db, scanId, organizationId)).toBe(false);
    expect((await readStatus(db, scanId))?.status).toBe("complete");
  });

  test("markScanFailed refuses to overwrite a completed scan", async () => {
    const { db, organizationId, userId } = await seedUserAndOrg();
    const scanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(db, {
      id: scanId,
      stageId: "stage-bbbb",
      organizationId,
      ownerUserId: userId,
    });
    await claimScanForRun(db, scanId, organizationId);
    await persistScanWithArtifacts(db, {
      ...baseScan,
      id: scanId,
      stageId: "stage-bbbb",
      organizationId,
      ownerUserId: userId,
      risk: "low",
      status: "complete",
    });

    await markScanFailed(db, scanId, organizationId, {
      code: "scan_failed",
      message: "should be ignored",
    });

    const after = await readStatus(db, scanId);
    expect(after?.status).toBe("complete");
  });

  test("persistScan is a no-op when the scan is already terminal", async () => {
    const { db, organizationId, userId } = await seedUserAndOrg();
    const scanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(db, {
      id: scanId,
      stageId: "stage-cccc",
      organizationId,
      ownerUserId: userId,
    });
    await claimScanForRun(db, scanId, organizationId);
    const first = await persistScanWithArtifacts(db, {
      ...baseScan,
      id: scanId,
      stageId: "stage-cccc",
      organizationId,
      ownerUserId: userId,
      risk: "low",
      status: "complete",
    });

    const second = await persistScanWithArtifacts(db, {
      ...baseScan,
      id: scanId,
      stageId: "stage-cccc",
      organizationId,
      ownerUserId: userId,
      risk: "high",
      status: "complete",
      findings: [
        {
          severity: "high",
          file: "index.js",
          evidence: "second attempt",
          reason: "second attempt",
        },
      ],
    });

    expect(second.persisted).toBe(false);
    const final = await readStatus(db, scanId);
    expect(final?.reportDigest).toBe(first.reportDigest);
  });

  test("persistScan preserves Python pattern annotations for extensionless files", async () => {
    const { db, organizationId, userId } = await seedUserAndOrg();
    const scanId = `scan_${crypto.randomUUID()}`;
    const stageId = "stage-python-patterns";
    const previousFiles = [
      {
        path: "scripts/post_install",
        size: 100,
        sha256: "old",
        flags: [],
        textSample:
          "import urllib.request\nurllib.request.urlopen('https://example.invalid/existing')\nvalue = 1\n",
      },
    ];
    const files = [
      {
        path: "scripts/post_install",
        size: 160,
        sha256: "new",
        flags: [],
        textSample:
          "import urllib.request\nurllib.request.urlopen('https://example.invalid/existing')\nvalue = 2\nurllib.request.urlopen('https://example.invalid/new')\n",
      },
    ];
    const diff = createPackageDiff(previousFiles, files);

    await createScanJob(db, {
      id: scanId,
      stageId,
      organizationId,
      ownerUserId: userId,
    });
    await claimScanForRun(db, scanId, organizationId);
    await persistScanWithArtifacts(db, {
      ...baseScan,
      id: scanId,
      stageId,
      organizationId,
      ownerUserId: userId,
      risk: "high",
      status: "complete",
      previousFiles,
      files,
      diff,
      findings: [
        {
          severity: "medium",
          file: "scripts/post_install",
          line: 1,
          evidence: "network-capable code path",
          reason: "new Python network sink was added later in the file",
          ruleId: "code.network-access",
        },
      ],
      codePatternSet: "python",
    });

    const scan = await getScan(db, scanId, organizationId, env.ARTIFACTS);
    expect(scan?.findings[0]).toMatchObject({
      diffStatus: "modified",
      releaseDelta: true,
    });
  });

  test("listExistingScanStageIds only dedupes within the active organization", async () => {
    const ownerA = await seedUserAndOrg();
    const ownerB = await seedUserAndOrg();
    const sharedStageId = `stage-${crypto.randomUUID()}`;
    const inProgressStageId = `stage-${crypto.randomUUID()}`;
    const orgBOnlyStageId = `stage-${crypto.randomUUID()}`;
    const untouchedStageId = `stage-${crypto.randomUUID()}`;

    const completedScanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(ownerA.db, {
      id: completedScanId,
      stageId: sharedStageId,
      organizationId: ownerA.organizationId,
      ownerUserId: ownerA.userId,
    });
    await claimScanForRun(ownerA.db, completedScanId, ownerA.organizationId);
    await persistScanWithArtifacts(ownerA.db, {
      ...baseScan,
      id: completedScanId,
      stageId: sharedStageId,
      organizationId: ownerA.organizationId,
      ownerUserId: ownerA.userId,
      risk: "low",
      status: "complete",
    });

    const inProgressScanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(ownerA.db, {
      id: inProgressScanId,
      stageId: inProgressStageId,
      organizationId: ownerA.organizationId,
      ownerUserId: ownerA.userId,
    });

    const orgBOwnScanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(ownerB.db, {
      id: orgBOwnScanId,
      stageId: orgBOnlyStageId,
      organizationId: ownerB.organizationId,
      ownerUserId: ownerB.userId,
    });

    const known = await listExistingScanStageIds(ownerB.db, ownerB.organizationId, [
      sharedStageId,
      inProgressStageId,
      orgBOnlyStageId,
      untouchedStageId,
    ]);

    expect(known.has(sharedStageId)).toBe(false);
    expect(known.has(orgBOnlyStageId)).toBe(true);
    expect(known.has(inProgressStageId)).toBe(false);
    expect(known.has(untouchedStageId)).toBe(false);
  });

  // Regression: discovery passes every staged publish the registry lists, and
  // D1 caps bound parameters at 100 per query. Before chunking, a sweep of
  // ~100 staged items threw "too many SQL variables" on every cron tick.
  test("listExistingScanStageIds handles more stage ids than D1's parameter cap", async () => {
    const owner = await seedUserAndOrg();
    const knownStageId = `stage-${crypto.randomUUID()}`;
    await createScanJob(owner.db, {
      id: `scan_${crypto.randomUUID()}`,
      stageId: knownStageId,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
    });

    const stageIds = Array.from({ length: 250 }, (_, i) => `stage-bulk-${i}`);
    // Place the known id past the first chunk so the union across chunks is
    // exercised, not just the first query.
    stageIds.splice(180, 0, knownStageId);

    const known = await listExistingScanStageIds(owner.db, owner.organizationId, stageIds);
    expect(known.has(knownStageId)).toBe(true);
    expect(known.size).toBe(1);
  });

  test("chunkForD1 reserves fixed parameters when sizing chunks", () => {
    const rows = Array.from({ length: 250 }, (_, i) => i);
    const chunks = chunkForD1(rows, 1, 2);
    expect(chunks.every((chunk) => chunk.length <= 98)).toBe(true);
    expect(chunks.flat()).toEqual(rows);
    expect(chunkForD1([], 1, 2)).toEqual([]);
  });

  test("cross-organization claims and mutations are rejected", async () => {
    const ownerA = await seedUserAndOrg();
    const ownerB = await seedUserAndOrg();
    const scanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(ownerA.db, {
      id: scanId,
      stageId: "stage-dddd",
      organizationId: ownerA.organizationId,
      ownerUserId: ownerA.userId,
    });

    expect(await claimScanForRun(ownerA.db, scanId, ownerB.organizationId)).toBe(false);
    const [scanRow] = await ownerA.db
      .select()
      .from(schema.scans)
      .where(
        and(eq(schema.scans.id, scanId), eq(schema.scans.organizationId, ownerA.organizationId)),
      )
      .limit(1);
    expect(scanRow.status).toBe("pending");
  });
});
