import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import {
  createScanJob,
  getScan,
  getScanStatus,
  persistScan,
  recordScanDecision,
} from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { pendingAiReview } from "../../server/lib/ai-review/types";
import {
  applyAiReviewToScan,
  executeAiReviewJob,
  type ApplyAiReviewArgs,
} from "../../server/lib/scan/ai-review-job";
import {
  AI_REVIEW_INPUT_VERSION,
  AI_REVIEW_INPUT_SAMPLE_CHARACTER_LIMIT,
  AI_REVIEW_SAMPLE_OMITTED_FLAG,
  compactAiReviewInputPayload,
  loadAiReviewInput,
  SCAN_FILE_SAMPLE_LIMIT,
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
  reviewerVersion: "test-reviewer-v1",
};

const lowReview = {
  status: "complete" as const,
  risk: "low" as const,
  releaseAssessment: "nothing_unusual" as const,
  summary: "Routine patch.",
  findings: [],
  requiresManualReview: false,
  model: "test-model",
  reviewerVersion: "test-reviewer-v1",
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
  reviewEnv: Cloudflare.Env = env,
): ApplyAiReviewArgs {
  return {
    env: reviewEnv,
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

    // The JSON export's byte-continuity record names the republished bytes, not
    // the superseded ones.
    const summary = detail!.scan.summaryJson as { report?: { digest?: string } };
    expect(summary.report?.digest).toBe(detail!.scan.reportDigest);

    // No duplicate D1 rows for an artifact-backed scan.
    const rows = await db
      .select()
      .from(schema.scanFindings)
      .where(eq(schema.scanFindings.scanId, scanId));
    expect(rows).toHaveLength(0);
  });

  test("refuses to patch a scan that is not artifact-backed", async () => {
    const owner = await seedUser();
    const { db, scanId, reportDigest } = await seedPendingScan(owner, { artifactBacked: false });
    const scan = await getScanStatus(db, scanId, owner.organizationId);

    const outcome = await applyAiReviewToScan(applyArgs(owner, scan!, criticalReview));

    // `scans.report_digest` covers a payload that embeds the AI review envelope.
    // A D1-backed scan has no report object to republish, so recording the review
    // would leave the digest permanently disagreeing with what the row
    // reconstructs to, and the artifact backfill would refuse the row forever.
    // The review is dropped on the fail-safe path rather than half-recorded.
    expect(outcome).toEqual({ outcome: "patched", status: "unavailable" });

    const rows = await db
      .select()
      .from(schema.scanFindings)
      .where(eq(schema.scanFindings.scanId, scanId));
    expect(rows.filter((row) => row.source === "ai")).toHaveLength(0);

    const detail = await getScan(db, scanId, owner.organizationId, env.ARTIFACTS);
    expect(detail?.scan.aiStatus).toBe("unavailable");
    expect(detail?.scan.findingCount).toBe(1);
    expect(detail?.scan.reportDigest).toBe(reportDigest);
    // Fail-safe floor, not a downgrade.
    expect(detail?.scan.risk).toBe("medium");
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
    const { db, scanId } = await seedPendingScan(owner);
    const scan = await getScanStatus(db, scanId, owner.organizationId);

    await applyAiReviewToScan(applyArgs(owner, scan!, criticalReview));
    const patched = await getScanStatus(db, scanId, owner.organizationId);
    // Same stale row, as a duplicated queue delivery would carry.
    const second = await applyAiReviewToScan(applyArgs(owner, scan!, criticalReview));
    expect(second).toEqual({ outcome: "skipped", reason: "not_pending" });

    const updated = await getScanStatus(db, scanId, owner.organizationId);
    expect(updated?.findingCount).toBe(2);
    expect(updated?.updatedAt).toEqual(patched?.updatedAt);
    const detail = await getScan(db, scanId, owner.organizationId, env.ARTIFACTS);
    expect(detail?.findings.filter((finding) => finding.source === "ai")).toHaveLength(1);
  });

  test("a duplicate delivery with identical output cannot delete the live report", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedPendingScan(owner);
    const scan = await getScanStatus(db, scanId, owner.organizationId);

    // Two deliveries of the same message that produce the same review — the
    // killswitch-off sentinel, the final-attempt fail-safe, and an AI Gateway
    // cache hit all do this. Identical bytes hash to identical keys, so the
    // loser's cleanup is pointed straight at the winner's live objects.
    const first = await applyAiReviewToScan(applyArgs(owner, scan!, criticalReview));
    expect(first.outcome).toBe("patched");
    const second = await applyAiReviewToScan(applyArgs(owner, scan!, criticalReview));
    expect(second).toEqual({ outcome: "skipped", reason: "not_pending" });

    const detail = await getScan(db, scanId, owner.organizationId, env.ARTIFACTS);
    expect(detail?.scan.reportArtifactKey).toMatch(/\/report\.[0-9a-f]{16}\.json$/);
    // Still there, still verifying: a compacted scan has no D1 copy of this.
    expect(await env.ARTIFACTS.get(detail!.scan.reportArtifactKey!)).not.toBeNull();
    expect(await env.ARTIFACTS.get(detail!.scan.artifactManifestKey!)).not.toBeNull();
    expect(detail?.findings.map((finding) => finding.source)).toEqual(["rule", "ai"]);
    expect(detail?.files.map((file) => file.path)).toEqual(["index.js", "setup.js"]);
  });

  test("a duplicate delivery with different output reclaims only its own revision", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedPendingScan(owner);
    const scan = await getScanStatus(db, scanId, owner.organizationId);

    await applyAiReviewToScan(applyArgs(owner, scan!, criticalReview));
    const live = (await getScanStatus(db, scanId, owner.organizationId))!;
    // A different review hashes to different keys, so the loser's revision is
    // genuinely unreferenced and is reclaimed.
    const loser = await applyAiReviewToScan(applyArgs(owner, scan!, lowReview));
    expect(loser).toEqual({ outcome: "skipped", reason: "not_pending" });

    const after = (await getScanStatus(db, scanId, owner.organizationId))!;
    expect(after.reportArtifactKey).toBe(live.reportArtifactKey);
    expect(await env.ARTIFACTS.get(after.reportArtifactKey!)).not.toBeNull();
    const listed = await env.ARTIFACTS.list({ prefix: `${keyPrefix(owner, scanId)}/report.` });
    const revisions = listed.objects
      .map((object) => object.key)
      .filter((key) => /\/report\.[0-9a-f]{16}\.json$/.test(key));
    expect(revisions).toEqual([after.reportArtifactKey]);
  });

  test("a lost patch deletes its revision when the scan row was removed", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedPendingScan(owner);
    const scan = await getScanStatus(db, scanId, owner.organizationId);

    // Model the organization-delete race after the worker captured a pending
    // row but before it republishes and claims the terminal review.
    await db.delete(schema.scans).where(eq(schema.scans.id, scanId));
    const outcome = await applyAiReviewToScan(applyArgs(owner, scan!, criticalReview));
    expect(outcome).toEqual({ outcome: "skipped", reason: "not_pending" });

    const listed = await env.ARTIFACTS.list({ prefix: keyPrefix(owner, scanId) });
    const orphanRevisions = listed.objects
      .map((object) => object.key)
      .filter((key) => /\/(?:report|manifest)\.[0-9a-f]{16}\.json$/.test(key));
    expect(orphanRevisions).toEqual([]);
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

  test("bounds deferred text samples while retaining both sides of selected paths", async () => {
    const scanId = `scan_${crypto.randomUUID()}`;
    const largeText = "x".repeat(SCAN_FILE_SAMPLE_LIMIT + 1);
    const paths = ["index.js", ...Array.from({ length: 15 }, (_, index) => `lib/${index}.js`)];
    const original = evidenceFor(scanId);
    original.files = paths.map((path, index) => ({
      path,
      size: largeText.length,
      sha256: `staged-${index}`,
      flags: [],
      textSample: largeText,
    }));
    original.previousFiles = paths.map((path, index) => ({
      path,
      size: largeText.length,
      sha256: `previous-${index}`,
      flags: [],
      textSample: largeText,
    }));
    original.diff = paths.map((path) => ({ path, status: "modified", flags: [] }));

    const compacted = compactAiReviewInputPayload(original);
    const retainedCharacters = [...compacted.files, ...compacted.previousFiles].reduce(
      (total, file) => total + (file.textSample?.length ?? 0),
      0,
    );
    expect(retainedCharacters).toBeLessThanOrEqual(AI_REVIEW_INPUT_SAMPLE_CHARACTER_LIMIT);
    expect(compacted.files.find((file) => file.path === "index.js")?.textSample).toHaveLength(
      SCAN_FILE_SAMPLE_LIMIT,
    );
    expect(compacted.previousFiles.find((file) => file.path === "index.js")?.flags).toContain(
      "truncated",
    );

    const omittedPath = paths.find(
      (path) => !compacted.files.find((file) => file.path === path)?.textSample,
    );
    expect(omittedPath).toBeDefined();
    for (const side of [compacted.files, compacted.previousFiles]) {
      const omitted = side.find((file) => file.path === omittedPath);
      expect(omitted).toMatchObject({
        path: omittedPath,
        flags: expect.arrayContaining([AI_REVIEW_SAMPLE_OMITTED_FLAG]),
      });
      expect(omitted).not.toHaveProperty("textSample");
    }
  });

  test("emits reviewer feedback when the maintainer decided while AI was pending", async () => {
    const owner = await seedUser();
    const { db, scanId } = await seedPendingScan(owner);
    const points: AnalyticsEngineDataPoint[] = [];
    const analyticsEnv = {
      ...env,
      PRODUCT_ANALYTICS: {
        writeDataPoint: (point: AnalyticsEngineDataPoint) => points.push(point),
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
    expect(points.map((point) => point.indexes?.[0])).toEqual(["scan.decided"]);

    const pending = await getScanStatus(db, scanId, owner.organizationId);
    await applyAiReviewToScan(applyArgs(owner, pending!, criticalReview, analyticsEnv));

    expect(points.map((point) => point.indexes?.[0])).toEqual([
      "scan.decided",
      "ai_review.decided",
    ]);
    expect(points[1]?.blobs).toEqual([
      "1",
      "ai_review.decided",
      owner.organizationId,
      "npm",
      "publish",
      "complete",
      "suspicious",
      "test-model",
      "test-reviewer-v1",
    ]);
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
    expect(detail?.scan.aiStartedAt).not.toBeNull();
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

  test("retries rather than dropping the review when the scan row is not complete yet", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const scanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(db, {
      id: scanId,
      stageId: `stage-${scanId.slice(-12)}`,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
    });

    // A redelivery that arrives before the deterministic write is visible must
    // come back, not silently drop the advisory review.
    await expect(executeAiReviewJob(env, messageFor(scanId, owner), db)).rejects.toThrow(
      /not yet complete/,
    );
    expect(
      await executeAiReviewJob(env, messageFor(scanId, owner), db, { finalAttempt: true }),
    ).toEqual({ outcome: "skipped", reason: "scan_not_complete" });
  });

  test("a lost evidence snapshot closes the review at the manual-review floor", async () => {
    const owner = await seedUser();
    const { db, scanId, aiReviewInput, reportDigest } = await seedPendingScan(owner, {
      artifactBacked: true,
    });
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
    expect(detail?.scan.reportDigest).not.toBe(reportDigest);
    expect(detail?.scan.reportArtifactKey).toMatch(/\/report\.[0-9a-f]{16}\.json$/);
    const republished = await env.ARTIFACTS.get(detail!.scan.reportArtifactKey!);
    const report = JSON.parse(await republished!.text()) as Record<string, unknown>;
    expect((report.aiFindings as { status: string }).status).toBe("unavailable");
    expect((report.risk as { artifactRisk: string }).artifactRisk).toBe("medium");
    const summary = detail!.scan.summaryJson as { report?: { digest?: string } };
    expect(summary.report?.digest).toBe(detail!.scan.reportDigest);
  });
});

function keyPrefix(owner: SeededUser, scanId: string): string {
  const segment = (value: string) => encodeURIComponent(value).replace(/%/g, "~");
  return `orgs/${segment(owner.organizationId)}/scans/${segment(scanId)}/v1`;
}
