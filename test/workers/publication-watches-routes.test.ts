import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { scans, user } from "../../server/db/schema";
import { publicationWatchRoutes } from "../../server/routes/publication-watches";
import type { Bindings, Variables } from "../../server/types";

async function seedOwner() {
  const db = createDb(env.DB);
  const userId = crypto.randomUUID();
  const now = new Date();
  await db.insert(user).values({
    id: userId,
    name: "Publication reviewer",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, organizationId };
}

async function request(
  owner: { userId: string },
  method: string,
  path = "",
  body?: unknown,
  requestedOrganizationId?: string,
) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", owner);
    await next();
  });
  app.route("/api/v1/publication-watches", publicationWatchRoutes);
  const headers = new Headers({ "content-type": "application/json" });
  if (requestedOrganizationId) headers.set("x-organization-id", requestedOrganizationId);
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(`http://example.com/api/v1/publication-watches${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

test("enrolls a public package without an existing scan or npm connection", async () => {
  const owner = await seedOwner();
  const created = await request(owner, "POST", "", { packageName: "@scope/new-package" });
  expect(created.status).toBe(201);
  const { watch } = await created.json<{
    watch: { id: string; packageName: string; createdAt: string };
  }>();
  expect(watch.packageName).toBe("@scope/new-package");
  expect(Number.isFinite(Date.parse(watch.createdAt))).toBe(true);
  const listed = await request(owner, "GET");
  expect(listed.headers.get("cache-control")).toBe("private, no-store");
  expect(await listed.json()).toMatchObject({ watches: [{ id: watch.id }] });
  const detail = await request(owner, "GET", `/${watch.id}`);
  expect(await detail.json()).toMatchObject({ watch: { id: watch.id }, observations: [] });
  expect((await request(owner, "DELETE", `/${watch.id}`)).status).toBe(200);
  expect((await request(owner, "GET", `/${watch.id}`)).status).toBe(404);
});

test("watch IDs and organization selectors never grant access to another organization", async () => {
  const owner = await seedOwner();
  const outsider = await seedOwner();
  const created = await request(owner, "POST", "", { packageName: "preact" });
  const { watch } = await created.json<{ watch: { id: string } }>();
  for (const [method, suffix] of [
    ["GET", ""],
    ["DELETE", ""],
    ["POST", "/check"],
  ]) {
    const response = await request(
      outsider,
      method!,
      `/${watch.id}${suffix}`,
      undefined,
      owner.organizationId!,
    );
    expect(response.status).toBe(404);
  }
  const response = await request(outsider, "GET", "", undefined, owner.organizationId!);
  expect(await response.json()).toMatchObject({
    watches: [],
    autoEnrollment: { deferred: 0, suggestions: [] },
  });
  expect((await request(owner, "GET", `/${watch.id}`)).status).toBe(200);
});

test("rejects URL and malformed package enrollment and preserves enrollment time on duplicates", async () => {
  const owner = await seedOwner();
  for (const packageName of ["https://example.com/pkg", "../package", "bad name", "", 42]) {
    expect((await request(owner, "POST", "", { packageName })).status).toBe(400);
  }
  const first = await request(owner, "POST", "", { packageName: "preact" });
  const second = await request(owner, "POST", "", { packageName: "preact" });
  expect(await second.json()).toEqual(await first.json());
});

test("GET derives historical public publishers, preserves opt-out and permits explicit reenrollment", async () => {
  const owner = await seedOwner();
  const now = new Date();
  await createDb(env.DB)
    .insert(scans)
    .values({
      id: crypto.randomUUID(),
      stageId: "stage-auto-history",
      organizationId: owner.organizationId!,
      source: "auto_discovery",
      status: "complete",
      packageName: "@scope/history",
      stagedVersion: "1.0.0",
      registryUrl: "https://registry.npmjs.org",
      registryPackageName: "@scope/history",
      registryVersion: "1.0.0",
      registryVersionStatus: "published",
      registryVersionStatusAt: now,
      summaryJson: { stagedPublish: { access: "public" } },
      createdAt: new Date(0),
      updatedAt: now,
    });
  const listed = await request(owner, "GET");
  const body = await listed.json<{
    watches: Array<{ id: string; source: string; createdAt: string }>;
    autoEnrollment: { deferred: number };
  }>();
  expect(body.watches).toHaveLength(1);
  expect(body.watches[0]?.source).toBe("published_history");
  expect(Date.parse(body.watches[0]!.createdAt)).toBeGreaterThanOrEqual(now.getTime());
  expect(body.autoEnrollment.deferred).toBe(0);
  await request(owner, "DELETE", `/${body.watches[0]!.id}`);
  expect(await (await request(owner, "GET")).json()).toMatchObject({ watches: [] });
  const reenrolled = await request(owner, "POST", "", { packageName: "@scope/history" });
  expect(await reenrolled.json()).toMatchObject({ watch: { source: "manual" } });
  expect(await (await request(owner, "GET")).json()).toMatchObject({
    watches: [{ source: "manual" }],
  });
});
