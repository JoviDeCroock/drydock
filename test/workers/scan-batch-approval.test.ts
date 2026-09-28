import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import * as schema from "../../server/db/schema";
import { describeAuditEvent } from "../../server/lib/auth/audit-events";
import { scansRoutes } from "../../server/routes/scans";
import { buildTestApp, call, type TestApp } from "./helpers/app";
import { type ScanOwner, type SeededUser, seedCompletedScan, seedUser } from "./helpers/seed";

const mountScans = (app: TestApp) => app.route("/api/v1/scans", scansRoutes);

const LOW_RISK = {
  artifactRisk: "low",
  releaseRisk: "low",
  contextRisk: "low",
  releaseFindingCount: 0,
  contextFindingCount: 0,
  unknownFindingCount: 0,
  priorApprovedContextFindingCount: 0,
};

// A completed staged review, then whatever columns the case needs on top.
async function seedReview(
  owner: ScanOwner,
  packageName: string,
  columns: Partial<typeof schema.scans.$inferInsert> = {},
): Promise<string> {
  const scanId = await seedCompletedScan(owner, {
    packageJson: { name: packageName, version: "1.0.0" },
  });
  await createDb(env.DB)
    .update(schema.scans)
    .set({ riskSummaryJson: LOW_RISK, ...columns })
    .where(eq(schema.scans.id, scanId));
  return scanId;
}

interface ListBody {
  scans: Array<{ id: string; packageName: string; releaseFindingCount: number }>;
  more: boolean;
}

async function listApprovable(owner: SeededUser): Promise<ListBody> {
  const res = await call(buildTestApp(mountScans, owner), "GET", "/api/v1/scans/batch-approval");
  expect(res.status).toBe(200);
  return (await res.json()) as ListBody;
}

function approve(owner: SeededUser, body: unknown) {
  return call(buildTestApp(mountScans, owner), "POST", "/api/v1/scans/batch-approval", { body });
}

async function readDecision(scanId: string) {
  const [row] = await createDb(env.DB)
    .select({
      decision: schema.scans.decision,
      decisionReason: schema.scans.decisionReason,
      decidedByUserId: schema.scans.decidedByUserId,
    })
    .from(schema.scans)
    .where(eq(schema.scans.id, scanId));
  return row;
}

describe("batch approval of low-risk staged reviews", () => {
  test("lists only undecided low-risk staged reviews a single decision could still act on", async () => {
    const owner = await seedUser();
    const plain = await seedReview(owner, "@batch/plain");
    const lowFindings = await seedReview(owner, "@batch/low-findings", {
      riskSummaryJson: { ...LOW_RISK, releaseFindingCount: 2 },
    });
    const aiClean = await seedReview(owner, "@batch/ai-clean", {
      aiJson: {
        status: "complete",
        releaseAssessment: "nothing_unusual",
        requiresManualReview: false,
      },
    });
    const excluded = await Promise.all([
      seedReview(owner, "@batch/medium", {
        riskSummaryJson: { ...LOW_RISK, releaseRisk: "medium", releaseFindingCount: 1 },
      }),
      seedReview(owner, "@batch/no-breakdown", { riskSummaryJson: null }),
      seedReview(owner, "@batch/no-baseline", {
        summaryJson: { baseline: { comparisonSkipped: "baseline-too-large" } },
      }),
      seedReview(owner, "@batch/ai-recommends-review", {
        aiJson: { status: "complete", releaseAssessment: "review_recommended" },
      }),
      seedReview(owner, "@batch/ai-suspicious", {
        aiJson: { status: "complete", releaseAssessment: "suspicious" },
      }),
      seedReview(owner, "@batch/ai-manual-review", {
        aiJson: {
          status: "complete",
          releaseAssessment: "nothing_unusual",
          requiresManualReview: true,
        },
      }),
      seedReview(owner, "@batch/decided", { decision: "no_publish", decidedAt: new Date() }),
      seedReview(owner, "@batch/superseded", { registryStatusSupersededAt: new Date() }),
      seedReview(owner, "@batch/published", { registryVersionStatus: "published" }),
      seedReview(owner, "@batch/gate", { source: "workflow_gate" }),
      seedReview(owner, "@batch/published-pair", { source: "published" }),
      seedReview(owner, "@batch/failed", { status: "failed" }),
    ]);
    const stranger = await seedUser();
    await seedReview(stranger, "@batch/elsewhere");

    const body = await listApprovable(owner);
    expect(body.scans.map((scan) => scan.id).sort()).toEqual([plain, lowFindings, aiClean].sort());
    expect(body.scans.find((scan) => scan.id === lowFindings)?.releaseFindingCount).toBe(2);
    expect(body.more).toBe(false);
    for (const id of excluded)
      expect((await readDecision(id))?.decision ?? null).not.toBe("publish");
  });

  test("approves the listed reviews with one audit event each and skips the rest", async () => {
    const owner = await seedUser();
    const first = await seedReview(owner, "@batch/first");
    const second = await seedReview(owner, "@batch/second");
    const medium = await seedReview(owner, "@batch/medium", {
      riskSummaryJson: { ...LOW_RISK, releaseRisk: "medium", releaseFindingCount: 1 },
    });
    const stranger = await seedUser();
    const foreign = await seedReview(stranger, "@batch/foreign");

    const res = await approve(owner, {
      scanIds: [first, second, medium, foreign, "scan_missing", first],
      reason: "  monorepo release  ",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      approved: Array<{ id: string; packageName: string }>;
      skipped: string[];
    };
    expect(body.approved.map((row) => row.id).sort()).toEqual([first, second].sort());
    expect(body.skipped.sort()).toEqual([foreign, medium, "scan_missing"].sort());

    for (const id of [first, second]) {
      expect(await readDecision(id)).toEqual({
        decision: "publish",
        decisionReason: "monorepo release",
        decidedByUserId: owner.userId,
      });
    }
    expect((await readDecision(medium))?.decision).toBeNull();
    expect((await readDecision(foreign))?.decision).toBeNull();

    const events = await createDb(env.DB)
      .select()
      .from(schema.scanEvents)
      .where(
        and(
          eq(schema.scanEvents.organizationId, owner.organizationId),
          eq(schema.scanEvents.type, "scan.decided"),
        ),
      );
    expect(events.map((event) => event.scanId).sort()).toEqual([first, second].sort());
    for (const event of events) {
      expect(event.actorUserId).toBe(owner.userId);
      expect(event.metadataJson).toEqual({
        decision: "publish",
        reason: "monorepo release",
        batch: true,
      });
      expect(describeAuditEvent(event.type, event.metadataJson)?.detail).toBe(
        "approved publish in a batch · monorepo release",
      );
    }
    expect((await listApprovable(owner)).scans).toEqual([]);
  });

  test("never overwrites a decision recorded after the list loaded", async () => {
    const owner = await seedUser();
    const scanId = await seedReview(owner, "@batch/raced");
    expect((await listApprovable(owner)).scans.map((scan) => scan.id)).toEqual([scanId]);

    await createDb(env.DB)
      .update(schema.scans)
      .set({ decision: "no_publish", decidedAt: new Date(), decisionReason: "held" })
      .where(eq(schema.scans.id, scanId));

    const res = await approve(owner, { scanIds: [scanId] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approved: [], skipped: [scanId] });
    expect((await readDecision(scanId))?.decision).toBe("no_publish");
  });

  test("rejects malformed requests before touching any review", async () => {
    const owner = await seedUser();
    const scanId = await seedReview(owner, "@batch/untouched");
    const tooMany = Array.from({ length: 51 }, (_, index) => `scan_${index}`);

    for (const body of [
      {},
      { scanIds: [] },
      { scanIds: tooMany },
      { scanIds: [scanId, 42] },
      { scanIds: [""] },
      { scanIds: [scanId], reason: "x".repeat(501) },
    ]) {
      const res = await approve(owner, body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect((await readDecision(scanId))?.decision).toBeNull();
  });
});
