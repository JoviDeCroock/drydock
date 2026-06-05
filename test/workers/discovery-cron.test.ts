import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  createDb,
  ensurePersonalOrganization,
  getNpmConnection,
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
  connectionCreatorUserId: string;
  connectionCreatorEmail: string;
}

async function seedOrg(input: {
  index: number;
  token: string;
  validationStatus: ValidationStatus;
  connectionCreator?: "owner" | "other";
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
  let connectionCreatorUserId = userId;
  let connectionCreatorEmail = email;
  if (input.connectionCreator === "other") {
    connectionCreatorUserId = `user_${crypto.randomUUID()}`;
    connectionCreatorEmail = `${connectionCreatorUserId}@example.com`;
    await db.insert(schema.user).values({
      id: connectionCreatorUserId,
      name: `Connection Creator ${input.index}`,
      email: connectionCreatorEmail,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  }
  const encrypted = await encryptNpmToken(env, input.token);
  await upsertNpmConnection(db, {
    organizationId,
    registryUrl: REGISTRY_URL,
    label: "npm registry",
    createdByUserId: connectionCreatorUserId,
    ...encrypted,
  });
  await updateNpmConnectionValidation(db, {
    organizationId,
    validationStatus: input.validationStatus,
    validatedAt: input.validationStatus === "valid" ? now : null,
  });
  return {
    organizationId,
    userId,
    email,
    token: input.token,
    connectionCreatorUserId,
    connectionCreatorEmail,
  };
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

async function eventTypesForOrg(organizationId: string): Promise<string[]> {
  const rows = await createDb(env.DB)
    .select({ type: schema.scanEvents.type })
    .from(schema.scanEvents)
    .where(eq(schema.scanEvents.organizationId, organizationId));
  return rows.map((row) => row.type);
}

async function eventMetadataForOrg(
  organizationId: string,
  type: string,
): Promise<Record<string, unknown> | null> {
  const rows = await createDb(env.DB)
    .select({ type: schema.scanEvents.type, metadata: schema.scanEvents.metadataJson })
    .from(schema.scanEvents)
    .where(eq(schema.scanEvents.organizationId, organizationId));
  const match = rows.find((candidate) => candidate.type === type);
  return (match?.metadata as Record<string, unknown> | null) ?? null;
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

  test("queues the valid org, alerts the expired org, and skips the disabled org", async () => {
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
      connectionCreator: "other",
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
    const send = vi.fn(async () => undefined);
    const ctx = createExecutionContext();
    await worker.scheduled(
      scheduledController(),
      { ...env, SCAN_QUEUE: queue, SEND_EMAIL: { send } } as unknown as Cloudflare.Env,
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

    // (b) expired token: marked invalid, audited, and the maintainer emailed —
    // not a silent skip. No unhandled crash logged.
    const orgBConnection = await getNpmConnection(createDb(env.DB), orgB.organizationId);
    expect(orgBConnection?.validationStatus).toBe("invalid");
    const orgBEvents = await eventTypesForOrg(orgB.organizationId);
    expect(orgBEvents).toContain("npm_connection.token_expired");
    expect(orgBEvents).toContain("npm_connection.notification_sent");
    expect(send).toHaveBeenCalledTimes(1);
    const sentMeta = await eventMetadataForOrg(
      orgB.organizationId,
      "npm_connection.notification_sent",
    );
    expect(sentMeta).toMatchObject({ recipient: orgB.email });
    expect(sentMeta).not.toMatchObject({ recipient: orgB.connectionCreatorEmail });
    const genericFailureForOrgB = errorSpy.mock.calls.find(
      (call) =>
        call[0] === "staged_publishes.cron.org_failed" &&
        (call[1] as { organizationId?: string })?.organizationId === orgB.organizationId,
    );
    expect(genericFailureForOrgB).toBeUndefined();

    // (c) never queued, errored, nor emailed.
    for (const call of queue.send.mock.calls) {
      expect(call[0]).not.toMatchObject({ organizationId: orgC.organizationId });
    }
    expect(await eventTypesForOrg(orgC.organizationId)).toHaveLength(0);

    // Sweep finished cleanly over the two eligible orgs.
    const sweptCall = logSpy.mock.calls.find((call) => call[0] === "staged_publishes.cron.swept");
    expect(sweptCall).toBeDefined();
    expect(sweptCall![1]).toMatchObject({ orgsProcessed: 2 });
  });

  test("logs a generic per-org failure for a non-auth registry error without alerting", async () => {
    // A 500 from the registry is transient infrastructure, not an expired token:
    // the connection must stay valid (so the next sweep retries it) and no
    // maintenance email goes out.
    const org = await seedOrg({
      index: 0,
      token: "npm_valid_aaaaaaaaaaaa",
      validationStatus: "valid",
    });

    const fetchMock = vi.fn(async () => new Response("upstream boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const send = vi.fn(async () => undefined);
    const ctx = createExecutionContext();
    await worker.scheduled(
      scheduledController(),
      { ...env, SEND_EMAIL: { send } } as unknown as Cloudflare.Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const failureCall = errorSpy.mock.calls.find(
      (call) => call[0] === "staged_publishes.cron.org_failed",
    );
    expect(failureCall).toBeDefined();
    expect(failureCall![1]).toMatchObject({
      event: "staged_publishes.cron.org_failed",
      organizationId: org.organizationId,
      error: { status: 500 },
    });

    const connection = await getNpmConnection(createDb(env.DB), org.organizationId);
    expect(connection?.validationStatus).toBe("valid");
    expect(send).not.toHaveBeenCalled();
    expect(await eventTypesForOrg(org.organizationId)).not.toContain(
      "npm_connection.token_expired",
    );
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
