import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { createScanJob, getScan, persistScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { writeScanArtifacts } from "../../server/lib/scan/artifacts";
import { buildReportExport } from "../../server/lib/scan/report-export";
import { compactSummaryDiff, fullSummaryDiff } from "../../server/lib/scan/summary-diff";
import { sha256Hex } from "../../server/lib/platform/crypto-utils";
import { stableJson } from "../../server/lib/platform/stable-json";
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
    name: "Summary Diff Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, organizationId };
}

// One changed file plus two unchanged ones: the shape the compaction exists for.
const files: FileRecord[] = [
  { path: "index.js", size: 40, sha256: "a".repeat(64), flags: [], textSample: "let a = 2;\n" },
  { path: "README.md", size: 12, sha256: "b".repeat(64), flags: [], textSample: "# pkg\n" },
  { path: "LICENSE", size: 11, sha256: "c".repeat(64), flags: [], textSample: "MIT\n" },
];

const fileDiff: DiffEntry[] = [
  {
    path: "index.js",
    status: "modified",
    previousSize: 20,
    stagedSize: 40,
    previousSha256: "d".repeat(64),
    stagedSha256: "a".repeat(64),
    flags: [],
  },
  {
    path: "README.md",
    status: "unchanged",
    previousSize: 12,
    stagedSize: 12,
    previousSha256: "b".repeat(64),
    stagedSha256: "b".repeat(64),
    flags: [],
  },
  {
    path: "LICENSE",
    status: "unchanged",
    previousSize: 11,
    stagedSize: 11,
    previousSha256: "c".repeat(64),
    stagedSha256: "c".repeat(64),
    flags: [],
  },
];

const ruleFinding: Finding = {
  severity: "medium",
  file: "index.js",
  evidence: "fetch('https://example.com')",
  reason: "network access",
  line: 1,
  ruleId: "code.network-access",
  ruleVersion: "1.8.0",
};

const reportSummary = {
  report: {
    version: 1,
    digestAlgorithm: "sha256",
    generatedAt: "2026-07-20T00:00:00.000Z",
    rulesVersion: "1.8.0",
  },
  baseline: { kind: "registry", version: "1.0.0" },
  safety: { outboundPolicy: "gateway-only" },
  packageJsonDiff: { name: "pkg", scripts: [], dependencies: [], entrypointsChanged: false },
};

/**
 * Seed an artifact-backed scan the way the pipeline now does: the full diff to
 * R2 (report.json + diff.json), the compacted release delta into summary_json.
 */
async function seedCompactedScan(owner: SeededUser) {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${scanId.slice(-12)}`;
  const reportJson = stableJson({
    version: 1,
    stageId,
    diff: fileDiff,
    ruleFindings: [ruleFinding],
    findingAnnotations: [{ findingIndex: 0, diffStatus: "modified", releaseDelta: true }],
  });
  const reportDigest = await sha256Hex(reportJson);
  const artifacts = await writeScanArtifacts(env.ARTIFACTS, {
    organizationId: owner.organizationId,
    scanId,
    reportJson,
    reportDigest,
    files,
    diff: fileDiff,
    generatedAt: "2026-07-20T00:00:00.000Z",
  });
  const summaryDiff = compactSummaryDiff(fileDiff);
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
    packageJson: { name: "pkg", version: "1.1.0" },
    risk: "medium",
    status: "complete",
    summary: { ...reportSummary, diff: summaryDiff.diff, diffStats: summaryDiff.diffStats },
    ai: null,
    files,
    diff: fileDiff,
    findings: [ruleFinding],
    report: { version: 1, digest: reportDigest },
    artifacts,
  });
  return { db, scanId };
}

/** Seed a pre-compaction row: the whole diff embedded, no diffStats, D1 detail. */
async function seedLegacyShapeScan(owner: SeededUser) {
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
    packageJson: { name: "pkg", version: "1.1.0" },
    risk: "medium",
    status: "complete",
    // The historical shape: `diff` is the complete array and there is no
    // `diffStats` sibling at all.
    summary: {
      ...reportSummary,
      report: { ...reportSummary.report, digest: "old" },
      diff: fileDiff,
    },
    ai: null,
    files,
    diff: fileDiff,
    findings: [ruleFinding],
    report: { version: 1, digest: `digest-${scanId}` },
  });
  return { db, scanId };
}

describe("summary_json diff compaction", () => {
  test("the persisted embed carries only the release delta, R2 keeps the full diff", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedCompactedScan(owner);

    const [row] = await db.select().from(schema.scans).where(eq(schema.scans.id, scanId));
    const summary = row.summaryJson as { diff: DiffEntry[]; diffStats: { totalCount: number } };
    expect(summary.diff.map((entry) => entry.path)).toEqual(["index.js"]);
    expect(summary.diffStats).toMatchObject({ compacted: true, totalCount: 3, changedCount: 1 });

    // The complete diff still reaches every reader, from R2.
    const detail = await getScan(db, scanId, owner.organizationId, env.ARTIFACTS);
    expect(detail!.diff?.map((entry) => entry.path)).toEqual(["index.js", "README.md", "LICENSE"]);
    expect(detail!.diff?.[0]?.stagedSha256).toBe("a".repeat(64));
  });

  test("the scan-detail read the dashboard uses carries the complete diff", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedCompactedScan(owner);

    // GET /api/v1/scans/:id passes files: "list", which takes the
    // metadata-only artifact path rather than the full one. The workbench renders
    // its diff from this response, so the complete diff has to arrive here too.
    const detail = await getScan(db, scanId, owner.organizationId, env.ARTIFACTS, {
      files: "list",
    });
    expect(detail!.diff).toEqual(fileDiff);
    expect(detail!.files.every((file) => file.textSample === null)).toBe(true);
  });

  test("an artifact-backed row does not embed per-row finding annotations", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedCompactedScan(owner);

    const [row] = await db.select().from(schema.scans).where(eq(schema.scans.id, scanId));
    // The annotations are keyed by scan_findings.id, and those rows are never
    // written for an artifact-backed scan — they would match nothing. The read
    // path re-derives them from report.json by index instead.
    expect(row.summaryJson).not.toHaveProperty("findingAnnotations");
    const detail = await getScan(db, scanId, owner.organizationId, env.ARTIFACTS);
    expect(detail!.findings[0]).toMatchObject({ diffStatus: "modified", releaseDelta: true });
  });

  test("the degraded path still embeds annotations, because its reader joins on them", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedLegacyShapeScan(owner);

    const [row] = await db.select().from(schema.scans).where(eq(schema.scans.id, scanId));
    const annotations = (row.summaryJson as { findingAnnotations: Array<{ id: string }> })
      .findingAnnotations;
    const findingRows = await db
      .select()
      .from(schema.scanFindings)
      .where(eq(schema.scanFindings.scanId, scanId));
    expect(annotations.map((annotation) => annotation.id)).toEqual([findingRows[0].id]);
  });

  test("the R2-fallback read still renders a diff from the compacted embed", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedCompactedScan(owner);

    // No bucket: exactly what a failed/disabled artifact read degrades to. The
    // detail row carries no diff of its own, so readers fall back to the embed —
    // which is why the embed is compacted rather than dropped.
    const detail = await getScan(db, scanId, owner.organizationId, undefined);
    expect(detail!.diff).toBeNull();
    const summary = detail!.scan.summaryJson as { diff: DiffEntry[] };
    expect(summary.diff).toEqual([
      { path: "index.js", status: "modified", previousSize: 20, stagedSize: 40, flags: [] },
    ]);
    // And the export falls back to the same embed rather than exporting nothing.
    const exported = buildReportExport(detail!);
    expect(exported.diff).toEqual(summary.diff);
    // The export is the attested subject, so the fallback has to disclose that
    // the diff it carries is not the release's complete file list.
    expect(exported.diffStats).toEqual({
      complete: false,
      entryCount: 1,
      totalCount: fileDiff.length,
      changedCount: 1,
      counts: { added: 0, removed: 0, modified: 1, unchanged: 2 },
    });
  });

  test("the export prefers the complete artifact diff over the compacted embed", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedCompactedScan(owner);

    const detail = await getScan(db, scanId, owner.organizationId, env.ARTIFACTS);
    const exported = buildReportExport(detail!);
    expect(exported.diff).toEqual(fileDiff);
    // The embed is compacted, but the diff being exported is R2's complete one.
    expect(exported.diffStats).toMatchObject({
      complete: true,
      entryCount: fileDiff.length,
      totalCount: fileDiff.length,
      changedCount: 1,
    });
  });

  test("old-shape rows keep parsing: the full embed is read, annotated, and exported", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedLegacyShapeScan(owner);

    const detail = await getScan(db, scanId, owner.organizationId, env.ARTIFACTS);
    // Legacy rows are not artifact-backed, so there is no artifact diff...
    expect(detail!.diff).toBeNull();
    // ...and their untouched full embed is what every reader still sees.
    const exported = buildReportExport(detail!);
    expect(exported.diff).toEqual(fileDiff);
    // No persisted stats on a legacy row: the embed is the whole diff, so the
    // counts come off the exported entries and the export is still complete.
    expect(exported.diffStats).toEqual({
      complete: true,
      entryCount: fileDiff.length,
      totalCount: fileDiff.length,
      changedCount: 1,
      counts: { added: 0, removed: 0, modified: 1, unchanged: 2 },
    });
    expect(detail!.findings[0]).toMatchObject({ diffStatus: "modified", releaseDelta: true });
    expect(detail!.files.map((file) => file.path).sort()).toEqual([
      "LICENSE",
      "README.md",
      "index.js",
    ]);
  });

  test("fullSummaryDiff is what a degraded row embeds, byte-for-byte", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedLegacyShapeScan(owner);
    const [row] = await db.select().from(schema.scans).where(eq(schema.scans.id, scanId));
    const summary = row.summaryJson as { diff: DiffEntry[] };
    expect(summary.diff).toEqual(fullSummaryDiff(fileDiff).diff);
  });
});
