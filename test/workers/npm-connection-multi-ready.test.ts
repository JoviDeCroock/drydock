import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import {
  createDb,
  ensurePersonalOrganization,
  getNpmConnection,
  listNpmConnections,
  upsertNpmConnection,
} from "../../server/db";
import * as schema from "../../server/db/schema";
import { encryptNpmToken } from "../../server/lib/npm-connection";

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

async function saveConnection(input: {
  organizationId: string;
  userId: string;
  token: string;
  registryUrl?: string;
  label?: string;
}) {
  const db = createDb(env.DB);
  const encrypted = await encryptNpmToken(env, input.token);
  await upsertNpmConnection(db, {
    organizationId: input.organizationId,
    registryUrl: input.registryUrl ?? "https://registry.npmjs.org",
    label: input.label ?? "npm registry",
    createdByUserId: input.userId,
    ...encrypted,
  });
}

describe("npm-connection multi-connection schema", () => {
  test("first save creates a single active connection", async () => {
    const owner = await seedUser();
    await saveConnection({
      organizationId: owner.organizationId,
      userId: owner.userId,
      token: "npm_multi_token_AAAAAAAAAAAAAA",
    });

    const db = createDb(env.DB);
    const connections = await listNpmConnections(db, owner.organizationId);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.isActive).toBe(true);

    const active = await getNpmConnection(db, owner.organizationId);
    expect(active?.id).toBe(connections[0]?.id);
  });

  test("rotate updates the existing active row in place (no stale rows)", async () => {
    const owner = await seedUser();

    await saveConnection({
      organizationId: owner.organizationId,
      userId: owner.userId,
      token: "npm_multi_token_AAAAAAAAAAAAAA",
      label: "first",
    });
    const db = createDb(env.DB);
    const beforeRotate = await getNpmConnection(db, owner.organizationId);

    await saveConnection({
      organizationId: owner.organizationId,
      userId: owner.userId,
      token: "npm_multi_token_BBBBBBBBBBBBBB",
      label: "second",
    });
    const afterRotate = await getNpmConnection(db, owner.organizationId);

    expect(afterRotate?.id).toBe(beforeRotate?.id);
    expect(afterRotate?.label).toBe("second");
    expect(afterRotate?.tokenFingerprint).not.toBe(beforeRotate?.tokenFingerprint);

    const all = await listNpmConnections(db, owner.organizationId);
    expect(all).toHaveLength(1);
  });

  test("getNpmConnection ignores rows where isActive=false", async () => {
    const owner = await seedUser();
    await saveConnection({
      organizationId: owner.organizationId,
      userId: owner.userId,
      token: "npm_multi_token_AAAAAAAAAAAAAA",
    });

    const db = createDb(env.DB);
    const active = await getNpmConnection(db, owner.organizationId);
    expect(active).not.toBeNull();

    await db
      .update(schema.npmConnections)
      .set({ isActive: false })
      .where(eq(schema.npmConnections.organizationId, owner.organizationId));

    const after = await getNpmConnection(db, owner.organizationId);
    expect(after).toBeNull();

    const all = await listNpmConnections(db, owner.organizationId);
    expect(all).toHaveLength(1);
    expect(all[0]?.isActive).toBe(false);
  });
});
