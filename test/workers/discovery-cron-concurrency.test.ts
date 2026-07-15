import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import {
  updateNpmConnectionValidation,
  upsertNpmConnection,
} from "../../server/db/npm-connections";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import * as schema from "../../server/db/schema";
import { encryptNpmToken } from "../../server/lib/npm-connection";
import worker from "../../server/index";

const CONCURRENCY_LIMIT = 5;

async function seedOrgWithValidConnection(index: number): Promise<string> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: `Tester ${index}`,
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  const encrypted = await encryptNpmToken(env, "npm_test_token_0123456789");
  await upsertNpmConnection(db, {
    organizationId,
    registryUrl: "https://registry.npmjs.org",
    label: "npm registry",
    createdByUserId: userId,
    ...encrypted,
  });
  await updateNpmConnectionValidation(db, {
    organizationId,
    validationStatus: "valid",
    validatedAt: now,
  });
  return organizationId;
}

describe("discovery cron concurrency", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("emits the swept event when there are no orgs to process", async () => {
    const fetchMock = vi.fn(async () => Response.json({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = createExecutionContext();
    const controller = {
      scheduledTime: Date.now(),
      cron: "*/15 * * * *",
      noRetry() {},
    } as unknown as ScheduledController;

    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(fetchMock).not.toHaveBeenCalled();
    const sweptCall = logSpy.mock.calls.find(
      (call) => call[0]?.event?.name === "staged_publishes.cron.swept",
    );
    expect(sweptCall).toBeDefined();
    expect(sweptCall![0]).toMatchObject({
      measurements: {
        orgs_processed: 0,
        concurrency_limit: CONCURRENCY_LIMIT,
      },
    });
  });

  test("sweeps every org with bounded in-flight concurrency", async () => {
    const orgCount = 20;
    for (let i = 0; i < orgCount; i++) await seedOrgWithValidConnection(i);

    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain("/-/stage");
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // A real delay keeps each sweep pending long enough that overlap is
      // observable; otherwise immediate resolution masks the parallelism.
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return Response.json({ items: [], total: 0, perPage: 50, page: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const queue = { send: vi.fn(async () => undefined) };
    const ctx = createExecutionContext();
    const controller = {
      scheduledTime: Date.now(),
      cron: "*/15 * * * *",
      noRetry() {},
    } as unknown as ScheduledController;

    await worker.scheduled(
      controller,
      { ...env, SCAN_QUEUE: queue } as unknown as Cloudflare.Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(fetchMock).toHaveBeenCalledTimes(orgCount);
    expect(maxInFlight).toBeLessThanOrEqual(CONCURRENCY_LIMIT);
    expect(maxInFlight).toBe(CONCURRENCY_LIMIT);

    const sweptCall = logSpy.mock.calls.find(
      (call) => call[0]?.event?.name === "staged_publishes.cron.swept",
    );
    expect(sweptCall).toBeDefined();
    const sweptFields = sweptCall![0]?.measurements as {
      orgs_processed: number;
      duration_ms: number;
      concurrency_limit: number;
    };
    expect(sweptFields).toMatchObject({
      orgs_processed: orgCount,
      concurrency_limit: CONCURRENCY_LIMIT,
    });
    expect(sweptFields.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
