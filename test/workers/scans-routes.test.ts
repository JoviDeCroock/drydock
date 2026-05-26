import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import {
  createDb,
  ensurePersonalOrganization,
  updateNpmConnectionValidation,
  upsertNpmConnection,
} from "../../server/db";
import * as schema from "../../server/db/schema";
import { encryptNpmToken } from "../../server/lib/npm-connection";
import { scansRoutes } from "../../server/routes/scans";
import type { Bindings, Variables } from "../../server/types";

type NpmValidationStatus = "valid" | "invalid" | "capability_limited" | "unvalidated";

async function seedUser() {
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

async function seedNpmConnection(input: {
  organizationId: string;
  userId: string;
  validationStatus: NpmValidationStatus;
}) {
  const db = createDb(env.DB);
  const encrypted = await encryptNpmToken(env, "npm_test_token_0123456789");
  await upsertNpmConnection(db, {
    organizationId: input.organizationId,
    registryUrl: "https://registry.npmjs.org",
    label: "npm registry",
    createdByUserId: input.userId,
    ...encrypted,
  });
  await updateNpmConnectionValidation(db, {
    organizationId: input.organizationId,
    validationStatus: input.validationStatus,
    validatedAt: input.validationStatus === "valid" ? new Date() : null,
  });
}

async function requestScan(session: { userId: string }) {
  const app = buildTestApp(session);
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request("http://test.local/api/v1/scans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stageId: "stage-token-123" }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("scans route credential errors", () => {
  test("POST /api/v1/scans returns token_missing when no npm connection exists", async () => {
    const owner = await seedUser();

    const res = await requestScan(owner);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: "token_missing",
    });
  });

  test.each([
    ["unvalidated", "token_unvalidated"],
    ["invalid", "token_invalid"],
    ["capability_limited", "token_capability_limited"],
  ] satisfies Array<[NpmValidationStatus, string]>)(
    "POST /api/v1/scans returns %s credential code",
    async (validationStatus, code) => {
      const owner = await seedUser();
      await seedNpmConnection({
        organizationId: owner.organizationId,
        userId: owner.userId,
        validationStatus,
      });

      const res = await requestScan(owner);

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        code,
        validationStatus,
      });
    },
  );
});
