import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createDb } from "../../server/db/client";
import { AUTH_ROW_RETENTION_GRACE_MS, pruneExpiredAuthRows } from "../../server/db/auth-retention";
import * as schema from "../../server/db/schema";
import worker from "../../server";

const HOUR_MS = 60 * 60 * 1000;

function scheduledController(): ScheduledController {
  return {
    scheduledTime: Date.now(),
    cron: "*/15 * * * *",
    noRetry() {},
  } as unknown as ScheduledController;
}

async function seedUser(): Promise<string> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Retention Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  return userId;
}

async function seedSession(userId: string, expiresAt: Date): Promise<string> {
  const db = createDb(env.DB);
  const now = new Date();
  const id = `session_${crypto.randomUUID()}`;
  await db.insert(schema.session).values({
    id,
    token: `token_${crypto.randomUUID()}`,
    userId,
    expiresAt,
    ipAddress: "203.0.113.7",
    userAgent: "drydock-test/1.0",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function seedVerification(expiresAt: Date): Promise<string> {
  const db = createDb(env.DB);
  const now = new Date();
  const id = `verification_${crypto.randomUUID()}`;
  await db.insert(schema.verification).values({
    id,
    identifier: `identifier_${crypto.randomUUID()}`,
    value: "verification-value",
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function sessionIds(ids: string[]): Promise<string[]> {
  const rows = await createDb(env.DB)
    .select({ id: schema.session.id })
    .from(schema.session)
    .where(inArray(schema.session.id, ids));
  return rows.map((row) => row.id);
}

async function verificationIds(ids: string[]): Promise<string[]> {
  const rows = await createDb(env.DB)
    .select({ id: schema.verification.id })
    .from(schema.verification)
    .where(inArray(schema.verification.id, ids));
  return rows.map((row) => row.id);
}

describe("expired auth row retention", () => {
  beforeEach(async () => {
    const db = createDb(env.DB);
    await db.delete(schema.session);
    await db.delete(schema.verification);
    vi.restoreAllMocks();
  });

  test("deletes only rows past expiry plus the grace period", async () => {
    const userId = await seedUser();
    const now = new Date();

    const live = await seedSession(userId, new Date(now.getTime() + 7 * 24 * HOUR_MS));
    // Expired, but inside the grace window: Better Auth may still be refreshing
    // it, so the sweep leaves it alone.
    const justExpired = await seedSession(userId, new Date(now.getTime() - HOUR_MS));
    const longExpired = await seedSession(
      userId,
      new Date(now.getTime() - AUTH_ROW_RETENTION_GRACE_MS - HOUR_MS),
    );

    const liveToken = await seedVerification(new Date(now.getTime() + HOUR_MS));
    const staleToken = await seedVerification(
      new Date(now.getTime() - AUTH_ROW_RETENTION_GRACE_MS - HOUR_MS),
    );

    const pruned = await pruneExpiredAuthRows(createDb(env.DB), now);

    expect(pruned).toEqual({ sessions: 1, verifications: 1, moreRemaining: false });
    expect((await sessionIds([live, justExpired, longExpired])).sort()).toEqual(
      [live, justExpired].sort(),
    );
    expect(await verificationIds([liveToken, staleToken])).toEqual([liveToken]);
  });

  test("keeps the surviving session usable", async () => {
    const userId = await seedUser();
    const now = new Date();
    const live = await seedSession(userId, new Date(now.getTime() + 7 * 24 * HOUR_MS));
    await seedSession(userId, new Date(now.getTime() - AUTH_ROW_RETENTION_GRACE_MS - HOUR_MS));

    await pruneExpiredAuthRows(createDb(env.DB), now);

    const [row] = await createDb(env.DB)
      .select()
      .from(schema.session)
      .where(eq(schema.session.id, live));
    expect(row?.userId).toBe(userId);
    expect(row?.ipAddress).toBe("203.0.113.7");
  });

  test("is a no-op when nothing has aged out", async () => {
    const userId = await seedUser();
    const now = new Date();
    await seedSession(userId, new Date(now.getTime() + HOUR_MS));

    expect(await pruneExpiredAuthRows(createDb(env.DB), now)).toEqual({
      sessions: 0,
      verifications: 0,
      // Both sweeps are batched now; nothing eligible means nothing left over.
      moreRemaining: false,
    });
  });

  test("the scheduled tick sweeps expired rows", async () => {
    const userId = await seedUser();
    const now = Date.now();
    const stale = await seedSession(
      userId,
      new Date(now - AUTH_ROW_RETENTION_GRACE_MS - 7 * 24 * HOUR_MS),
    );
    const live = await seedSession(userId, new Date(now + 7 * 24 * HOUR_MS));

    // The discovery sweep runs first on the same tick; it has no connections to
    // walk here and must not stop pruning from happening.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = createExecutionContext();
    await worker.scheduled(scheduledController(), env as Cloudflare.Env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await sessionIds([stale, live])).toEqual([live]);
  });

  test("a prune failure is logged and never thrown", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const brokenDb = {
      delete() {
        throw new Error("d1 unavailable");
      },
    } as unknown as ReturnType<typeof createDb>;

    await expect(pruneExpiredAuthRows(brokenDb)).rejects.toThrow("d1 unavailable");

    // The scheduled wrapper is what swallows it: a broken DB binding must not
    // take the cron down.
    const ctx = createExecutionContext();
    await worker.scheduled(
      scheduledController(),
      { ...env, DB: undefined } as unknown as Cloudflare.Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(errorSpy.mock.calls.some((call) => call[0] === "auth_rows.prune_failed")).toBe(true);
  });
});
