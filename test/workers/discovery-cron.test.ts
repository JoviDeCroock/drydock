import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createDb,
  ensurePersonalOrganization,
  updateNpmConnectionValidation,
  upsertNpmConnection,
} from "../../server/db";
import * as schema from "../../server/db/schema";
import { encryptNpmToken } from "../../server/lib/npm-connection";
import worker from "../../server/index";

const REGISTRY_URL = "https://registry.npmjs.org";
const STAGE_ID = "stage-aaaaaa";

type ValidationStatus = "valid" | "invalid" | "unvalidated";

interface SeededOrg {
  organizationId: string;
  userId: string;
  email: string;
  token: string;
}

async function seedOrg(input: {
  index: number;
  token: string;
  validationStatus: ValidationStatus;
}): Promise<SeededOrg> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.com`;
  await db.insert(schema.user).values({
    id: userId,
    name: `Tester ${input.index}`,
    email,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  const encrypted = await encryptNpmToken(env, input.token);
  await upsertNpmConnection(db, {
    organizationId,
    registryUrl: REGISTRY_URL,
    label: "npm registry",
    createdByUserId: userId,
    ...encrypted,
  });
  await updateNpmConnectionValidation(db, {
    organizationId,
    validationStatus: input.validationStatus,
    validatedAt: input.validationStatus === "valid" ? now : null,
  });
  return { organizationId, userId, email, token: input.token };
}

function scheduledController(): ScheduledController {
  return {
    scheduledTime: Date.now(),
    cron: "*/15 * * * *",
    noRetry() {},
  } as unknown as ScheduledController;
}

function authHeader(input: Request | string | URL, init?: RequestInit): string | null {
  const headers =
    input instanceof Request ? input.headers : new Headers(init?.headers ?? undefined);
  return headers.get("authorization");
}

describe("staged publishes discovery cron", () => {
  // The cron sweeps every eligible connection in the database, so a prior
  // test's seeded connections would otherwise be picked up here. Clear them so
  // each test's assertions reflect only the orgs it seeds.
  beforeEach(async () => {
    await createDb(env.DB).delete(schema.npmConnections);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("queues the valid org, records a per-org failure for the expired org, and skips the disabled org", async () => {
    // (a) live token + discovery on, (b) token that now 401s + discovery on,
    // (c) discovery off. There is no separate auto-discovery flag: the sweep
    // queries connections whose validationStatus is valid/unvalidated, so a
    // disabled connection is modelled as `invalid` and never appears.
    const orgA = await seedOrg({
      index: 0,
      token: "npm_valid_aaaaaaaaaaaa",
      validationStatus: "valid",
    });
    const orgB = await seedOrg({
      index: 1,
      token: "npm_expired_bbbbbbbbbb",
      validationStatus: "valid",
    });
    const orgC = await seedOrg({
      index: 2,
      token: "npm_disabled_cccccccc",
      validationStatus: "invalid",
    });

    const fetchMock = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      expect(url).toContain("/-/stage");
      const auth = authHeader(input, init);
      if (auth === `Bearer ${orgA.token}`) {
        return Response.json({
          items: [{ id: STAGE_ID, name: "demo-package", version: "1.0.0" }],
          total: 1,
          perPage: 50,
          page: 0,
        });
      }
      if (auth === `Bearer ${orgB.token}`) {
        return new Response("token expired", { status: 401 });
      }
      // The disabled org must never reach the registry; surface it loudly.
      throw new Error(`unexpected staged-list fetch for token ${auth}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const queue = { send: vi.fn(async () => undefined) };
    const ctx = createExecutionContext();
    await worker.scheduled(
      scheduledController(),
      { ...env, SCAN_QUEUE: queue } as unknown as Cloudflare.Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // (c) excluded entirely: only (a) and (b) are swept, so only two fetches.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // (a) only: exactly one scan enqueued, scoped to org A.
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send.mock.calls[0]![0]).toMatchObject({
      organizationId: orgA.organizationId,
      stageId: STAGE_ID,
      source: "auto_discovery",
    });

    // (b) expired token: structured per-org failure event, no crash.
    const failureCall = errorSpy.mock.calls.find(
      (call) => call[0] === "staged publishes cron sweep failed for organization",
    );
    expect(failureCall).toBeDefined();
    expect(failureCall![1]).toMatchObject({
      organizationId: orgB.organizationId,
      error: { status: 401 },
    });

    // (c) never queued nor errored.
    for (const call of queue.send.mock.calls) {
      expect(call[0]).not.toMatchObject({ organizationId: orgC.organizationId });
    }
    for (const call of errorSpy.mock.calls) {
      expect(call[1]).not.toMatchObject({ organizationId: orgC.organizationId });
    }

    // Sweep finished cleanly over the two eligible orgs.
    const sweptCall = logSpy.mock.calls.find((call) => call[0] === "staged_publishes.cron.swept");
    expect(sweptCall).toBeDefined();
    expect(sweptCall![1]).toMatchObject({ orgsProcessed: 2 });
  });

  test("dispatches an auto-discovery email for the valid org", async () => {
    // Email only fires downstream in executeScanJob, which the cron runs inline
    // (via waitUntil) when SCAN_QUEUE is absent. The inline scan fails fast
    // because the sandbox LOADER binding is not bound in tests; an
    // auto_discovery scan failure (not a staged_tarball_unavailable skip) sends
    // a completion email, so the SEND_EMAIL fake receives one message.
    const orgA = await seedOrg({
      index: 0,
      token: "npm_valid_aaaaaaaaaaaa",
      validationStatus: "valid",
    });

    const fetchMock = vi.fn(async (input: Request | string | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      expect(url).toContain("/-/stage");
      return Response.json({
        items: [{ id: STAGE_ID, name: "demo-package", version: "1.0.0" }],
        total: 1,
        perPage: 50,
        page: 0,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const send = vi.fn(async () => undefined);
    const ctx = createExecutionContext();
    await worker.scheduled(
      scheduledController(),
      { ...env, SEND_EMAIL: { send } } as unknown as Cloudflare.Env,
      ctx,
    );
    // Draining the context also settles the inline scan's waitUntil, which
    // rejects with the expected sandbox-LOADER error (no LOADER binding in
    // tests). The failure-notification email is dispatched before that
    // rejection, so swallow it and assert the email below.
    try {
      await waitOnExecutionContext(ctx);
    } catch {
      // expected: inline scan job rejects because the sandbox is unavailable.
    }

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect(orgA.email).toContain("@example.com");
  });
});
