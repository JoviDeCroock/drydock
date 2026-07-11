import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import * as schema from "../../server/db/schema";
import { auditRoutes } from "../../server/routes/audit";
import { ACTIVE_ORG_HEADER } from "../../server/lib/active-organization";
import type { Bindings, Variables } from "../../server/types";

interface SeededUser {
  userId: string;
  organizationId: string;
}

async function seedUser(name = "Tester"): Promise<SeededUser> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name,
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, organizationId };
}

async function addMember(
  organizationId: string,
  userId: string,
  role: "owner" | "admin" | "member",
) {
  const db = createDb(env.DB);
  const now = new Date();
  await db.insert(schema.organizationMembers).values({
    id: `member_${crypto.randomUUID()}`,
    organizationId,
    userId,
    role,
    createdAt: now,
    updatedAt: now,
  });
}

async function insertEvent(input: {
  organizationId: string;
  type: string;
  actorUserId?: string | null;
  scanId?: string | null;
  metadata?: unknown;
  createdAt: Date;
}) {
  const db = createDb(env.DB);
  await db.insert(schema.scanEvents).values({
    id: `evt_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? null,
    scanId: input.scanId ?? null,
    type: input.type,
    metadataJson: input.metadata ?? null,
    createdAt: input.createdAt,
  });
}

function buildTestApp(session: { userId: string }) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId: session.userId });
    await next();
  });
  app.route("/api/v1/audit-events", auditRoutes);
  return app;
}

async function fetchAudit(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  path: string,
  orgHeader?: string,
) {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = {};
  if (orgHeader) headers[ACTIVE_ORG_HEADER] = orgHeader;
  const res = await app.fetch(
    new Request(`http://test.local${path}`, { method: "GET", headers }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

interface AuditEventBody {
  id: string;
  type: string;
  category: string;
  label: string;
  severity: string;
  detail: string | null;
  createdAt: number;
  scanId: string | null;
  actor: { type: string; name?: string | null; email?: string | null };
}

describe("audit-events route", () => {
  test("returns only audit-visible events, shaped with registry metadata", async () => {
    const owner = await seedUser("Ada");
    const base = Date.now();
    await insertEvent({
      organizationId: owner.organizationId,
      type: "organization.member_invited",
      actorUserId: owner.userId,
      metadata: { invitedEmail: "invitee@example.com" },
      createdAt: new Date(base),
    });
    // Not on the visible allowlist — must be filtered out.
    await insertEvent({
      organizationId: owner.organizationId,
      type: "scan.started",
      createdAt: new Date(base + 1),
    });

    const res = await fetchAudit(buildTestApp(owner), "/api/v1/audit-events");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: AuditEventBody[]; nextCursor: string | null };

    expect(body.events.map((e) => e.type)).toEqual(["organization.member_invited"]);
    const [event] = body.events;
    expect(event.category).toBe("member");
    expect(event.label).toBe("Member invited");
    expect(event.detail).toBe("invitee@example.com");
    expect(event.actor).toEqual({
      type: "user",
      name: "Ada",
      email: `${owner.userId}@example.com`,
    });
  });

  test("never leaks raw or sensitive event metadata", async () => {
    const owner = await seedUser();
    await insertEvent({
      organizationId: owner.organizationId,
      type: "npm_connection.upserted",
      actorUserId: owner.userId,
      metadata: {
        label: "prod",
        registryUrl: "https://registry.example.com",
        tokenLast4: "9999",
        tokenCiphertext: "SECRET_CIPHERTEXT",
      },
      createdAt: new Date(),
    });

    const res = await fetchAudit(buildTestApp(owner), "/api/v1/audit-events");
    const raw = await res.text();
    expect(raw).not.toContain("SECRET_CIPHERTEXT");
    expect(raw).not.toContain("9999");
    const body = JSON.parse(raw) as { events: Array<Record<string, unknown>> };
    expect(body.events[0]).not.toHaveProperty("metadataJson");
    expect(body.events[0].detail).toBe("prod");
  });

  test("scopes events to the caller's organization", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    await insertEvent({
      organizationId: other.organizationId,
      type: "organization.renamed",
      actorUserId: other.userId,
      metadata: { name: "Their Org" },
      createdAt: new Date(),
    });

    const res = await fetchAudit(buildTestApp(owner), "/api/v1/audit-events");
    const body = (await res.json()) as { events: AuditEventBody[] };
    expect(body.events).toHaveLength(0);
  });

  test("paginates newest-first with a stable cursor", async () => {
    const owner = await seedUser();
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      await insertEvent({
        organizationId: owner.organizationId,
        type: "organization.renamed",
        actorUserId: owner.userId,
        metadata: { name: `rename-${i}` },
        createdAt: new Date(base + i * 1000),
      });
    }

    const app = buildTestApp(owner);
    const firstRes = await fetchAudit(app, "/api/v1/audit-events?limit=2");
    const first = (await firstRes.json()) as {
      events: AuditEventBody[];
      nextCursor: string | null;
    };
    expect(first.events).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    // Newest first: rename-2 then rename-1.
    expect(first.events.map((e) => e.detail)).toEqual(["rename-2", "rename-1"]);

    const secondRes = await fetchAudit(
      app,
      `/api/v1/audit-events?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    const second = (await secondRes.json()) as {
      events: AuditEventBody[];
      nextCursor: string | null;
    };
    expect(second.events.map((e) => e.detail)).toEqual(["rename-0"]);
    expect(second.nextCursor).toBeNull();
  });

  test("forbids members from reading the audit log", async () => {
    const owner = await seedUser();
    const member = await seedUser();
    await addMember(owner.organizationId, member.userId, "member");
    await insertEvent({
      organizationId: owner.organizationId,
      type: "organization.renamed",
      actorUserId: owner.userId,
      metadata: { name: "Owned" },
      createdAt: new Date(),
    });

    const res = await fetchAudit(
      buildTestApp(member),
      "/api/v1/audit-events",
      owner.organizationId,
    );
    expect(res.status).toBe(403);
  });

  test("allows admins to read the audit log", async () => {
    const owner = await seedUser();
    const admin = await seedUser();
    await addMember(owner.organizationId, admin.userId, "admin");
    await insertEvent({
      organizationId: owner.organizationId,
      type: "organization.renamed",
      actorUserId: owner.userId,
      metadata: { name: "Owned" },
      createdAt: new Date(),
    });

    const res = await fetchAudit(buildTestApp(admin), "/api/v1/audit-events", owner.organizationId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: AuditEventBody[] };
    expect(body.events).toHaveLength(1);
  });
});
