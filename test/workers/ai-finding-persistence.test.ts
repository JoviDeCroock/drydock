import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { getPriorApprovedScanFindings } from "../../server/db/release-memory";
import { createScanJob, getScan, persistScan, recordScanDecision } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { buildReportExport } from "../../server/lib/scan/report-export";
import { writeScanArtifacts } from "../../server/lib/scan/artifacts";
import { sha256Hex } from "../../server/lib/platform/crypto-utils";
import { stableJson } from "../../server/lib/platform/stable-json";
import type { Finding } from "../../server/lib/review";

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
    name: "AI Finding Persistence Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, organizationId };
}

const ruleFinding: Finding = {
  severity: "medium",
  file: "index.js",
  evidence: "fetch(url)",
  reason: "network access on a changed line",
  line: 3,
  ruleId: "code.network-access",
  ruleVersion: "1.15.0",
};

const aiFindingRecord: Finding = {
  severity: "critical",
  file: "setup.js",
  evidence: "child_process.exec(atob(payload))",
  reason: "decodes and executes a staged payload during install",
  // Resolved from the submitted anchor, so an AI finding pins to its hunk in
  // the workbench exactly like a deterministic one.
  line: 1,
};

const completeAiReview = {
  status: "complete",
  risk: "critical",
  releaseAssessment: "suspicious",
  summary: "Install-time payload execution added in this release.",
  findings: [
    {
      severity: "critical",
      file: "setup.js",
      evidence: "child_process.exec(atob(payload))",
      reason: "decodes and executes a staged payload during install",
      recommendation: "block the release",
      line: 1,
    },
  ],
  comments: [{ file: "index.js", note: "Unrelated fetch, unchanged since 0.1.0.", line: 1 }],
  requiresManualReview: true,
  model: "test-model",
  reviewerVersion: "1.0.0",
};

const files = [
  { path: "index.js", size: 10, sha256: "a", flags: [], textSample: "fetch(url)" },
  { path: "setup.js", size: 20, sha256: "b", flags: [], textSample: "exec(atob(payload))" },
];
const diff = [
  { path: "index.js", status: "modified" as const, flags: [] },
  { path: "setup.js", status: "added" as const, flags: [] },
];

describe("AI finding persistence (D1 degraded path)", () => {
  test("writes source 'ai' rows after rule rows and counts them", async () => {
    const owner = await seedUser();
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
      packageJson: { name: "alleviate", version: "0.2.0" },
      risk: "critical",
      status: "complete",
      summary: { diff },
      ai: completeAiReview,
      files,
      diff,
      findings: [ruleFinding],
      aiFindingRecords: [aiFindingRecord],
      report: { version: 1, digest: `digest-${scanId}` },
    });

    const rows = await db
      .select()
      .from(schema.scanFindings)
      .where(eq(schema.scanFindings.scanId, scanId));
    expect(rows).toHaveLength(2);
    const aiRow = rows.find((row) => row.source === "ai");
    expect(aiRow).toMatchObject({
      severity: "critical",
      file: "setup.js",
      evidence: "child_process.exec(atob(payload))",
      line: 1,
      ruleId: null,
      ruleVersion: null,
    });

    const [scanRow] = await db.select().from(schema.scans).where(eq(schema.scans.id, scanId));
    expect(scanRow.findingCount).toBe(2);

    const detail = await getScan(db, scanId, owner.organizationId);
    expect(detail).not.toBeNull();
    const aiDetail = detail!.findings.find((finding) => finding.source === "ai");
    // The AI finding lands on an added file, so it annotates as release delta
    // and counts into the release bucket of the recomputed risk summary.
    expect(aiDetail).toMatchObject({ diffStatus: "added", releaseDelta: true });
    expect(detail!.riskSummary?.releaseFindingCount).toBe(2);

    // The persisted per-row annotations cover the AI row too.
    const annotations = (detail!.scan.summaryJson as { findingAnnotations: Array<{ id: string }> })
      .findingAnnotations;
    expect(annotations.map((annotation) => annotation.id)).toContain(aiRow!.id);

    // The report export keeps findings[] deterministic-only (AI findings are
    // carried by aiReview.findings), so they are never double-counted across the
    // two fields and every findings[] entry keeps a ruleId.
    const exported = buildReportExport(detail!);
    expect(exported.findings.every((finding) => finding.source === "rule")).toBe(true);
    expect(exported.findings).toHaveLength(1);
    expect(exported.aiReview?.findings.map((finding) => finding.file)).toEqual(["setup.js"]);
  });

  test("does not record reviewer feedback for a disabled-review placeholder", async () => {
    const owner = await seedUser();
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
      packageJson: { name: "alleviate", version: "0.2.0" },
      risk: "medium",
      status: "complete",
      summary: { diff },
      ai: {
        status: "unavailable",
        risk: "low",
        releaseAssessment: "not_assessed",
        summary: "AI review is disabled.",
        findings: [],
        requiresManualReview: false,
        model: null,
        reviewerVersion: null,
      },
      files,
      diff,
      findings: [ruleFinding],
      aiFindingRecords: [],
      report: { version: 1, digest: `digest-${scanId}` },
    });

    const productPoints: AnalyticsEngineDataPoint[] = [];
    await recordScanDecision(
      db,
      {
        scanId,
        organizationId: owner.organizationId,
        actorUserId: owner.userId,
        decision: "publish",
      },
      undefined,
      {
        ...env,
        PRODUCT_ANALYTICS: {
          writeDataPoint: (point: AnalyticsEngineDataPoint) => productPoints.push(point),
        },
      } as Cloudflare.Env,
    );

    expect(productPoints.map((point) => point.indexes?.[0])).toEqual(["scan.decided"]);
  });
});

describe("AI finding persistence (R2 artifact path)", () => {
  async function seedArtifactBackedScan(owner: SeededUser) {
    const db = createDb(env.DB);
    const scanId = `scan_${crypto.randomUUID()}`;
    const stageId = `stage-${scanId.slice(-12)}`;
    const reportPayload = {
      version: 1,
      stageId,
      ruleFindings: [ruleFinding],
      // Combined index space: rule findings first, AI findings after them.
      findingAnnotations: [
        { findingIndex: 0, diffStatus: "modified", releaseDelta: true },
        { findingIndex: 1, diffStatus: "added", releaseDelta: true },
      ],
      aiFindings: completeAiReview,
    };
    const reportJson = stableJson(reportPayload);
    const reportDigest = await sha256Hex(reportJson);
    const artifacts = await writeScanArtifacts(env.ARTIFACTS, {
      organizationId: owner.organizationId,
      scanId,
      reportJson,
      reportDigest,
      files,
      diff,
      generatedAt: "2026-07-17T00:00:00.000Z",
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
      packageJson: { name: "alleviate", version: "0.2.0" },
      risk: "critical",
      status: "complete",
      summary: {},
      ai: completeAiReview,
      files,
      diff,
      findings: [ruleFinding],
      aiFindingRecords: [aiFindingRecord],
      report: { version: 1, digest: reportDigest },
      artifacts,
    });
    return { db, scanId };
  }

  test("derives source 'ai' rows from the report artifact", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedArtifactBackedScan(owner);

    // Artifact-backed persist writes no D1 finding rows at all.
    const d1Rows = await db
      .select()
      .from(schema.scanFindings)
      .where(eq(schema.scanFindings.scanId, scanId));
    expect(d1Rows).toEqual([]);
    const [scanRow] = await db.select().from(schema.scans).where(eq(schema.scans.id, scanId));
    expect(scanRow.findingCount).toBe(2);

    const detail = await getScan(db, scanId, owner.organizationId, env.ARTIFACTS);
    expect(detail).not.toBeNull();
    expect(detail!.findings).toHaveLength(2);
    expect(detail!.findings.map((finding) => finding.source)).toEqual(["rule", "ai"]);
    // The combined-index report annotations reach the AI row.
    const aiDetail = detail!.findings.find((finding) => finding.source === "ai");
    expect(aiDetail).toMatchObject({
      severity: "critical",
      file: "setup.js",
      // Same line the D1 path persists: both stores project the review through
      // projectAiReviewFindings, so a pinned finding survives either store.
      line: 1,
      diffStatus: "added",
      releaseDelta: true,
    });
  });

  test("release memory profiles exclude AI rows from artifact-backed priors", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedArtifactBackedScan(owner);
    const productPoints: AnalyticsEngineDataPoint[] = [];
    const analyticsEnv = {
      ...env,
      PRODUCT_ANALYTICS: {
        writeDataPoint: (point: AnalyticsEngineDataPoint) => productPoints.push(point),
      },
    } as Cloudflare.Env;
    await recordScanDecision(
      db,
      {
        scanId,
        organizationId: owner.organizationId,
        actorUserId: owner.userId,
        decision: "publish",
      },
      env.ARTIFACTS,
      analyticsEnv,
    );

    expect(productPoints.map((point) => point.indexes?.[0])).toEqual([
      "scan.decided",
      "ai_review.decided",
    ]);
    expect(productPoints[1].blobs).toEqual([
      "1",
      "ai_review.decided",
      owner.organizationId,
      "npm",
      "publish",
      "complete",
      "suspicious",
      "test-model",
      "1.0.0",
    ]);

    const prior = await getPriorApprovedScanFindings(
      db,
      {
        organizationId: owner.organizationId,
        packageName: "alleviate",
        excludeScanId: "scan_current",
      },
      env.ARTIFACTS,
    );
    expect(prior?.scanId).toBe(scanId);
    // Only the deterministic finding enters the profile; the advisory AI row
    // must not make every subsequent clean release read as "diverged".
    expect(prior?.findings).toEqual([
      { ruleId: "code.network-access", severity: "medium", file: "index.js" },
    ]);
  });
});
