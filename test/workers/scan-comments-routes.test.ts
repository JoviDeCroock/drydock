import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  addOrganizationMember,
  createDb,
  ensurePersonalOrganization,
  getUserNotificationSettings,
  setUserNotificationSettings,
} from "../../server/db";
import * as schema from "../../server/db/schema";
import { ACTIVE_ORG_HEADER } from "../../server/lib/active-organization";
import { accountRoutes } from "../../server/routes/account";
import { scanCommentsRoutes } from "../../server/routes/scan-comments";
import { organizationsRoutes } from "../../server/routes/organizations";
import type { Bindings, Variables } from "../../server/types";

interface SeededUser {
  userId: string;
  email: string;
  personalOrganizationId: string;
}

async function seedUser(): Promise<SeededUser> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.com`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Tester",
    email,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const personalOrganizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, email, personalOrganizationId };
}

async function seedScan(organizationId: string, ownerUserId: string): Promise<string> {
  const db = createDb(env.DB);
  const now = new Date();
  const scanId = crypto.randomUUID();
  await db.insert(schema.scans).values({
    id: scanId,
    stageId: `stage_${scanId}`,
    organizationId,
    ownerUserId,
    packageName: "left-pad",
    stagedVersion: "1.0.1",
    status: "complete",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.scanFiles).values({
    id: crypto.randomUUID(),
    scanId,
    path: "index.js",
    status: "modified",
    sha256: "abc123",
    flagsJson: [],
  });
  await db.insert(schema.scanFindings).values({
    id: `finding_${scanId}`,
    scanId,
    severity: "high",
    file: "index.js",
    evidence: "eval(input)",
    reason: "dynamic eval",
    line: 3,
  });
  return scanId;
}

function buildTestApp(session: { userId: string }) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId: session.userId });
    await next();
  });
  app.route("/api/v1/organizations", organizationsRoutes);
  app.route("/api/v1/scans", scanCommentsRoutes);
  app.route("/api/v1/account", accountRoutes);
  return app;
}

async function call(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  method: string,
  path: string,
  options: { body?: unknown; activeOrganizationId?: string } = {},
) {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = {};
  const init: RequestInit = { method };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }
  if (options.activeOrganizationId) {
    headers[ACTIVE_ORG_HEADER] = options.activeOrganizationId;
  }
  init.headers = headers;
  const res = await app.fetch(new Request(`http://test.local${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

interface CommentPayload {
  comment: {
    id: string;
    body: string;
    anchorType: string;
    filePath: string | null;
    line: number | null;
    findingId: string | null;
    mentionedUserIds: string[];
    deleted: boolean;
  };
}

describe("scan comment routes", () => {
  test("general comment round-trips through create and list", async () => {
    const owner = await seedUser();
    const scanId = await seedScan(owner.personalOrganizationId, owner.userId);
    const app = buildTestApp(owner);

    const created = await call(app, "POST", `/api/v1/scans/${scanId}/comments`, {
      body: { body: "looks good to me" },
      activeOrganizationId: owner.personalOrganizationId,
    });
    expect(created.status).toBe(201);
    const payload = (await created.json()) as CommentPayload;
    expect(payload.comment.body).toBe("looks good to me");
    expect(payload.comment.anchorType).toBe("general");

    const list = await call(app, "GET", `/api/v1/scans/${scanId}/comments`, {
      activeOrganizationId: owner.personalOrganizationId,
    });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { comments: CommentPayload["comment"][] };
    expect(listed.comments).toHaveLength(1);
    expect(listed.comments[0].body).toBe("looks good to me");

    const db = createDb(env.DB);
    const events = await db
      .select()
      .from(schema.scanEvents)
      .where(eq(schema.scanEvents.type, "scan.comment_created"));
    expect(events.some((event) => event.scanId === scanId)).toBe(true);
  });

  test("line anchors validate against scan files and capture the file sha", async () => {
    const owner = await seedUser();
    const scanId = await seedScan(owner.personalOrganizationId, owner.userId);
    const app = buildTestApp(owner);

    const bad = await call(app, "POST", `/api/v1/scans/${scanId}/comments`, {
      body: { body: "where is this?", anchorType: "line", filePath: "missing.js", line: 1 },
      activeOrganizationId: owner.personalOrganizationId,
    });
    expect(bad.status).toBe(400);

    const good = await call(app, "POST", `/api/v1/scans/${scanId}/comments`, {
      body: { body: "suspicious", anchorType: "line", filePath: "index.js", line: 3 },
      activeOrganizationId: owner.personalOrganizationId,
    });
    expect(good.status).toBe(201);
    const payload = (await good.json()) as CommentPayload;
    expect(payload.comment.filePath).toBe("index.js");
    expect(payload.comment.line).toBe(3);

    const db = createDb(env.DB);
    const [row] = await db
      .select()
      .from(schema.scanComments)
      .where(eq(schema.scanComments.id, payload.comment.id));
    expect(row.fileSha256).toBe("abc123");
  });

  test("finding anchors validate and inherit the finding location", async () => {
    const owner = await seedUser();
    const scanId = await seedScan(owner.personalOrganizationId, owner.userId);
    const app = buildTestApp(owner);

    const bad = await call(app, "POST", `/api/v1/scans/${scanId}/comments`, {
      body: { body: "hm", anchorType: "finding", findingId: "nope" },
      activeOrganizationId: owner.personalOrganizationId,
    });
    expect(bad.status).toBe(400);

    const good = await call(app, "POST", `/api/v1/scans/${scanId}/comments`, {
      body: { body: "real issue", anchorType: "finding", findingId: `finding_${scanId}` },
      activeOrganizationId: owner.personalOrganizationId,
    });
    expect(good.status).toBe(201);
    const payload = (await good.json()) as CommentPayload;
    expect(payload.comment.findingId).toBe(`finding_${scanId}`);
    expect(payload.comment.filePath).toBe("index.js");
    expect(payload.comment.line).toBe(3);
  });

  test("comments are scoped to the scan's organization", async () => {
    const owner = await seedUser();
    const outsider = await seedUser();
    const scanId = await seedScan(owner.personalOrganizationId, owner.userId);

    const res = await call(buildTestApp(outsider), "GET", `/api/v1/scans/${scanId}/comments`, {
      activeOrganizationId: outsider.personalOrganizationId,
    });
    expect(res.status).toBe(404);

    const post = await call(buildTestApp(outsider), "POST", `/api/v1/scans/${scanId}/comments`, {
      body: { body: "should not land" },
      activeOrganizationId: outsider.personalOrganizationId,
    });
    expect(post.status).toBe(404);
  });

  test("member mentions persist; non-member mentions are dropped silently", async () => {
    const db = createDb(env.DB);
    const owner = await seedUser();
    const teammate = await seedUser();
    const outsider = await seedUser();
    await addOrganizationMember(db, {
      organizationId: owner.personalOrganizationId,
      userId: teammate.userId,
      role: "member",
    });
    const scanId = await seedScan(owner.personalOrganizationId, owner.userId);

    const res = await call(buildTestApp(owner), "POST", `/api/v1/scans/${scanId}/comments`, {
      body: { body: `ping @[${teammate.userId}] and @[${outsider.userId}]` },
      activeOrganizationId: owner.personalOrganizationId,
    });
    expect(res.status).toBe(201);
    const payload = (await res.json()) as CommentPayload;
    expect(payload.comment.mentionedUserIds).toEqual([teammate.userId]);

    const mentions = await db
      .select()
      .from(schema.scanCommentMentions)
      .where(eq(schema.scanCommentMentions.commentId, payload.comment.id));
    expect(mentions).toHaveLength(1);
    expect(mentions[0].mentionedUserId).toBe(teammate.userId);
  });

  test("mention emails are skipped when the user turned them off", async () => {
    const db = createDb(env.DB);
    const owner = await seedUser();
    const teammate = await seedUser();
    await addOrganizationMember(db, {
      organizationId: owner.personalOrganizationId,
      userId: teammate.userId,
      role: "member",
    });
    await setUserNotificationSettings(db, teammate.userId, { mentionEmails: false });
    const scanId = await seedScan(owner.personalOrganizationId, owner.userId);

    const res = await call(buildTestApp(owner), "POST", `/api/v1/scans/${scanId}/comments`, {
      body: { body: `fyi @[${teammate.userId}]` },
      activeOrganizationId: owner.personalOrganizationId,
    });
    expect(res.status).toBe(201);

    const events = await db
      .select()
      .from(schema.scanEvents)
      .where(eq(schema.scanEvents.scanId, scanId));
    expect(events.some((event) => event.type.startsWith("scan.comment_mention"))).toBe(false);
  });

  test("editing only notifies newly mentioned users", async () => {
    const db = createDb(env.DB);
    const owner = await seedUser();
    const first = await seedUser();
    const second = await seedUser();
    for (const member of [first, second]) {
      await addOrganizationMember(db, {
        organizationId: owner.personalOrganizationId,
        userId: member.userId,
        role: "member",
      });
    }
    const scanId = await seedScan(owner.personalOrganizationId, owner.userId);
    const app = buildTestApp(owner);

    const created = await call(app, "POST", `/api/v1/scans/${scanId}/comments`, {
      body: { body: `hello @[${first.userId}]` },
      activeOrganizationId: owner.personalOrganizationId,
    });
    const payload = (await created.json()) as CommentPayload;

    const edited = await call(
      app,
      "PATCH",
      `/api/v1/scans/${scanId}/comments/${payload.comment.id}`,
      {
        body: { body: `hello @[${first.userId}] and @[${second.userId}]` },
        activeOrganizationId: owner.personalOrganizationId,
      },
    );
    expect(edited.status).toBe(200);
    const editedPayload = (await edited.json()) as CommentPayload;
    // PATCH reports the full mention set, but only `second` was newly stored.
    expect(editedPayload.comment.mentionedUserIds.sort()).toEqual(
      [first.userId, second.userId].sort(),
    );

    const mentions = await db
      .select()
      .from(schema.scanCommentMentions)
      .where(eq(schema.scanCommentMentions.commentId, payload.comment.id));
    expect(mentions).toHaveLength(2);
  });

  test("only the author edits; admins can delete; deletes are soft", async () => {
    const db = createDb(env.DB);
    const owner = await seedUser();
    const member = await seedUser();
    await addOrganizationMember(db, {
      organizationId: owner.personalOrganizationId,
      userId: member.userId,
      role: "member",
    });
    const scanId = await seedScan(owner.personalOrganizationId, owner.userId);

    const created = await call(buildTestApp(member), "POST", `/api/v1/scans/${scanId}/comments`, {
      body: { body: "my note" },
      activeOrganizationId: owner.personalOrganizationId,
    });
    const payload = (await created.json()) as CommentPayload;

    const editByOther = await call(
      buildTestApp(owner),
      "PATCH",
      `/api/v1/scans/${scanId}/comments/${payload.comment.id}`,
      { body: { body: "rewritten" }, activeOrganizationId: owner.personalOrganizationId },
    );
    expect(editByOther.status).toBe(403);

    // Owner (admin role) may delete another member's comment.
    const deleted = await call(
      buildTestApp(owner),
      "DELETE",
      `/api/v1/scans/${scanId}/comments/${payload.comment.id}`,
      { activeOrganizationId: owner.personalOrganizationId },
    );
    expect(deleted.status).toBe(200);

    const [row] = await db
      .select()
      .from(schema.scanComments)
      .where(eq(schema.scanComments.id, payload.comment.id));
    expect(row.deletedAt).not.toBeNull();

    const list = await call(buildTestApp(owner), "GET", `/api/v1/scans/${scanId}/comments`, {
      activeOrganizationId: owner.personalOrganizationId,
    });
    const listed = (await list.json()) as { comments: CommentPayload["comment"][] };
    const tombstone = listed.comments.find((comment) => comment.id === payload.comment.id);
    expect(tombstone?.deleted).toBe(true);
    expect(tombstone?.body).toBe("");
  });

  test("members cannot delete someone else's comment", async () => {
    const db = createDb(env.DB);
    const owner = await seedUser();
    const member = await seedUser();
    await addOrganizationMember(db, {
      organizationId: owner.personalOrganizationId,
      userId: member.userId,
      role: "member",
    });
    const scanId = await seedScan(owner.personalOrganizationId, owner.userId);

    const created = await call(buildTestApp(owner), "POST", `/api/v1/scans/${scanId}/comments`, {
      body: { body: "owner note" },
      activeOrganizationId: owner.personalOrganizationId,
    });
    const payload = (await created.json()) as CommentPayload;

    const deleted = await call(
      buildTestApp(member),
      "DELETE",
      `/api/v1/scans/${scanId}/comments/${payload.comment.id}`,
      { activeOrganizationId: owner.personalOrganizationId },
    );
    expect(deleted.status).toBe(403);
  });

  test("replies must reference a comment on the same scan", async () => {
    const owner = await seedUser();
    const scanId = await seedScan(owner.personalOrganizationId, owner.userId);
    const otherScanId = await seedScan(owner.personalOrganizationId, owner.userId);
    const app = buildTestApp(owner);

    const created = await call(app, "POST", `/api/v1/scans/${scanId}/comments`, {
      body: { body: "root" },
      activeOrganizationId: owner.personalOrganizationId,
    });
    const payload = (await created.json()) as CommentPayload;

    const crossScan = await call(app, "POST", `/api/v1/scans/${otherScanId}/comments`, {
      body: { body: "reply", parentId: payload.comment.id },
      activeOrganizationId: owner.personalOrganizationId,
    });
    expect(crossScan.status).toBe(400);

    const reply = await call(app, "POST", `/api/v1/scans/${scanId}/comments`, {
      body: { body: "reply", parentId: payload.comment.id },
      activeOrganizationId: owner.personalOrganizationId,
    });
    expect(reply.status).toBe(201);
  });

  test("comment bodies are length-capped", async () => {
    const owner = await seedUser();
    const scanId = await seedScan(owner.personalOrganizationId, owner.userId);

    const res = await call(buildTestApp(owner), "POST", `/api/v1/scans/${scanId}/comments`, {
      body: { body: "x".repeat(4001) },
      activeOrganizationId: owner.personalOrganizationId,
    });
    expect(res.status).toBe(400);
  });
});

describe("account notification settings routes", () => {
  test("defaults to mention emails on and persists the toggle", async () => {
    const user = await seedUser();
    const app = buildTestApp(user);

    const initial = await call(app, "GET", "/api/v1/account/notification-settings");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ settings: { mentionEmails: true } });

    const updated = await call(app, "PATCH", "/api/v1/account/notification-settings", {
      body: { mentionEmails: false },
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ settings: { mentionEmails: false } });

    const db = createDb(env.DB);
    expect(await getUserNotificationSettings(db, user.userId)).toEqual({ mentionEmails: false });

    const invalid = await call(app, "PATCH", "/api/v1/account/notification-settings", {
      body: { mentionEmails: "yes" },
    });
    expect(invalid.status).toBe(400);
  });
});

describe("deletion hygiene", () => {
  test("comment rows do not leak across scans", async () => {
    const db = createDb(env.DB);
    const owner = await seedUser();
    const scanId = await seedScan(owner.personalOrganizationId, owner.userId);
    const created = await call(buildTestApp(owner), "POST", `/api/v1/scans/${scanId}/comments`, {
      body: { body: "scoped" },
      activeOrganizationId: owner.personalOrganizationId,
    });
    expect(created.status).toBe(201);

    const rows = await db
      .select()
      .from(schema.scanComments)
      .where(
        and(
          eq(schema.scanComments.scanId, scanId),
          eq(schema.scanComments.organizationId, owner.personalOrganizationId),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});
