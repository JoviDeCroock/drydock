import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { createScanJob, getScan, getScanStatus, persistScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { pendingAiReview } from "../../server/lib/ai-review/types";
import {
  applyAiReviewToScan,
  executeAiReviewJob,
  type ApplyAiReviewArgs,
} from "../../server/lib/scan/ai-review-job";
import {
  AI_REVIEW_INPUT_VERSION,
  loadAiReviewInput,
  writeAiReviewInput,
  writeScanArtifacts,
  type AiReviewInputPayload,
} from "../../server/lib/scan/artifacts";
import { sha256Hex, stableJson } from "../../server/lib/platform/stable-json";
import { DETERMINISTIC_RULES_VERSION, type Finding } from "../../server/lib/review";
import type { AiReviewQueueMessage } from "../../server/lib/scan/job-messages";

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
    name: "Deferred AI Review Tester",
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

const annotatedRuleFinding = {
  ...ruleFinding,
  diffStatus: "modified" as const,
  releaseDelta: true,
};

const files = [
  { path: "index.js", size: 10, sha256: "a", flags: [], textSample: "fetch(url)" },
  { path: "setup.js", size: 20, sha256: "b", flags: [], textSample: "exec(atob(payload))" },
];
const previousFiles = [
  { path: "index.js", size: 9, sha256: "a0", flags: [], textSample: "noop()" },
];
const diff = [
  { path: "index.js", status: "modified" as const, flags: [] },
  { path: "setup.js", status: "added" as const, flags: [] },
];
const packageJsonDiff = {
  scripts: [],
  dependencies: [],
  entrypointsChanged: false,
  fields: [],
} as unknown as AiReviewInputPayload["packageJsonDiff"];

const criticalReview = {
  status: "complete" as const,
  risk: "critical" as const,
  releaseAssessment: "suspicious" as const,
  summary: "Install-time payload execution added in this release.",
  findings: [
    {
      severity: "critical" as const,
      file: "setup.js",
      evidence: "child_process.exec(atob(payload))",
      reason: "decodes and executes a staged payload during install",
      recommendation: "block the release",
    },
  ],
  requiresManualReview: true,
  model: "test-model",
};

const lowReview = {
  status: "complete" as const,
  risk: "low" as const,
  releaseAssessment: "nothing_unusual" as const,
  summary: "Routine patch.",
  findings: [],
  requiresManualReview: false,
  model: "test-model",
};

function evidenceFor(scanId: string): AiReviewInputPayload {
  return {
    version: AI_REVIEW_INPUT_VERSION,
    scanId,
    stageId: `stage-${scanId.slice(-8)}`,
    ecosystem: "npm",
    codePatternSet: "javascript",
    previousVersionAvailable: true,
    baselineComparisonSkipped: false,
    files,
    previousFiles,
    diff,
    packageJsonDiff,
    releaseRuleFindings: [ruleFinding],
    annotatedFindings: [annotatedRuleFinding],
    releaseConsistency: { status: "none", priorScanId: null },
  };
}

/**
 * Persist a scan exactly the way the deterministic half of the pipeline does when
 * the AI review is deferred: complete, reviewable, deterministic risk only, and
 * `ai_json.status = "pending"`.
 */
async function seedPendingScan(
  owner: SeededUser,
  options: { artifactBacked: boolean; risk?: string } = { artifactBacked: true },
) {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${scanId.slice(-12)}`;
  const risk = options.risk ?? "medium";
  const riskSummary = {
    artifactRisk: risk,
    releaseRisk: risk,
    contextRisk: "low",
    releaseFindingCount: 1,
    contextFindingCount: 0,
    unknownFindingCount: 0,
    priorApprovedContextFindingCount: 0,
  } as const;
  const reportPayload = {
    version: 1,
    rulesVersion: DETERMINISTIC_RULES_VERSION,
    stageId,
    stagedPublish: null,
    package: { name: "alleviate", stagedVersion: "0.2.0" },
    baseline: { version: "0.1.0", tag: null, source: "semver", distTagVersion: null, reason: "ok" },
    fileCount: files.length,
    previousFileCount: previousFiles.length,
    packageJson: { name: "alleviate", version: "0.2.0" },
    packageJsonDiff,
    diff,
    ruleFindings: [ruleFinding],
    findingAnnotations: [{ findingIndex: 0, diffStatus: "modified", releaseDelta: true }],
    aiFindings: pendingAiReview(),
    risk: riskSummary,
    releaseConsistency: { status: "none", priorScanId: null },
    safety: null,
  };
  const reportJson = stableJson(reportPayload);
  const reportDigest = await sha256Hex(reportJson);

  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
  });

  const artifacts = options.artifactBacked
    ? await writeScanArtifacts(env.ARTIFACTS, {
        organizationId: owner.organizationId,
        scanId,
        reportJson,
        reportDigest,
        files,
        diff,
        generatedAt: "2026-07-31T00:00:00.000Z",
      })
    : null;
  const aiReviewInput = await writeAiReviewInput(
    env.ARTIFACTS,
    owner.organizationId,
    evidenceFor(scanId),
  );

  await persistScan(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    packageJson: { name: "alleviate", version: "0.2.0" },
    risk,
    status: "complete",
    summary: {
      report: {
        version: 1,
        digest: reportDigest,
        digestAlgorithm: "sha256",
        generatedAt: "2026-07-31T00:00:00.000Z",
        rulesVersion: DETERMINISTIC_RULES_VERSION,
      },
      packageJsonDiff,
      diff,
      risk: riskSummary,
      baseline: reportPayload.baseline,
      releaseConsistency: reportPayload.releaseConsistency,
      aiReviewInput,
    },
    ai: pendingAiReview(),
    files,
    previousFiles,
    diff,
    findings: [ruleFinding],
    codePatternSet: "javascript",
    riskSummary,
    report: { version: 1, digest: reportDigest },
    artifacts,
  });

  return { db, scanId, stageId, reportDigest, aiReviewInput };
}

function messageFor(scanId: string, owner: SeededUser): AiReviewQueueMessage {
  return {
    kind: "ai_review",
    scanId,
    stageId: `stage-${scanId.slice(-12)}`,
    organizationId: owner.organizationId,
    ecosystem: "npm",
  };
}

function applyArgs(
  owner: SeededUser,
  scan: NonNullable<Awaited<ReturnType<typeof getScanStatus>>>,
  review: ApplyAiReviewArgs["review"],
): ApplyAiReviewArgs {
  return {
    env,
    db: createDb(env.DB),
    scan,
    message: messageFor(scan.id, owner),
    review,
    evidence: evidenceFor(scan.id),
  };
}

describe("deferred AI review", () => {
  test("the deterministic report is complete and readable while the review is pending", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedPendingScan(owner);

    const detail = await getScan(db, scanId, owner.organizationId, env.ARTIFACTS);
    expect(detail?.scan.status).toBe("complete");
    expect(detail?.scan.aiStatus).toBe("pending");
    // The deterministic evidence is all there: the report does not wait on AI.
    expect(detail?.findings.map((finding) => finding.ruleId)).toEqual(["code.network-access"]);
    expect(detail?.files.map((file) => file.path)).toEqual(["index.js", "setup.js"]);
    // Pending contributes nothing to risk — not a downgrade, and not the
    // medium floor a *failed* review would apply.
    expect(detail?.scan.risk).toBe("medium");
    expect(detail?.riskSummary?.artifactRisk).toBe("medium");
    expect(detail?.scan.findingCount).toBe(1);
  });

  test("patching an artifact-backed scan adds the AI finding and escalates risk", async () => {
    const owner = await seedUser();
    const { db, scanId, reportDigest } = await seedPendingScan(owner);
    const scan = await getScanStatus(db, scanId, owner.organizationId);

    const outcome = await applyAiReviewToScan(applyArgs(owner, scan!, criticalReview));
    expect(outcome).toEqual({ outcome: "patched", status: "complete" });

    const detail = await getScan(db, scanId, owner.organizationId, env.ARTIFACTS);
    expect(detail?.scan.aiStatus).toBe("complete");
    expect(detail?.scan.risk).toBe("critical");
    expect(detail?.riskSummary?.artifactRisk).toBe("critical");
    expect(detail?.riskSummary?.releaseRisk).toBe("critical");
    expect(detail?.scan.findingCount).toBe(2);

    // Rule row first, AI row second — the order both stores agree on.
    expect(detail?.findings.map((finding) => finding.source)).toEqual(["rule", "ai"]);
    const aiFinding = detail?.findings.find((finding) => finding.source === "ai");
    expect(aiFinding).toMatchObject({
      severity: "critical",
      file: "setup.js",
      ruleId: null,
      releaseDelta: true,
    });

    // The report artifact was republished under a new content-addressed key and
    // D1 points at it, so the digest check on the read path still passes.
    expect(detail?.scan.reportDigest).not.toBe(reportDigest);
    expect(detail?.scan.reportArtifactKey).toMatch(/\/report\.[0-9a-f]{16}\.json$/);
    const republished = await env.ARTIFACTS.get(detail!.scan.reportArtifactKey!);
    const report = JSON.parse(await republished!.text()) as Record<string, unknown>;
    expect((report.aiFindings as { status: string }).status).toBe("complete");
    expect((report.risk as { artifactRisk: string }).artifactRisk).toBe("critical");
    expect(report.findingAnnotations).toHaveLength(2);
    // The pre-AI report is left untouched, which is what makes the swap atomic.
    expect(await env.ARTIFACTS.get(`${keyPrefix(owner, scanId)}/report.json`)).not.toBeNull();

    // No duplicate D1 rows for an artifact-backed scan.
    const rows = await db
      .select()
      .from(schema.scanFindings)
      .where(eq(schema.scanFindings.scanId, scanId));
    expect(rows).toHaveLength(0);
  });

  test("patching a D1-backed (degraded) scan writes the AI finding as a row", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedPendingScan(owner, { artifactBacked: false });
    const scan = await getScanStatus(db, scanId, owner.organizationId);

    await applyAiReviewToScan(applyArgs(owner, scan!, criticalReview));

    const rows = await db
      .select()
      .from(schema.scanFindings)
      .where(eq(schema.scanFindings.scanId, scanId));
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.source === "ai")).toHaveLength(1);

    const detail = await getScan(db, scanId, owner.organizationId, env.ARTIFACTS);
    expect(detail?.scan.aiStatus).toBe("complete");
    expect(detail?.scan.risk).toBe("critical");
    expect(detail?.scan.findingCount).toBe(2);
    const aiFinding = detail?.findings.find((finding) => finding.source === "ai");
    expect(aiFinding).toMatchObject({ file: "setup.js", severity: "critical" });
    // The row's annotation was persisted with it rather than being re-derived
    // from a read that has no baseline files.
    expect(aiFinding?.releaseDelta).toBe(true);
  });

  test("a clean AI review never lowers the persisted deterministic grade", async () => {
    const owner = await seedUser();
    // Persisted `high` against evidence that rescores to `medium`: the patch
    // must floor at what the scan already showed rather than trusting its own
    // recomputation to agree.
    const { db, scanId } = await seedPendingScan(owner, { artifactBacked: true, risk: "high" });
    const scan = await getScanStatus(db, scanId, owner.organizationId);

    await applyAiReviewToScan(applyArgs(owner, scan!, lowReview));

    const detail = await getScan(db, scanId, owner.organizationId, env.ARTIFACTS);
    expect(detail?.scan.risk).toBe("high");
    expect(detail?.riskSummary?.artifactRisk).toBe("high");
    expect(detail?.scan.aiStatus).toBe("complete");
    expect(detail?.scan.findingCount).toBe(1);
  });

  test("a replayed follow-up cannot patch the same scan twice", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedPendingScan(owner, { artifactBacked: false });
    const scan = await getScanStatus(db, scanId, owner.organizationId);

    await applyAiReviewToScan(applyArgs(owner, scan!, criticalReview));
    // Same stale row, as a duplicated queue delivery would carry.
    const second = await applyAiReviewToScan(applyArgs(owner, scan!, criticalReview));
    expect(second).toEqual({ outcome: "skipped", reason: "not_pending" });

    const rows = await db
      .select()
      .from(schema.scanFindings)
      .where(eq(schema.scanFindings.scanId, scanId));
    expect(rows.filter((row) => row.source === "ai")).toHaveLength(1);
    const updated = await getScanStatus(db, scanId, owner.organizationId);
    expect(updated?.findingCount).toBe(2);
  });

  test("the evidence snapshot round-trips and is deleted once the review lands", async () => {
    const owner = await seedUser();
    const { db, scanId, aiReviewInput } = await seedPendingScan(owner);

    const loaded = await loadAiReviewInput(env.ARTIFACTS, scanId, aiReviewInput);
    expect(loaded?.files).toHaveLength(2);
    expect(loaded?.previousFiles).toHaveLength(1);
    expect(loaded?.annotatedFindings[0]?.releaseDelta).toBe(true);

    // A digest that does not match the bytes is rejected rather than trusted.
    await expect(
      loadAiReviewInput(env.ARTIFACTS, scanId, { ...aiReviewInput, digest: "0".repeat(64) }),
    ).rejects.toThrow(/digest mismatch/);

    const scan = await getScanStatus(db, scanId, owner.organizationId);
    await applyAiReviewToScan(applyArgs(owner, scan!, criticalReview));

    expect(await env.ARTIFACTS.get(aiReviewInput.key)).toBeNull();
    const summary = (await getScanStatus(db, scanId, owner.organizationId))?.summaryJson as Record<
      string,
      unknown
    >;
    expect(summary.aiReviewInput).toBeUndefined();
  });

  test("executeAiReviewJob honors the ai-review killswitch without running a review", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedPendingScan(owner, { artifactBacked: true });
    const flagged = {
      ...env,
      FLAGS: { getBooleanValue: async () => false },
    } as unknown as Cloudflare.Env;

    const outcome = await executeAiReviewJob(flagged, messageFor(scanId, owner), db, {
      finalAttempt: true,
    });
    expect(outcome).toEqual({ outcome: "patched", status: "unavailable" });

    const detail = await getScan(db, scanId, owner.organizationId, env.ARTIFACTS);
    expect(detail?.scan.aiStatus).toBe("unavailable");
    expect((detail!.scan.aiJson as { model: string | null }).model).toBeNull();
    // A disabled reviewer is neutral: no findings, and no medium floor — the
    // grade stays the deterministic one.
    expect(detail?.scan.risk).toBe("medium");
    expect(detail?.scan.findingCount).toBe(1);
  });

  test("executeAiReviewJob skips a scan that is no longer pending", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedPendingScan(owner, { artifactBacked: false });
    const scan = await getScanStatus(db, scanId, owner.organizationId);
    await applyAiReviewToScan(applyArgs(owner, scan!, criticalReview));

    const outcome = await executeAiReviewJob(env, messageFor(scanId, owner), db, {
      finalAttempt: true,
    });
    expect(outcome).toEqual({ outcome: "skipped", reason: "not_pending" });
  });

  test("a lost evidence snapshot closes the review at the manual-review floor", async () => {
    const owner = await seedUser();
    const { db, scanId, aiReviewInput } = await seedPendingScan(owner, { artifactBacked: true });
    await env.ARTIFACTS.delete(aiReviewInput.key);

    const outcome = await executeAiReviewJob(env, messageFor(scanId, owner), db, {
      finalAttempt: true,
    });
    expect(outcome).toEqual({ outcome: "patched", status: "unavailable" });

    const detail = await getScan(db, scanId, owner.organizationId, env.ARTIFACTS);
    expect(detail?.scan.aiStatus).toBe("unavailable");
    // A review that was scheduled and never ran floors the scan at medium, the
    // same fail-safe an inline reviewer crash gets.
    expect(detail?.scan.risk).toBe("medium");
    expect(detail?.riskSummary?.releaseRisk).toBe("medium");
    expect(detail?.scan.findingCount).toBe(1);
  });
});

function keyPrefix(owner: SeededUser, scanId: string): string {
  const segment = (value: string) => encodeURIComponent(value).replace(/%/g, "~");
  return `orgs/${segment(owner.organizationId)}/scans/${segment(scanId)}/v1`;
}
