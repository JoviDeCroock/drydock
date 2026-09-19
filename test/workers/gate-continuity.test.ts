import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { createScanJob, loadGateReviewHistory } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { evaluateGateContinuity } from "../../server/lib/scan/gate-continuity-record";
import { persistScanWithArtifacts } from "./helpers/persist-scan";

interface Owner {
  userId: string;
  organizationId: string;
}

const GATED = "a".repeat(64);
const OTHER = "b".repeat(64);

async function seedOwner(): Promise<Owner> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Continuity tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  return { userId, organizationId: (await ensurePersonalOrganization(db, { userId }))! };
}

async function seedGateRow(
  owner: Owner,
  input: {
    decidedAt: Date | null;
    decision?: "approved" | "rejected";
    requestedAt?: Date;
    target?: { installationId: string; releaseTargetId: string };
  },
) {
  const db = createDb(env.DB);
  const recordedAt = input.decidedAt ?? input.requestedAt ?? new Date();
  const decision = input.decidedAt ? (input.decision ?? "approved") : null;
  const installationId = input.target?.installationId ?? crypto.randomUUID();
  const releaseTargetId = input.target?.releaseTargetId ?? crypto.randomUUID();
  const gateId = crypto.randomUUID();
  if (!input.target) {
    await db.insert(schema.githubAppInstallations).values({
      id: installationId,
      organizationId: owner.organizationId,
      installationId: crypto.randomUUID(),
      accountLogin: "octo",
      accountType: "Organization",
      targetType: "Organization",
      status: "active",
      installedAt: recordedAt,
      createdAt: recordedAt,
      updatedAt: recordedAt,
    });
    await db.insert(schema.githubReleaseTargets).values({
      id: releaseTargetId,
      organizationId: owner.organizationId,
      installationRowId: installationId,
      ecosystem: "npm",
      repositoryId: 42,
      repositoryFullName: "octo/pkg",
      environment: "production",
      createdAt: recordedAt,
      updatedAt: recordedAt,
    });
  }
  await db.insert(schema.githubWorkflowGates).values({
    id: gateId,
    organizationId: owner.organizationId,
    installationRowId: installationId,
    releaseTargetId,
    deliveryId: crypto.randomUUID(),
    repositoryId: 42,
    repositoryFullName: "octo/pkg",
    environment: "production",
    runId: 4242,
    deploymentId: 1,
    deploymentCallbackUrl:
      "https://api.github.com/repos/octo/pkg/actions/runs/4242/deployment_protection_rule",
    eventAction: "requested",
    status: decision ?? "pending",
    decision,
    decidedAt: input.decidedAt,
    requestedAt: recordedAt,
    createdAt: recordedAt,
    updatedAt: recordedAt,
  });
  return { gateId, installationId, releaseTargetId };
}

async function seedGateScan(
  owner: Owner,
  input: {
    version: string;
    sha256: string;
    status?: string;
    gateId?: string;
    name?: string;
    completedAt?: Date;
  },
) {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `gate_${crypto.randomUUID()}`;
  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    source: "workflow_gate",
    gateId: input.gateId,
  });
  await persistScanWithArtifacts(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    packageJson: { name: input.name ?? "@octo/pkg", version: input.version },
    risk: "low",
    status: input.status ?? "complete",
    summary: {
      stagedPublish: {
        provenance: {
          ecosystem: "npm",
          mode: "workflow_gate",
          artifacts: [{ path: "pkg.tgz", kind: "tarball", sha256: input.sha256 }],
        },
      },
    },
    ai: null,
    files: [],
    diff: [],
    findings: [],
  });
  if (input.completedAt) {
    await db
      .update(schema.scans)
      .set({ completedAt: input.completedAt })
      .where(eq(schema.scans.id, scanId));
  }
  return scanId;
}

describe("gate review history for gate continuity", () => {
  test("binds a stage to the organization's approved gate review of the same bytes", async () => {
    const owner = await seedOwner();
    const decidedAt = new Date("2026-09-01T01:00:00.000Z");
    const { gateId } = await seedGateRow(owner, { decidedAt });
    const gateScanId = await seedGateScan(owner, { version: "2.0.0", sha256: GATED, gateId });

    const history = await loadGateReviewHistory(createDb(env.DB), {
      organizationId: owner.organizationId,
      packageName: "@octo/pkg",
      version: "2.0.0",
    });

    expect(history.packageHasGateHistory).toBe(true);
    expect(evaluateGateContinuity(history, GATED)).toEqual({
      status: "matched",
      algorithm: "sha256",
      stagedDigest: GATED,
      review: {
        scanId: gateScanId,
        gateId,
        repository: "octo/pkg",
        environment: "production",
        runId: 4242,
        status: "approved",
        decision: "approved",
        decidedAt: decidedAt.toISOString(),
        sha256: GATED,
      },
    });
  });

  test("orders same-byte reviews by decision time rather than scan completion", async () => {
    const owner = await seedOwner();
    const rejectedGate = await seedGateRow(owner, {
      decidedAt: new Date("2026-09-03T00:00:00.000Z"),
      decision: "rejected",
    });
    const rejectedScanId = await seedGateScan(owner, {
      version: "2.0.0",
      sha256: GATED,
      gateId: rejectedGate.gateId,
      completedAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    const approvedGate = await seedGateRow(owner, {
      decidedAt: new Date("2026-09-02T00:00:00.000Z"),
      target: rejectedGate,
    });
    const approvedScanId = await seedGateScan(owner, {
      version: "2.0.0",
      sha256: GATED,
      gateId: approvedGate.gateId,
      completedAt: new Date("2026-09-04T00:00:00.000Z"),
    });
    const pendingGate = await seedGateRow(owner, {
      decidedAt: null,
      requestedAt: new Date("2026-09-05T00:00:00.000Z"),
      target: rejectedGate,
    });
    const pendingScanId = await seedGateScan(owner, {
      version: "2.0.0",
      sha256: GATED,
      gateId: pendingGate.gateId,
      completedAt: new Date("2026-09-05T00:00:00.000Z"),
    });

    const history = await loadGateReviewHistory(createDb(env.DB), {
      organizationId: owner.organizationId,
      packageName: "@octo/pkg",
      version: "2.0.0",
    });

    expect(history.forVersion.map((row) => row.scanId)).toEqual([
      rejectedScanId,
      approvedScanId,
      pendingScanId,
    ]);
    expect(evaluateGateContinuity(history, GATED)).toMatchObject({
      status: "gate-not-approved",
      review: { scanId: rejectedScanId, decision: "rejected" },
    });
  });

  test("names a stage of a gated package whose version never passed the gate", async () => {
    const owner = await seedOwner();
    await seedGateScan(owner, { version: "1.0.0", sha256: GATED });

    const history = await loadGateReviewHistory(createDb(env.DB), {
      organizationId: owner.organizationId,
      packageName: "@octo/pkg",
      version: "2.0.0",
    });

    expect(history.forVersion).toEqual([]);
    expect(evaluateGateContinuity(history, OTHER)?.status).toBe("ungated");
  });

  test("ignores incomplete gate scans and other packages", async () => {
    const owner = await seedOwner();
    await seedGateScan(owner, { version: "2.0.0", sha256: GATED, status: "failed" });
    await seedGateScan(owner, { version: "2.0.0", sha256: GATED, name: "@octo/other" });

    const history = await loadGateReviewHistory(createDb(env.DB), {
      organizationId: owner.organizationId,
      packageName: "@octo/pkg",
      version: "2.0.0",
    });

    expect(history).toEqual({ forVersion: [], packageHasGateHistory: false });
  });

  test("never lets another organization's gate review vouch for a stage", async () => {
    const gatingOrg = await seedOwner();
    const stagingOrg = await seedOwner();
    await seedGateScan(gatingOrg, { version: "2.0.0", sha256: GATED });

    const history = await loadGateReviewHistory(createDb(env.DB), {
      organizationId: stagingOrg.organizationId,
      packageName: "@octo/pkg",
      version: "2.0.0",
    });

    expect(history).toEqual({ forVersion: [], packageHasGateHistory: false });
    expect(evaluateGateContinuity(history, GATED)).toBeNull();
  });
});
