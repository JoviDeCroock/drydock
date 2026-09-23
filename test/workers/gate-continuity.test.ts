import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { createScanJob, hasLiveReleaseTarget, loadGateReviewHistory } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { evaluateGateContinuity } from "../../server/lib/scan/gate-continuity-record";
import { persistScanWithArtifacts } from "./helpers/persist-scan";
import { type ScanOwner, seedUser } from "./helpers/seed";

const GATED = "a".repeat(64);
const OTHER = "b".repeat(64);

type Ecosystem = "npm" | "pypi";

interface GateTarget {
  installationId: string;
  releaseTargetId: string;
}

async function seedGateTarget(
  owner: ScanOwner,
  input: {
    ecosystem?: Ecosystem | null;
    installationStatus?: "active" | "suspended" | "uninstalled";
    repositoryFullName?: string;
  } = {},
): Promise<GateTarget> {
  const db = createDb(env.DB);
  const now = new Date();
  const installationId = crypto.randomUUID();
  const releaseTargetId = crypto.randomUUID();
  await db.insert(schema.githubAppInstallations).values({
    id: installationId,
    organizationId: owner.organizationId,
    installationId: crypto.randomUUID(),
    accountLogin: "octo",
    accountType: "Organization",
    targetType: "Organization",
    status: input.installationStatus ?? "active",
    installedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.githubReleaseTargets).values({
    id: releaseTargetId,
    organizationId: owner.organizationId,
    installationRowId: installationId,
    ecosystem: input.ecosystem === undefined ? "npm" : input.ecosystem,
    repositoryId: 42,
    repositoryFullName: input.repositoryFullName ?? "octo/pkg",
    environment: "production",
    createdAt: now,
    updatedAt: now,
  });
  return { installationId, releaseTargetId };
}

async function seedGateRow(
  owner: ScanOwner,
  input: {
    decidedAt: Date | null;
    decision?: "approved" | "rejected";
    requestedAt?: Date;
    target?: GateTarget;
  },
) {
  const db = createDb(env.DB);
  const recordedAt = input.decidedAt ?? input.requestedAt ?? new Date();
  const decision = input.decidedAt ? (input.decision ?? "approved") : null;
  const target = input.target ?? (await seedGateTarget(owner));
  const gateId = crypto.randomUUID();
  await db.insert(schema.githubWorkflowGates).values({
    id: gateId,
    organizationId: owner.organizationId,
    installationRowId: target.installationId,
    releaseTargetId: target.releaseTargetId,
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
  return {
    gateId,
    installationId: target.installationId,
    releaseTargetId: target.releaseTargetId,
  };
}

/**
 * A per-package gate scan the way the gate job opens one: the stage id carries
 * the gate id and the ecosystem, and a completed scan's report carries the
 * provenance block. An incomplete scan has neither a report nor a summary.
 */
async function seedGateScan(
  owner: ScanOwner,
  input: {
    version: string;
    sha256: string;
    status?: "complete" | "pending" | "failed";
    gateId?: string;
    name?: string;
    ecosystem?: Ecosystem;
    completedAt?: Date;
  },
) {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const name = input.name ?? "@octo/pkg";
  const ecosystem = input.ecosystem ?? "npm";
  const stageId = `workflow-gate:${input.gateId ?? crypto.randomUUID()}:${ecosystem}:${name}`;
  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    source: "workflow_gate",
    gateId: input.gateId,
    packageName: name,
    stagedVersion: input.version,
  });
  const status = input.status ?? "complete";
  if (status !== "complete") {
    if (status === "failed") {
      await db.update(schema.scans).set({ status }).where(eq(schema.scans.id, scanId));
    }
    return scanId;
  }
  await persistScanWithArtifacts(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    packageJson: { name, version: input.version },
    risk: "low",
    status: "complete",
    summary: {
      stagedPublish: {
        provenance: {
          ecosystem,
          mode: "workflow_gate",
          artifacts: [{ path: "pkg.tgz", kind: "tarball", sha256: input.sha256 }],
        },
      },
      // What the pipeline records for a gate-attested scan: the repository
      // the signed webhook bound, in normalized URL form.
      intentEnvelope: {
        tier: "attested",
        repository: "https://github.com/Octo/Pkg",
        signals: [],
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

function historyOf(owner: ScanOwner, version = "2.0.0", packageName = "@octo/pkg") {
  return loadGateReviewHistory(createDb(env.DB), {
    organizationId: owner.organizationId,
    ecosystem: "npm",
    packageName,
    version,
  });
}

describe("gate review history for gate continuity", () => {
  test("binds a stage to the organization's approved gate review of the same bytes", async () => {
    const owner = await seedUser();
    const decidedAt = new Date("2026-09-01T01:00:00.000Z");
    const { gateId } = await seedGateRow(owner, { decidedAt });
    const gateScanId = await seedGateScan(owner, { version: "2.0.0", sha256: GATED, gateId });

    const history = await historyOf(owner);

    expect(history.packageHasLiveGate).toBe(true);
    expect(evaluateGateContinuity(history, GATED, true)).toEqual({
      status: "matched",
      reason: null,
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
    const owner = await seedUser();
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

    const history = await historyOf(owner);

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

  test("names a stage of a package a live release target gates, when this version never passed", async () => {
    const owner = await seedUser();
    const { gateId } = await seedGateRow(owner, { decidedAt: new Date() });
    await seedGateScan(owner, { version: "1.0.0", sha256: GATED, gateId });

    const history = await historyOf(owner);

    expect(history.forVersion).toEqual([]);
    expect(history.packageHasLiveGate).toBe(true);
    expect(evaluateGateContinuity(history, OTHER)?.status).toBe("ungated");
  });

  test("does not call a stage ungated once nothing live gates the package", async () => {
    const db = createDb(env.DB);
    // Gate history alone is not gating. Each organization gated 1.0.0 once;
    // none of them still has a release target that could gate 2.0.0.
    const deleted = await seedUser();
    const deletedGate = await seedGateRow(deleted, { decidedAt: new Date() });
    await seedGateScan(deleted, { version: "1.0.0", sha256: GATED, gateId: deletedGate.gateId });
    await db
      .delete(schema.githubReleaseTargets)
      .where(eq(schema.githubReleaseTargets.id, deletedGate.releaseTargetId));

    const suspended = await seedUser();
    const suspendedGate = await seedGateRow(suspended, {
      decidedAt: new Date(),
      target: await seedGateTarget(suspended, { installationStatus: "suspended" }),
    });
    await seedGateScan(suspended, {
      version: "1.0.0",
      sha256: GATED,
      gateId: suspendedGate.gateId,
    });

    const repinned = await seedUser();
    const repinnedGate = await seedGateRow(repinned, {
      decidedAt: new Date(),
      target: await seedGateTarget(repinned, { ecosystem: "pypi" }),
    });
    await seedGateScan(repinned, { version: "1.0.0", sha256: GATED, gateId: repinnedGate.gateId });

    const orphan = await seedUser();
    await seedGateScan(orphan, { version: "1.0.0", sha256: GATED });

    for (const owner of [deleted, suspended, repinned, orphan]) {
      const history = await historyOf(owner);
      expect(history.packageHasLiveGate).toBe(false);
      expect(evaluateGateContinuity(history, OTHER, true)).toBeNull();
    }
    // An auto-detect target (no pinned ecosystem) can gate npm, so it counts.
    const auto = await seedUser();
    const autoGate = await seedGateRow(auto, {
      decidedAt: new Date(),
      target: await seedGateTarget(auto, { ecosystem: null }),
    });
    await seedGateScan(auto, { version: "1.0.0", sha256: GATED, gateId: autoGate.gateId });
    expect((await historyOf(auto)).packageHasLiveGate).toBe(true);
  });

  test("keeps gating live across a deleted and recreated release target", async () => {
    // Targets cannot be edited, only deleted and recreated. The delete
    // cascades to the gate rows and unlinks their scans, but the repository
    // the gate attested is still on the scan.
    const db = createDb(env.DB);
    const owner = await seedUser();
    const first = await seedGateRow(owner, { decidedAt: new Date() });
    await seedGateScan(owner, { version: "1.0.0", sha256: GATED, gateId: first.gateId });
    await db
      .delete(schema.githubReleaseTargets)
      .where(eq(schema.githubReleaseTargets.id, first.releaseTargetId));
    expect((await historyOf(owner)).packageHasLiveGate).toBe(false);

    await seedGateTarget(owner);
    const history = await historyOf(owner);
    expect(history.packageHasLiveGate).toBe(true);
    expect(evaluateGateContinuity(history, OTHER, true)?.status).toBe("ungated");

    // A target on a different repository does not gate this package.
    const moved = await seedUser();
    const old = await seedGateRow(moved, { decidedAt: new Date() });
    await seedGateScan(moved, { version: "1.0.0", sha256: GATED, gateId: old.gateId });
    await db
      .delete(schema.githubReleaseTargets)
      .where(eq(schema.githubReleaseTargets.id, old.releaseTargetId));
    await seedGateTarget(moved, { repositoryFullName: "octo/elsewhere" });
    expect((await historyOf(moved)).packageHasLiveGate).toBe(false);
  });

  test("never reads another ecosystem's gate of the same name as this package's history", async () => {
    // PyPI gate scans store the normalized project name in the same column an
    // npm stage is looked up by. A PyPI `@octo/pkg` 2.0.0 — reviewed, in
    // flight, or failed, even with the same digest — says nothing about npm.
    const owner = await seedUser();
    const target = await seedGateTarget(owner, { ecosystem: null });
    const approved = await seedGateRow(owner, { decidedAt: new Date(), target });
    await seedGateScan(owner, {
      version: "2.0.0",
      sha256: GATED,
      gateId: approved.gateId,
      ecosystem: "pypi",
    });
    const running = await seedGateRow(owner, { decidedAt: null, target });
    await seedGateScan(owner, {
      version: "2.0.0",
      sha256: GATED,
      gateId: running.gateId,
      ecosystem: "pypi",
      status: "pending",
    });
    await seedGateScan(owner, {
      version: "2.0.0",
      sha256: GATED,
      ecosystem: "pypi",
      status: "failed",
    });

    const history = await historyOf(owner);

    expect(history).toEqual({
      ecosystem: "npm",
      forVersion: [],
      packageHasLiveGate: false,
      truncated: false,
      versionHasIncompleteGateScan: false,
    });
    expect(evaluateGateContinuity(history, GATED, true)).toBeNull();
    // The same rows are the history of the ecosystem they belong to.
    const pypi = await loadGateReviewHistory(createDb(env.DB), {
      organizationId: owner.organizationId,
      ecosystem: "pypi",
      packageName: "@octo/pkg",
      version: "2.0.0",
    });
    expect(pypi.forVersion).toHaveLength(1);
    expect(pypi.packageHasLiveGate).toBe(true);
    expect(pypi.versionHasIncompleteGateScan).toBe(true);
  });

  test("keeps an incomplete gate scan out of the reviews but records that it exists", async () => {
    const owner = await seedUser();
    await seedGateScan(owner, { version: "2.0.0", sha256: GATED, status: "failed" });
    await seedGateScan(owner, { version: "2.0.0", sha256: GATED, name: "@octo/other" });

    const history = await historyOf(owner);

    // A failed gate scan cannot vouch for or accuse the stage, so it is not a
    // review — but it is still a gate review of this version that a maintainer
    // can decide, so the stage did not go around the gate.
    expect(history).toEqual({
      ecosystem: "npm",
      forVersion: [],
      packageHasLiveGate: false,
      truncated: false,
      versionHasIncompleteGateScan: true,
    });
    expect(evaluateGateContinuity(history, GATED, true)).toMatchObject({
      status: "unverified",
      reason: "gate-review-incomplete",
      review: null,
    });
  });

  test("never lets another organization's gate review vouch for a stage", async () => {
    const gatingOrg = await seedUser();
    const stagingOrg = await seedUser();
    const { gateId } = await seedGateRow(gatingOrg, { decidedAt: new Date() });
    await seedGateScan(gatingOrg, { version: "2.0.0", sha256: GATED, gateId });
    await seedGateScan(gatingOrg, { version: "2.0.0", sha256: GATED, status: "failed" });

    const history = await historyOf(stagingOrg);

    expect(history).toEqual({
      ecosystem: "npm",
      forVersion: [],
      packageHasLiveGate: false,
      truncated: false,
      versionHasIncompleteGateScan: false,
    });
    expect(evaluateGateContinuity(history, GATED, true)).toBeNull();
  });
});

describe("live release target", () => {
  test("is an npm-capable target on an active installation in this organization", async () => {
    const db = createDb(env.DB);
    const none = await seedUser();
    const npm = await seedUser();
    await seedGateTarget(npm);
    const auto = await seedUser();
    await seedGateTarget(auto, { ecosystem: null });
    const pypi = await seedUser();
    await seedGateTarget(pypi, { ecosystem: "pypi" });
    const uninstalled = await seedUser();
    await seedGateTarget(uninstalled, { installationStatus: "uninstalled" });

    expect(await hasLiveReleaseTarget(db, none.organizationId, "npm")).toBe(false);
    expect(await hasLiveReleaseTarget(db, npm.organizationId, "npm")).toBe(true);
    expect(await hasLiveReleaseTarget(db, auto.organizationId, "npm")).toBe(true);
    expect(await hasLiveReleaseTarget(db, pypi.organizationId, "npm")).toBe(false);
    expect(await hasLiveReleaseTarget(db, uninstalled.organizationId, "npm")).toBe(false);
  });
});
