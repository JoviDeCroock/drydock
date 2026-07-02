import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import {
  addOrganizationMember,
  createDb,
  createScanJob,
  ensurePersonalOrganization,
  persistScan,
} from "../../server/db";
import * as schema from "../../server/db/schema";
import { publicReportsRoutes } from "../../server/routes/public-reports";
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

function buildApp(session?: { userId: string }) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/api/public/reports", publicReportsRoutes);
  if (session) {
    app.use("/api/v1/*", async (c, next) => {
      c.set("authSession", { userId: session.userId });
      await next();
    });
    app.route("/api/v1/scans", scansRoutes);
  }
  return app;
}

async function request(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  path: string,
  init: RequestInit = {},
) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://test.local${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedCompletedScan(owner: SeededUser): Promise<string> {
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
    packageJson: { name: "@org/pkg", version: "1.1.0" },
    risk: "high",
    status: "complete",
    summary: {
      baseline: { kind: "registry", version: "1.0.0" },
      diff: [{ path: "package.json", status: "modified" }],
    },
    ai: null,
    files: [{ path: "package.json", size: 10, sha256: "a", flags: [], textSample: "{}" }],
    diff: [{ path: "package.json", status: "modified", flags: [] }],
    findings: [
      {
        severity: "high",
        file: "package.json",
        evidence: "postinstall: node install.js",
        reason: "install lifecycle hooks execute on consumer machines",
        ruleId: "install-script.lifecycle",
        ruleVersion: "1.8.0",
      },
    ],
    report: { version: 1, digest: "abc123" },
  });
  return scanId;
}

async function createShare(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  scanId: string,
): Promise<{ token: string; path: string }> {
  const res = await request(app, `/api/v1/scans/${scanId}/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; path: string };
}

describe("scan report share links", () => {
  test("creating a share exposes the report through the public token route", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const app = buildApp(owner);

    const { token, path } = await createShare(app, scanId);
    expect(path).toBe(`/reports/${token}`);

    const res = await request(app, `/api/public/reports/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      schema: string;
      package: { name: string | null };
      findings: Array<{ ruleId: string | null }>;
    };
    expect(body.schema).toBe("drydock.report.v1");
    expect(body.package.name).toBe("@org/pkg");
    expect(body.findings).toEqual([
      expect.objectContaining({ ruleId: "install-script.lifecycle" }),
    ]);
  });

  test("serves a shields endpoint badge for a shared report", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const app = buildApp(owner);

    const { token } = await createShare(app, scanId);
    const res = await request(app, `/api/public/reports/${token}/badge`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      schemaVersion: 1,
      label: "drydock",
      message: "high risk",
      color: "orange",
    });
  });

  test("revoking a share makes the token stop resolving", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const app = buildApp(owner);

    const { token } = await createShare(app, scanId);
    const revoke = await request(app, `/api/v1/scans/${scanId}/share`, { method: "DELETE" });
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toMatchObject({ share: { active: false } });

    expect((await request(app, `/api/public/reports/${token}`)).status).toBe(404);
    expect((await request(app, `/api/public/reports/${token}/badge`)).status).toBe(404);
  });

  test("rotating a share invalidates previously issued links", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const app = buildApp(owner);

    const first = await createShare(app, scanId);
    const second = await createShare(app, scanId);
    expect(second.token).not.toBe(first.token);

    expect((await request(app, `/api/public/reports/${first.token}`)).status).toBe(404);
    expect((await request(app, `/api/public/reports/${second.token}`)).status).toBe(200);
  });

  test("share status is readable by members but creation requires admin", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const member = await seedUser();
    const db = createDb(env.DB);
    await addOrganizationMember(db, {
      organizationId: owner.organizationId,
      userId: member.userId,
      role: "member",
    });

    const memberApp = buildApp(member);
    const headers = { "x-organization-id": owner.organizationId };
    const status = await request(memberApp, `/api/v1/scans/${scanId}/share`, { headers });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ share: { active: false } });

    const create = await request(memberApp, `/api/v1/scans/${scanId}/share`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
    });
    expect(create.status).toBe(403);
  });

  test("refuses to share an incomplete scan", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const scanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(db, {
      id: scanId,
      stageId: `stage-${scanId.slice(-12)}`,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
    });

    const res = await request(buildApp(owner), `/api/v1/scans/${scanId}/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(409);
  });

  test("rejects malformed and unknown tokens", async () => {
    const app = buildApp();
    expect((await request(app, "/api/public/reports/short")).status).toBe(404);
    expect((await request(app, "/api/public/reports/..%2F..%2Fetc")).status).toBe(404);
    const unknown = "A".repeat(43);
    expect((await request(app, `/api/public/reports/${unknown}`)).status).toBe(404);
  });
});
