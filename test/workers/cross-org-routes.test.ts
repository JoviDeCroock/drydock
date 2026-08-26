import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { createScanJob } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { scansRoutes } from "../../server/routes/scans";
import type { Bindings, Variables } from "../../server/types";
import { persistScanWithArtifacts } from "./helpers/persist-scan";

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

async function seedCompletedScan(owner: SeededUser, packageName: string) {
  return seedCompletedScanWithStage(owner, packageName, undefined);
}

async function seedCompletedScanWithStage(
  owner: SeededUser,
  packageName: string,
  stageIdOverride?: string,
) {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = stageIdOverride ?? `stage-${scanId.slice(-12)}`;
  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
  });
  await persistScanWithArtifacts(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    packageJson: { name: packageName, version: "1.2.3" },
    risk: "low",
    status: "complete",
    summary: { ok: true },
    ai: null,
    files: [],
    diff: [],
    findings: [],
    report: { version: 1, digest: "digest" },
  });
  return scanId;
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

async function fetchWithSession(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  path: string,
) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://test.local${path}`, { method: "GET" }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("scans routes enforce organization boundaries", () => {
  test("GET /scans only lists scans owned by the caller's organization", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const scanId = await seedCompletedScan(owner, "@org/owned-package");

    const ownerRes = await fetchWithSession(buildTestApp(owner), "/api/v1/scans");
    expect(ownerRes.status).toBe(200);
    const ownerBody = (await ownerRes.json()) as { scans: Array<{ id: string }> };
    expect(ownerBody.scans.map((s) => s.id)).toContain(scanId);

    const intruderRes = await fetchWithSession(buildTestApp(intruder), "/api/v1/scans");
    expect(intruderRes.status).toBe(200);
    const intruderBody = (await intruderRes.json()) as { scans: Array<{ id: string }> };
    expect(intruderBody.scans.map((s) => s.id)).not.toContain(scanId);
  });

  test("GET /scans includes compact evidence counts for each row", async () => {
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
    await persistScanWithArtifacts(db, {
      id: scanId,
      stageId,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
      packageJson: { name: "@org/evidence-counts", version: "1.2.3" },
      risk: "high",
      status: "complete",
      summary: {
        diff: [
          { path: "package.json", status: "modified" },
          { path: "README.md", status: "unchanged" },
          { path: "OLD.md", status: "removed" },
        ],
      },
      ai: null,
      files: [
        { path: "package.json", size: 10, sha256: "a", flags: [], textSample: "{}" },
        { path: "README.md", size: 20, sha256: "b", flags: [], textSample: "docs" },
      ],
      diff: [
        { path: "package.json", status: "modified" },
        { path: "README.md", status: "unchanged" },
        { path: "OLD.md", status: "removed" },
      ],
      findings: [
        {
          severity: "high",
          file: "package.json",
          evidence: "postinstall",
          reason: "install lifecycle hook changed",
        },
      ],
      report: { version: 1, digest: "digest" },
    });

    const res = await fetchWithSession(buildTestApp(owner), "/api/v1/scans");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scans: Array<{ id: string; changedFileCount: number; findingCount: number }>;
    };
    const row = body.scans.find((scan) => scan.id === scanId);
    expect(row).toMatchObject({ changedFileCount: 2, findingCount: 1 });
  });

  test("GET /scans/:id annotates findings with line numbers and release delta status", async () => {
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
    await persistScanWithArtifacts(db, {
      id: scanId,
      stageId,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
      packageJson: { name: "@org/annotated-findings", version: "1.2.3" },
      risk: "high",
      status: "complete",
      summary: {
        diff: [{ path: "src/server.ts", status: "modified" }],
      },
      ai: null,
      files: [
        {
          path: "src/server.ts",
          size: 80,
          sha256: "new",
          flags: [],
          textSample: "fetch('/existing-risk');\nnew Function('return 2');\n",
        },
      ],
      previousFiles: [
        {
          path: "src/server.ts",
          size: 80,
          sha256: "old",
          flags: [],
          textSample: "fetch('/existing-risk');\nexport const value = 1;\n",
        },
      ],
      diff: [{ path: "src/server.ts", status: "modified" }],
      findings: [
        {
          severity: "high",
          file: "src/server.ts",
          line: 1,
          evidence: "network-capable code path",
          reason: "existing network path",
        },
        {
          severity: "medium",
          file: "src/server.ts",
          line: 2,
          evidence: "dynamic code or obfuscation primitive",
          reason: "changed release line",
        },
      ],
      report: { version: 1, digest: "digest" },
    });

    const res = await fetchWithSession(buildTestApp(owner), `/api/v1/scans/${scanId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      riskSummary: {
        artifactRisk: string;
        releaseRisk: string;
        contextRisk: string;
        releaseFindingCount: number;
        contextFindingCount: number;
      };
      findings: Array<{
        file: string;
        line: number | null;
        diffStatus: string;
        releaseDelta: boolean;
      }>;
    };
    expect(body.riskSummary).toMatchObject({
      artifactRisk: "high",
      releaseRisk: "medium",
      contextRisk: "high",
      releaseFindingCount: 1,
      contextFindingCount: 1,
    });
    expect(body.findings.find((finding) => finding.line === 1)).toMatchObject({
      diffStatus: "modified",
      releaseDelta: false,
    });
    expect(body.findings.find((finding) => finding.line === 2)).toMatchObject({
      diffStatus: "modified",
      releaseDelta: true,
    });
  });

  test("GET /scans includes release risk summaries for dashboard rows", async () => {
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
    await persistScanWithArtifacts(db, {
      id: scanId,
      stageId,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
      packageJson: { name: "@org/list-risk-summary", version: "1.2.3" },
      risk: "high",
      status: "complete",
      summary: {
        diff: [{ path: "src/server.ts", status: "modified" }],
        risk: {
          artifactRisk: "high",
          releaseRisk: "low",
          contextRisk: "high",
          releaseFindingCount: 0,
          contextFindingCount: 1,
          unknownFindingCount: 0,
        },
      },
      ai: null,
      files: [
        {
          path: "src/server.ts",
          size: 80,
          sha256: "new",
          flags: [],
          textSample: "fetch('/existing-risk');\nexport const value = 2;\n",
        },
      ],
      previousFiles: [
        {
          path: "src/server.ts",
          size: 80,
          sha256: "old",
          flags: [],
          textSample: "fetch('/existing-risk');\nexport const value = 1;\n",
        },
      ],
      diff: [{ path: "src/server.ts", status: "modified" }],
      findings: [
        {
          severity: "high",
          file: "src/server.ts",
          line: 1,
          evidence: "network-capable code path",
          reason: "existing network path",
        },
      ],
      report: { version: 1, digest: "digest" },
    });

    const res = await fetchWithSession(buildTestApp(owner), "/api/v1/scans?filter=all");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scans: Array<{
        id: string;
        riskSummary: {
          artifactRisk: string;
          releaseRisk: string;
          contextRisk: string;
          releaseFindingCount: number;
          contextFindingCount: number;
        } | null;
      }>;
    };
    const row = body.scans.find((scan) => scan.id === scanId);
    expect(row?.riskSummary).toMatchObject({
      artifactRisk: "high",
      releaseRisk: "low",
      contextRisk: "high",
      releaseFindingCount: 0,
      contextFindingCount: 1,
    });
  });

  test("GET /scans/:id omits derived risk summary before completion", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const scanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(db, {
      id: scanId,
      stageId: `stage-${scanId.slice(-12)}`,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
    });

    const res = await fetchWithSession(buildTestApp(owner), `/api/v1/scans/${scanId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scan: { status: string }; riskSummary: unknown };
    expect(body.scan.status).toBe("pending");
    expect(body.riskSummary).toBeNull();
  });

  test("GET /scans lists every scan for a stage id with the newest first", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const stageId = `stage-${crypto.randomUUID().slice(0, 12)}`;
    const olderId = await seedCompletedScanWithStage(owner, "@org/retry-package", stageId);
    const newerId = await seedCompletedScanWithStage(owner, "@org/retry-package", stageId);

    await Promise.all([
      db
        .update(schema.scans)
        .set({ createdAt: new Date(1), updatedAt: new Date(1) })
        .where(eq(schema.scans.id, olderId)),
      db
        .update(schema.scans)
        .set({ createdAt: new Date(2), updatedAt: new Date(2) })
        .where(eq(schema.scans.id, newerId)),
    ]);

    const res = await fetchWithSession(buildTestApp(owner), "/api/v1/scans?filter=all");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scans: Array<{ id: string; stageId: string }> };
    const matching = body.scans.filter((scan) => scan.stageId === stageId);
    expect(matching.map((scan) => scan.id)).toEqual([newerId, olderId]);
  });

  test("GET /scans paginates with a cursor and defaults to undecided scans", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(await seedCompletedScan(owner, "@org/page-package"));
    }
    // Decide the oldest so it should be filtered out of the default view.
    const decidedId = ids[0]!;
    await db
      .update(schema.scans)
      .set({ decision: "publish", decidedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.scans.id, decidedId));

    const firstPage = await fetchWithSession(
      buildTestApp(owner),
      "/api/v1/scans?limit=1&filter=undecided",
    );
    expect(firstPage.status).toBe(200);
    const firstBody = (await firstPage.json()) as {
      scans: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(firstBody.scans).toHaveLength(1);
    expect(firstBody.scans[0]?.id).not.toBe(decidedId);
    expect(firstBody.nextCursor).toBeTypeOf("string");

    const secondPage = await fetchWithSession(
      buildTestApp(owner),
      `/api/v1/scans?limit=1&filter=undecided&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
    );
    const secondBody = (await secondPage.json()) as {
      scans: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(secondBody.scans).toHaveLength(1);
    expect(secondBody.scans[0]?.id).not.toBe(firstBody.scans[0]?.id);
    expect(secondBody.scans[0]?.id).not.toBe(decidedId);
    expect(secondBody.nextCursor).toBeNull();
  });

  test("POST /scans/:id/decision records a publish decision on completed scans", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, "@org/decide-package");

    const ctx = createExecutionContext();
    const res = await buildTestApp(owner).fetch(
      new Request(`http://test.local/api/v1/scans/${scanId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "publish", reason: "minor patch" }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scan: { decision: string; decisionReason: string };
    };
    expect(body.scan.decision).toBe("publish");
    expect(body.scan.decisionReason).toBe("minor patch");
  });

  test("POST /scans/:id/decision rejects invalid decision values", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, "@org/decide-package");

    const ctx = createExecutionContext();
    const res = await buildTestApp(owner).fetch(
      new Request(`http://test.local/api/v1/scans/${scanId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "maybe" }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  test("POST /scans/:id/decision returns 409 for non-complete scans", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const scanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(db, {
      id: scanId,
      stageId: `stage-${scanId.slice(-12)}`,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
    });

    const ctx = createExecutionContext();
    const res = await buildTestApp(owner).fetch(
      new Request(`http://test.local/api/v1/scans/${scanId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "publish" }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(409);
  });

  test("GET /scans/:id returns 404 for scans owned by another organization", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const scanId = await seedCompletedScan(owner, "@org/private-package");

    const ownerRes = await fetchWithSession(buildTestApp(owner), `/api/v1/scans/${scanId}`);
    expect(ownerRes.status).toBe(200);

    const intruderRes = await fetchWithSession(buildTestApp(intruder), `/api/v1/scans/${scanId}`);
    expect(intruderRes.status).toBe(404);
  });

  test("GET /scans/:id includes scan-scoped events for the owning organization", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, "@org/timeline-package");
    const db = createDb(env.DB);

    await db.insert(schema.scanEvents).values([
      {
        id: crypto.randomUUID(),
        organizationId: owner.organizationId,
        actorUserId: owner.userId,
        scanId,
        type: "scan.decided",
        metadataJson: {
          stageId: "stage-timeline",
          decision: "publish",
          tokenFingerprint: "secret-fingerprint",
        },
        createdAt: new Date(1),
      },
      {
        id: crypto.randomUUID(),
        organizationId: owner.organizationId,
        actorUserId: owner.userId,
        scanId,
        type: "scan.decided",
        metadataJson: { stageId: "stage-timeline", decision: "no_publish" },
        createdAt: new Date(2),
      },
    ]);

    const res = await fetchWithSession(buildTestApp(owner), `/api/v1/scans/${scanId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ type: string; metadataJson: Record<string, unknown> }>;
    };
    expect(body.events.map((event) => event.type)).toEqual(["scan.decided", "scan.decided"]);
    expect(body.events[0].metadataJson).toMatchObject({
      stageId: "stage-timeline",
      decision: "publish",
    });
    // Sensitive metadata keys are redacted before the client sees them.
    expect(body.events[0].metadataJson).not.toHaveProperty("tokenFingerprint");
    expect(body.events[1].metadataJson).toMatchObject({ decision: "no_publish" });
  });

  test("GET /scans/:id/versions returns 404 for foreign scan ids", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const scanId = await seedCompletedScan(owner, "@org/private-package");

    const intruderRes = await fetchWithSession(
      buildTestApp(intruder),
      `/api/v1/scans/${scanId}/versions`,
    );
    expect(intruderRes.status).toBe(404);
  });

  test("GET /scans/:id/compare returns 404 before touching the registry for foreign scans", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const scanId = await seedCompletedScan(owner, "@org/private-package");

    const compareRes = await fetchWithSession(
      buildTestApp(intruder),
      `/api/v1/scans/${scanId}/compare?version=1.0.0`,
    );
    expect(compareRes.status).toBe(404);
  });

  test("GET /scans/:id/compare/file returns 404 for foreign scans even with path query", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const scanId = await seedCompletedScan(owner, "@org/private-package");

    const fileRes = await fetchWithSession(
      buildTestApp(intruder),
      `/api/v1/scans/${scanId}/compare/file?version=1.0.0&path=package.json`,
    );
    expect(fileRes.status).toBe(404);
  });

  test("scan_files and scan_findings are isolated by organization", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const db = createDb(env.DB);

    const scanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(db, {
      id: scanId,
      stageId: `stage-${scanId.slice(-12)}`,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
    });
    await persistScanWithArtifacts(db, {
      id: scanId,
      stageId: `stage-${scanId.slice(-12)}`,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
      packageJson: { name: "@org/with-files", version: "0.1.0" },
      risk: "high",
      status: "complete",
      summary: { ok: true },
      ai: null,
      files: [
        {
          path: "package.json",
          size: 12,
          sha256: "abc",
          flags: [],
          textSample: '{"name":"@org/with-files"}',
        },
      ],
      diff: [{ path: "package.json", status: "added" }],
      findings: [
        {
          severity: "high",
          file: "package.json",
          line: 3,
          evidence: "install script added",
          reason: "lifecycle script touches network",
        },
      ],
      report: { version: 1, digest: "digest" },
    });

    const ownerRes = await fetchWithSession(buildTestApp(owner), `/api/v1/scans/${scanId}`);
    expect(ownerRes.status).toBe(200);
    const ownerBody = (await ownerRes.json()) as {
      files: Array<{ path: string }>;
      findings: Array<{
        severity: string;
        line: number | null;
        diffStatus: string;
        releaseDelta: boolean;
      }>;
    };
    expect(ownerBody.files.map((f) => f.path)).toEqual(["package.json"]);
    expect(ownerBody.findings.map((f) => f.severity)).toEqual(["high"]);
    expect(ownerBody.findings[0]).toMatchObject({
      line: 3,
      diffStatus: "added",
      releaseDelta: true,
    });

    const intruderRes = await fetchWithSession(buildTestApp(intruder), `/api/v1/scans/${scanId}`);
    expect(intruderRes.status).toBe(404);
  });
});
