import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createDb, createScanJob, ensurePersonalOrganization, persistScan } from "../../server/db";
import * as schema from "../../server/db/schema";
import { scansRoutes } from "../../server/routes/scans";
import type { Bindings, Variables } from "../../server/types";

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
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  await createScanJob(db, {
    id: scanId,
    stageId: `stage-${scanId.slice(-12)}`,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
  });
  await persistScan(db, {
    id: scanId,
    stageId: `stage-${scanId.slice(-12)}`,
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

  test("GET /scans/:id returns 404 for scans owned by another organization", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const scanId = await seedCompletedScan(owner, "@org/private-package");

    const ownerRes = await fetchWithSession(buildTestApp(owner), `/api/v1/scans/${scanId}`);
    expect(ownerRes.status).toBe(200);

    const intruderRes = await fetchWithSession(buildTestApp(intruder), `/api/v1/scans/${scanId}`);
    expect(intruderRes.status).toBe(404);
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
    await persistScan(db, {
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
      findings: Array<{ severity: string }>;
    };
    expect(ownerBody.files.map((f) => f.path)).toEqual(["package.json"]);
    expect(ownerBody.findings.map((f) => f.severity)).toEqual(["high"]);

    const intruderRes = await fetchWithSession(buildTestApp(intruder), `/api/v1/scans/${scanId}`);
    expect(intruderRes.status).toBe(404);
  });
});
