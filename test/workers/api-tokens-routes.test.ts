import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createApiToken, hashApiToken } from "../../server/db/api-tokens";
import { createDb } from "../../server/db/client";
import { addOrganizationMember } from "../../server/db/invitations";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { createScanJob, persistScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { organizationsRoutes } from "../../server/routes/organizations";
import worker from "../../server/index";
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

function buildOrganizationsApp(session: { userId: string }) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId: session.userId });
    await next();
  });
  app.route("/api/v1/organizations", organizationsRoutes);
  return app;
}

async function callOrganizationsRoute(
  session: { userId: string },
  method: string,
  path: string,
  body?: unknown,
) {
  const ctx = createExecutionContext();
  const headers = new Headers();
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  const app = buildOrganizationsApp(session);
  const res = await app.fetch(new Request(`http://test.local${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedCompletedScan(owner: SeededUser, stageId: string, packageName: string) {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
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
    packageJson: { name: packageName, version: "1.0.0" },
    risk: "low",
    status: "complete",
    summary: { ok: true },
    ai: null,
    files: [],
    diff: [],
    findings: [],
    report: { version: 1, digest: `digest-${scanId}` },
  });
  return scanId;
}

async function bearerFetch(path: string, secret: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${secret}`);
  const res = await worker.fetch(
    new Request(`http://example.com${path}`, { ...init, headers }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("organization API tokens", () => {
  test("owners create, list, and revoke tokens without exposing the secret after creation", async () => {
    const owner = await seedUser();
    const create = await callOrganizationsRoute(
      owner,
      "POST",
      `/api/v1/organizations/${owner.organizationId}/api-tokens`,
      { name: "release CLI", scopes: ["scans:read", "scans:write"] },
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      token: { id: string; tokenLast4: string; scopes: string[]; tokenHash?: string };
      secret: string;
    };
    expect(created.secret.startsWith("drydock_")).toBe(true);
    expect(created.token.tokenLast4).toBe(created.secret.slice(-4));
    expect(created.token.scopes).toEqual(["scans:read", "scans:write"]);
    expect(created.token.tokenHash).toBeUndefined();

    const db = createDb(env.DB);
    const [stored] = await db
      .select()
      .from(schema.organizationApiTokens)
      .where(eq(schema.organizationApiTokens.id, created.token.id))
      .limit(1);
    expect(stored?.tokenHash).toBe(await hashApiToken(created.secret));
    expect(stored?.tokenHash).not.toBe(created.secret);

    const list = await callOrganizationsRoute(
      owner,
      "GET",
      `/api/v1/organizations/${owner.organizationId}/api-tokens`,
    );
    expect(list.status).toBe(200);
    const listedText = await list.text();
    expect(listedText).toContain(created.token.id);
    expect(listedText).not.toContain(created.secret);
    expect(listedText).not.toContain(stored?.tokenHash ?? "missing-hash");

    const revoke = await callOrganizationsRoute(
      owner,
      "DELETE",
      `/api/v1/organizations/${owner.organizationId}/api-tokens/${created.token.id}`,
    );
    expect(revoke.status).toBe(200);

    const after = await db
      .select()
      .from(schema.organizationApiTokens)
      .where(
        and(
          eq(schema.organizationApiTokens.id, created.token.id),
          isNull(schema.organizationApiTokens.revokedAt),
        ),
      );
    expect(after).toHaveLength(0);
  });

  test("admins can manage API tokens but members cannot", async () => {
    const owner = await seedUser();
    const admin = await seedUser();
    const member = await seedUser();
    const db = createDb(env.DB);
    await addOrganizationMember(db, {
      organizationId: owner.organizationId,
      userId: admin.userId,
      role: "admin",
    });
    await addOrganizationMember(db, {
      organizationId: owner.organizationId,
      userId: member.userId,
      role: "member",
    });

    const adminCreate = await callOrganizationsRoute(
      admin,
      "POST",
      `/api/v1/organizations/${owner.organizationId}/api-tokens`,
      { name: "admin token", scopes: ["scans:read"] },
    );
    expect(adminCreate.status).toBe(201);

    const memberCreate = await callOrganizationsRoute(
      member,
      "POST",
      `/api/v1/organizations/${owner.organizationId}/api-tokens`,
      { name: "member token", scopes: ["scans:read"] },
    );
    expect(memberCreate.status).toBe(403);
  });

  test("bearer tokens read only their organization scans and record use", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const ownedScanId = await seedCompletedScan(owner, "stage-token-owned", "@org/owned");
    const otherScanId = await seedCompletedScan(other, "stage-token-other", "@org/other");
    const db = createDb(env.DB);
    const { secret, token } = await createApiToken(db, {
      organizationId: owner.organizationId,
      name: "reader",
      scopes: ["scans:read"],
      createdByUserId: owner.userId,
    });

    const res = await bearerFetch("/api/v1/scans?filter=all", secret);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scans: Array<{ id: string }> };
    expect(body.scans.map((scan) => scan.id)).toContain(ownedScanId);
    expect(body.scans.map((scan) => scan.id)).not.toContain(otherScanId);

    const [stored] = await db
      .select()
      .from(schema.organizationApiTokens)
      .where(eq(schema.organizationApiTokens.id, token.id))
      .limit(1);
    expect(stored?.lastUsedAt).toBeInstanceOf(Date);

    const events = await db
      .select()
      .from(schema.scanEvents)
      .where(eq(schema.scanEvents.organizationId, owner.organizationId));
    expect(events.some((event) => event.type === "api_token.used")).toBe(true);
  });

  test("bearer scopes cannot manage settings or decide releases", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, "stage-token-decision", "@org/decision");
    const { secret } = await createApiToken(createDb(env.DB), {
      organizationId: owner.organizationId,
      name: "writer",
      scopes: ["scans:read", "scans:write"],
      createdByUserId: owner.userId,
    });

    const orgs = await bearerFetch("/api/v1/organizations", secret);
    expect(orgs.status).toBe(403);

    const decision = await bearerFetch(`/api/v1/scans/${scanId}/decision`, secret, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "publish" }),
    });
    expect(decision.status).toBe(403);
  });

  test("write-scoped bearer tokens can submit POST requests without browser origin", async () => {
    const owner = await seedUser();
    const { secret } = await createApiToken(createDb(env.DB), {
      organizationId: owner.organizationId,
      name: "writer",
      scopes: ["scans:write"],
      createdByUserId: owner.userId,
    });

    const res = await bearerFetch("/api/v1/scans", secret, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stageId: "stage-token-submit-000001" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "Connect an organization npm token before scanning staged publishes.",
    });
  });

  test("revoked bearer tokens are rejected", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const { secret, token } = await createApiToken(db, {
      organizationId: owner.organizationId,
      name: "temporary",
      scopes: ["scans:read"],
      createdByUserId: owner.userId,
    });
    await callOrganizationsRoute(
      owner,
      "DELETE",
      `/api/v1/organizations/${owner.organizationId}/api-tokens/${token.id}`,
    );

    const res = await bearerFetch("/api/v1/scans", secret);
    expect(res.status).toBe(401);
  });
});
