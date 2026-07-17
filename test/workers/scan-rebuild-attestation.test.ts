import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { createScanJob, persistScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { executeRebuildAttestationJob } from "../../server/lib/rebuild-job";
import type { RebuildAttestation, RebuildPlan } from "../../server/lib/rebuild-attestation";
import type { RebuildExecution } from "../../server/lib/rebuild-steps";
import { maybeWriteScanArtifacts } from "../../server/lib/scan-artifacts";
import { sha256Hex, stableJson } from "../../server/lib/stable-json";
import { scansRoutes } from "../../server/routes/scans";
import type { Bindings, Variables } from "../../server/types";

const GIT_HEAD = "c".repeat(40);
const STAGED_SHA1 = "d".repeat(40);
const PKG_SHA256 = "1".repeat(64);
const DIST_SHA256 = "2".repeat(64);

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
    name: "Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, organizationId };
}

function buildTestApp(session: { userId: string }) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId: session.userId });
    await next();
  });
  app.route("/api/v1/scans", scansRoutes);
  return app;
}

async function fetchJson(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  path: string,
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://test.local${path}`, { method: "GET" }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function pendingPlan(): RebuildPlan {
  return {
    repository: "https://github.com/scope/pkg",
    refs: [{ kind: "git-head", value: GIT_HEAD }],
    directory: null,
    packageName: "@scope/pkg",
    version: "2.0.0",
    expectedShasum: STAGED_SHA1,
  };
}

function pendingAttestation(): RebuildAttestation {
  return {
    status: "pending",
    plan: pendingPlan(),
    ref: null,
    toolchain: null,
    comparison: null,
    signals: [],
    completedAt: null,
  };
}

// Seed a completed scan with real R2 artifacts so the rebuild job can load the
// staged file hashes the way production does.
async function seedCompletedScan(
  owner: SeededUser,
  rebuildAttestation: RebuildAttestation | null,
): Promise<string> {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${scanId.slice(-12)}`;
  const files = [
    { path: "package.json", size: 10, sha256: PKG_SHA256, flags: [], textSample: "{}" },
    { path: "dist/index.js", size: 20, sha256: DIST_SHA256, flags: [], textSample: "x" },
  ];
  const diff = [{ path: "dist/index.js", status: "modified", flags: [] }];
  const reportJson = stableJson({ version: 1, scanId, ruleFindings: [] });
  const reportDigest = await sha256Hex(reportJson);
  const artifacts = await maybeWriteScanArtifacts(env.ARTIFACTS, {
    organizationId: owner.organizationId,
    scanId,
    reportJson,
    reportDigest,
    files,
    diff,
    generatedAt: "2026-07-17T00:00:00.000Z",
  });
  expect(artifacts).not.toBeNull();

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
    packageJson: { name: "@scope/pkg", version: "2.0.0" },
    risk: "low",
    status: "complete",
    summary: {
      report: {
        version: 1,
        digest: reportDigest,
        digestAlgorithm: "sha256",
        generatedAt: "2026-07-17T00:00:00.000Z",
        rulesVersion: "1.8.0",
      },
      diff,
      ...(rebuildAttestation ? { rebuildAttestation } : {}),
    },
    ai: null,
    files,
    diff,
    findings: [],
    report: { version: 1, digest: reportDigest },
    artifacts,
  });
  return scanId;
}

function successfulExecution(): RebuildExecution {
  return {
    ok: true,
    ref: { kind: "git-head", value: GIT_HEAD },
    toolchain: { packageManager: "npm@10.9.0", node: "v22.11.0" },
    output: {
      tarballSha1: STAGED_SHA1,
      files: [
        { path: "./package.json", sha256: PKG_SHA256 },
        { path: "./dist/index.js", sha256: DIST_SHA256 },
      ],
    },
    steps: [{ step: "pack", exitCode: 0, durationMs: 10, detail: null }],
  };
}

describe("rebuild attestation job", () => {
  test("resolves a pending plan to byte-identical and persists it for readers", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, pendingAttestation());

    const result = await executeRebuildAttestationJob(
      env,
      { kind: "rebuild_attestation", organizationId: owner.organizationId, scanId },
      undefined,
      { executor: async () => successfulExecution() },
    );
    expect(result?.status).toBe("byte-identical");
    expect(result?.comparison).toMatchObject({
      tarballShasumMatch: true,
      stagedFileCount: 2,
      matchedFileCount: 2,
    });

    const res = await fetchJson(buildTestApp(owner), `/api/v1/scans/${scanId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scan: { summaryJson: { rebuildAttestation?: { status?: string }; report?: unknown } };
    };
    expect(body.scan.summaryJson.rebuildAttestation?.status).toBe("byte-identical");
    // The merge preserved the rest of the summary blob.
    expect(body.scan.summaryJson.report).toBeTruthy();

    const report = await fetchJson(buildTestApp(owner), `/api/v1/scans/${scanId}/report.json`);
    expect(report.status).toBe(200);
    const reportBody = (await report.json()) as { rebuildAttestation: { status: string } | null };
    expect(reportBody.rebuildAttestation?.status).toBe("byte-identical");
  });

  test("a diverged rebuild stays advisory: risk is untouched", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, pendingAttestation());

    const execution = successfulExecution();
    if (execution.ok) {
      execution.output = {
        tarballSha1: "e".repeat(40),
        files: [
          { path: "package.json", sha256: PKG_SHA256 },
          { path: "dist/index.js", sha256: "9".repeat(64) },
        ],
      };
    }
    const result = await executeRebuildAttestationJob(
      env,
      { kind: "rebuild_attestation", organizationId: owner.organizationId, scanId },
      undefined,
      { executor: async () => execution },
    );
    expect(result?.status).toBe("diverged");
    expect(result?.comparison?.divergentPaths).toEqual(["dist/index.js"]);

    const res = await fetchJson(buildTestApp(owner), `/api/v1/scans/${scanId}`);
    const body = (await res.json()) as { scan: { risk: string } };
    expect(body.scan.risk).toBe("low");
  });

  test("reports inconclusive when no rebuild sandbox is configured", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, pendingAttestation());

    // The test environment has no REBUILD_SANDBOX binding and no executor
    // override, which is exactly the deployment-without-containers shape.
    const result = await executeRebuildAttestationJob(env, {
      kind: "rebuild_attestation",
      organizationId: owner.organizationId,
      scanId,
    });
    expect(result?.status).toBe("inconclusive");
    expect(result?.signals[0]).toMatchObject({ kind: "sandbox" });
  });

  test("a failed rebuild persists inconclusive with step evidence", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, pendingAttestation());

    const result = await executeRebuildAttestationJob(
      env,
      { kind: "rebuild_attestation", organizationId: owner.organizationId, scanId },
      undefined,
      {
        executor: async () => ({
          ok: false,
          failure: "build-failed",
          steps: [{ step: "build", exitCode: 1, durationMs: 10, detail: "TS2304" }],
        }),
      },
    );
    expect(result?.status).toBe("inconclusive");
    expect(result?.signals).toEqual([
      { kind: "rebuild", detail: "build-failed" },
      { kind: "step-failed", detail: "build exited 1: TS2304" },
    ]);
  });

  test("skips scans without a pending plan and other organizations' scans", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, null);
    const noPlan = await executeRebuildAttestationJob(
      env,
      { kind: "rebuild_attestation", organizationId: owner.organizationId, scanId },
      undefined,
      { executor: async () => successfulExecution() },
    );
    expect(noPlan).toBeNull();

    const withPlanScanId = await seedCompletedScan(owner, pendingAttestation());
    const stranger = await seedUser();
    const crossOrg = await executeRebuildAttestationJob(
      env,
      {
        kind: "rebuild_attestation",
        organizationId: stranger.organizationId,
        scanId: withPlanScanId,
      },
      undefined,
      { executor: async () => successfulExecution() },
    );
    expect(crossOrg).toBeNull();

    // The cross-org attempt must not have touched the pending record.
    const res = await fetchJson(buildTestApp(owner), `/api/v1/scans/${withPlanScanId}`);
    const body = (await res.json()) as {
      scan: { summaryJson: { rebuildAttestation?: { status?: string } } };
    };
    expect(body.scan.summaryJson.rebuildAttestation?.status).toBe("pending");
  });
});
