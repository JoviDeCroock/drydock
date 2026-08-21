import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import {
  getNpmConnection,
  markNpmConnectionUsedIfStale,
  upsertNpmConnection,
} from "../../server/db/npm-connections";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import * as schema from "../../server/db/schema";
import {
  NPM_CONNECTION_USE_DEBOUNCE_MS,
  encryptNpmToken,
  getOrganizationNpmToken,
  npmConnectionUseIsStale,
} from "../../server/lib/ecosystems/npm/connection";

const TOKEN = "npm_last_used_debounce_token_AAAA";

async function seedConnection(): Promise<string> {
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
  const encrypted = await encryptNpmToken(env, TOKEN);
  await upsertNpmConnection(db, {
    organizationId,
    registryUrl: "https://registry.npmjs.org",
    label: "test registry",
    createdByUserId: userId,
    ...encrypted,
  });
  return organizationId;
}

async function setLastUsedAt(organizationId: string, lastUsedAt: Date | null): Promise<void> {
  await createDb(env.DB)
    .update(schema.npmConnections)
    .set({ lastUsedAt })
    .where(eq(schema.npmConnections.organizationId, organizationId));
}

async function readLastUsedAt(organizationId: string): Promise<Date | null> {
  const connection = await getNpmConnection(createDb(env.DB), organizationId);
  const value = connection?.lastUsedAt ?? null;
  return value === null ? null : new Date(value);
}

describe("npm connection last_used_at debounce", () => {
  test("writes on first use and then skips writes inside the debounce window", async () => {
    const organizationId = await seedConnection();
    const db = createDb(env.DB);

    // Never used: the first token read stamps the row.
    expect(await readLastUsedAt(organizationId)).toBeNull();
    await getOrganizationNpmToken(db, env, organizationId);
    const firstWrite = await readLastUsedAt(organizationId);
    expect(firstWrite).not.toBeNull();

    // A reviewer paging through a diff can issue hundreds of these a minute; the
    // hot row must be written once, not once per request.
    for (let i = 0; i < 25; i++) {
      const token = await getOrganizationNpmToken(db, env, organizationId);
      expect(token?.token).toBe(TOKEN);
    }
    expect((await readLastUsedAt(organizationId))?.getTime()).toBe(firstWrite?.getTime());
  });

  test("writes again once the stored value falls outside the window", async () => {
    const organizationId = await seedConnection();
    const db = createDb(env.DB);
    const stale = new Date(Date.now() - NPM_CONNECTION_USE_DEBOUNCE_MS - 1000);
    await setLastUsedAt(organizationId, stale);

    await getOrganizationNpmToken(db, env, organizationId);

    const refreshed = await readLastUsedAt(organizationId);
    expect(refreshed?.getTime()).toBeGreaterThan(stale.getTime());
  });

  test("only one concurrent stale observer mutates the row", async () => {
    const organizationId = await seedConnection();
    const db = createDb(env.DB);
    const now = new Date();
    const staleBefore = new Date(now.getTime() - NPM_CONNECTION_USE_DEBOUNCE_MS);

    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        markNpmConnectionUsedIfStale(db, organizationId, staleBefore, now),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await readLastUsedAt(organizationId))?.getTime()).toBe(now.getTime());
  });
});

describe("npmConnectionUseIsStale", () => {
  const now = 1_800_000_000_000;

  test("treats a never-used connection as stale", () => {
    expect(npmConnectionUseIsStale(null, now)).toBe(true);
    expect(npmConnectionUseIsStale(undefined, now)).toBe(true);
  });

  test("treats an unparseable timestamp as stale rather than skipping forever", () => {
    expect(npmConnectionUseIsStale("not a date", now)).toBe(true);
  });

  test("is exclusive of the window boundary and accepts Date, number, and string", () => {
    const boundary = now - NPM_CONNECTION_USE_DEBOUNCE_MS;
    expect(npmConnectionUseIsStale(new Date(boundary), now)).toBe(true);
    expect(npmConnectionUseIsStale(boundary + 1, now)).toBe(false);
    expect(npmConnectionUseIsStale(new Date(boundary + 1).toISOString(), now)).toBe(false);
  });

  test("never spends a write to correct a future timestamp", () => {
    expect(npmConnectionUseIsStale(now + 60_000, now)).toBe(false);
  });
});
