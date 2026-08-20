import { env } from "cloudflare:test";
import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { getPriorApprovedScanFindings } from "../../server/db/release-memory";
import { createScanJob, getScan, persistScan, recordScanDecision } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { writeScanArtifacts } from "../../server/lib/scan/artifacts";
import { sha256Hex, stableJson } from "../../server/lib/platform/stable-json";
import type { DiffEntry, FileRecord, Finding } from "../../server/lib/review";

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
    name: "Profile Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, organizationId };
}

const files: FileRecord[] = [
  { path: "index.js", size: 20, sha256: "a".repeat(64), flags: [], textSample: "let a = 1;\n" },
];
const diff: DiffEntry[] = [
  { path: "index.js", status: "modified", stagedSize: 20, stagedSha256: "a".repeat(64), flags: [] },
];

function finding(ruleId: string, file: string, severity: Finding["severity"] = "high"): Finding {
  return {
    severity,
    file,
    evidence: `${ruleId} evidence`,
    reason: `${ruleId} reason`,
    line: 1,
    ruleId,
    ruleVersion: "1.8.0",
  };
}

const AI_FINDING: Finding = {
  severity: "critical",
  file: "setup.js",
  evidence: "advisory only",
  reason: "advisory only",
};

async function seedApprovedScan(
  owner: SeededUser,
  options: { findings: Finding[]; aiFindingRecords?: Finding[]; artifactBacked?: boolean },
) {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${scanId.slice(-12)}`;
  const reportJson = stableJson({
    version: 1,
    stageId,
    diff,
    ruleFindings: options.findings,
    findingAnnotations: options.findings.map((_unused, index) => ({
      findingIndex: index,
      diffStatus: "modified",
      releaseDelta: true,
    })),
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
          generatedAt: "2026-07-20T00:00:00.000Z",
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
    packageJson: { name: "tape", version: "5.7.4" },
    risk: "high",
    status: "complete",
    summary: {},
    ai: null,
    files,
    diff,
    findings: options.findings,
    ...(options.aiFindingRecords ? { aiFindingRecords: options.aiFindingRecords } : {}),
    report: { version: 1, digest: reportDigest },
    ...(artifacts ? { artifacts } : {}),
  });
  await recordScanDecision(db, {
    scanId,
    organizationId: owner.organizationId,
    actorUserId: owner.userId,
    decision: "publish",
  });
  return { db, scanId };
}

function lookup(db: ReturnType<typeof createDb>, owner: SeededUser, bucket?: R2Bucket) {
  return getPriorApprovedScanFindings(
    db,
    {
      organizationId: owner.organizationId,
      packageName: "tape",
      excludeScanId: "scan_current",
    },
    bucket,
  );
}

describe("release-memory finding profile column", () => {
  test("persistScan records the canonically-ordered deterministic profile", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedApprovedScan(owner, {
      // Deliberately out of profile order, and with a duplicate: the profile is a
      // multiset, so the duplicate has to survive.
      findings: [
        finding("code.network-access", "z.js", "medium"),
        finding("code.child-process", "test/spawn.js"),
        finding("code.child-process", "test/spawn.js"),
      ],
    });

    const [row] = await db.select().from(schema.scans).where(eq(schema.scans.id, scanId));
    expect(row.findingProfileJson).toEqual({
      version: 1,
      findings: [
        { ruleId: "code.child-process", severity: "high", file: "test/spawn.js" },
        { ruleId: "code.child-process", severity: "high", file: "test/spawn.js" },
        { ruleId: "code.network-access", severity: "medium", file: "z.js" },
      ],
    });

    // The profile is an internal lookup cache. Scan detail already returns the
    // complete findings, so exposing this blob would duplicate up to 256 KiB on
    // every workbench and decision response.
    const detail = await getScan(db, scanId, owner.organizationId, env.ARTIFACTS, {
      files: "list",
    });
    expect(detail?.scan).not.toHaveProperty("findingProfileJson");
  });

  test("the lookup reads the column and needs no artifact bucket at all", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedApprovedScan(owner, {
      findings: [finding("code.child-process", "test/spawn.js")],
    });

    // Same call that used to download + digest-verify report.json + files.json +
    // diff.json just to project three fields out of them.
    const prior = await lookup(db, owner);
    expect(prior?.scanId).toBe(scanId);
    expect(prior?.stagedVersion).toBe("5.7.4");
    expect(prior?.findings).toEqual([
      { ruleId: "code.child-process", severity: "high", file: "test/spawn.js" },
    ]);
  });

  test("the profile excludes the advisory AI rows", async () => {
    const owner = await seedUser();
    const { db } = await seedApprovedScan(owner, {
      findings: [finding("code.child-process", "test/spawn.js")],
      aiFindingRecords: [AI_FINDING],
    });

    const prior = await lookup(db, owner);
    // An AI row in the profile would make every subsequent clean release read as
    // "diverged" off non-deterministic output.
    expect(prior?.findings).toEqual([
      { ruleId: "code.child-process", severity: "high", file: "test/spawn.js" },
    ]);
  });

  test("a clean scan records an empty profile, and it is trusted as empty", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedApprovedScan(owner, { findings: [] });

    const [row] = await db.select().from(schema.scans).where(eq(schema.scans.id, scanId));
    expect(row.findingProfileJson).toEqual({ version: 1, findings: [] });
    const prior = await lookup(db, owner);
    expect(prior?.scanId).toBe(scanId);
    expect(prior?.findings).toEqual([]);
  });

  test("legacy rows without the column fall back to the artifact projection", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedApprovedScan(owner, {
      findings: [finding("code.child-process", "test/spawn.js")],
    });
    await db
      .update(schema.scans)
      .set({ findingProfileJson: null })
      .where(eq(schema.scans.id, scanId));

    const prior = await lookup(db, owner, env.ARTIFACTS);
    expect(prior?.scanId).toBe(scanId);
    expect(prior?.findings).toEqual([
      { ruleId: "code.child-process", severity: "high", file: "test/spawn.js" },
    ]);
    // And the pre-existing fail-closed rule still holds for those rows: an
    // artifact-backed prior with no readable report reports nothing rather than a
    // fabricated empty profile.
    expect(await lookup(db, owner)).toBeNull();
  });

  test("legacy degraded rows still fall back to the D1 finding rows", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedApprovedScan(owner, {
      findings: [finding("code.network-access", "index.js", "medium")],
      artifactBacked: false,
    });
    await db
      .update(schema.scans)
      .set({ findingProfileJson: null })
      .where(eq(schema.scans.id, scanId));

    const prior = await lookup(db, owner);
    expect(prior?.findings).toEqual([
      { ruleId: "code.network-access", severity: "medium", file: "index.js" },
    ]);
  });

  test("an oversized profile is not stored, and the artifact path serves it", async () => {
    const owner = await seedUser();
    // Above FINDING_PROFILE_MAX_ENTRIES. Storing a truncated profile would be
    // indistinguishable from a genuinely smaller one, so the column stays null
    // and the (correct, complete) artifact projection is used instead.
    const many = Array.from({ length: 2001 }, (_unused, index) =>
      finding("code.network-access", `src/file-${index}.js`, "medium"),
    );
    const { db, scanId } = await seedApprovedScan(owner, { findings: many });

    const [row] = await db.select().from(schema.scans).where(eq(schema.scans.id, scanId));
    expect(row.findingProfileJson).toBeNull();

    const prior = await lookup(db, owner, env.ARTIFACTS);
    expect(prior?.scanId).toBe(scanId);
    expect(prior?.findings).toHaveLength(2001);
  });

  test("a byte-heavy profile falls back before it can exceed the D1 row budget", async () => {
    const owner = await seedUser();
    // Well below the entry cap, but multibyte paths make the serialized profile
    // larger than its safe share of D1's 2 MB row limit.
    const many = Array.from({ length: 200 }, (_unused, index) =>
      finding("file.native-artifact", `${"界".repeat(500)}-${index}`, "high"),
    );
    const { db, scanId } = await seedApprovedScan(owner, { findings: many });

    const [row] = await db.select().from(schema.scans).where(eq(schema.scans.id, scanId));
    expect(row.findingProfileJson).toBeNull();

    const prior = await lookup(db, owner, env.ARTIFACTS);
    expect(prior?.scanId).toBe(scanId);
    expect(prior?.findings).toHaveLength(many.length);
  });

  test("a malformed stored profile falls back rather than reporting an empty one", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedApprovedScan(owner, {
      findings: [finding("code.child-process", "test/spawn.js")],
    });
    await db
      .update(schema.scans)
      .set({ findingProfileJson: { version: 99, findings: "nope" } })
      .where(eq(schema.scans.id, scanId));

    const prior = await lookup(db, owner, env.ARTIFACTS);
    expect(prior?.findings).toEqual([
      { ruleId: "code.child-process", severity: "high", file: "test/spawn.js" },
    ]);
  });

  test("the prior-approved lookup is served by the composite index", async () => {
    const db = createDb(env.DB);
    const plan = await db.all<{ detail: string }>(sql`
      explain query plan
      select id from scans
      where organization_id = 'org' and package_name = 'tape'
        and status = 'complete' and decision = 'publish' and id != 'x'
      order by created_at desc, id desc
      limit 1
    `);
    const detail = plan.map((row) => row.detail).join(" | ");
    // Without package_name in an index this planned as a scan over every decided
    // scan in the organization — once per scan, for every package.
    expect(detail).toContain("scans_org_package_decision_created_idx");
  });
});
