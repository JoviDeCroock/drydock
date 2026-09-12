import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb } from "../../server/db/client";
import { getNpmConnection, upsertNpmConnection } from "../../server/db/npm-connections";
import { listScans } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { encryptNpmToken } from "../../server/lib/ecosystems/npm/connection";
import {
  enqueueDiscoverySweeps,
  isDiscoveryQueueMessage,
  type DiscoveryQueueMessage,
} from "../../server/lib/discovery/sweep-queue";
import type { ScanQueueMessage } from "../../server/lib/scan/job";
import worker from "../../server";

const REGISTRY_URL = "https://registry.npmjs.org";
const STAGE_ID = "stage-sweepqueue";
const TOKEN = "npm_sweep_token_0123456789";

type ValidationStatus = "valid" | "invalid" | "unvalidated";

interface SeededOrg {
  organizationId: string;
  connectionId: string;
  userId: string;
  email: string;
}

/**
 * Seed one organization with an npm connection, inserting the rows directly so a
 * test can afford a hundred of them. `ensurePersonalOrganization` is not used
 * here: the discovery producer only reads npm_connections, and the consumer only
 * additionally needs organizations.owner_user_id.
 */
async function seedOrg(input: {
  index: number;
  validationStatus: ValidationStatus;
  token?: string;
  connectionId?: string;
  organizationId?: string;
}): Promise<SeededOrg> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.com`;
  const organizationId = input.organizationId ?? `org_${crypto.randomUUID()}`;
  const connectionId = input.connectionId ?? `npmconn_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: `Tester ${input.index}`,
    email,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.organizations).values({
    id: organizationId,
    name: `Org ${input.index}`,
    ownerUserId: userId,
    createdAt: now,
    updatedAt: now,
  });
  const encrypted = await encryptNpmToken(env, input.token ?? TOKEN);
  await db.insert(schema.npmConnections).values({
    id: connectionId,
    organizationId,
    registryUrl: REGISTRY_URL,
    label: "npm registry",
    validationStatus: input.validationStatus,
    validatedAt: input.validationStatus === "valid" ? now : null,
    createdByUserId: userId,
    createdAt: now,
    updatedAt: now,
    ...encrypted,
  });
  return { organizationId, connectionId, userId, email };
}

function scheduledController(): ScheduledController {
  return {
    scheduledTime: Date.now(),
    cron: "*/15 * * * *",
    noRetry() {},
  } as unknown as ScheduledController;
}

function sweepBatch(organizationIds: string[], retry = vi.fn()) {
  return discoveryBatch(
    organizationIds.map(
      (organizationId) =>
        ({ kind: "discovery_sweep", organizationId }) satisfies DiscoveryQueueMessage,
    ),
    retry,
  );
}

function discoveryBatch(messages: DiscoveryQueueMessage[], retry = vi.fn()) {
  return {
    queue: "staged-publish-review-discovery",
    messages: messages.map((body, index) => ({
      id: `msg-${index}`,
      timestamp: new Date(),
      attempts: 1,
      body,
      retry,
      ack() {},
    })),
    retryAll() {},
    ackAll() {},
  } as unknown as MessageBatch<DiscoveryQueueMessage>;
}

function enqueuedOrganizationIds(sendBatch: ReturnType<typeof vi.fn>): string[] {
  return sendBatch.mock.calls.flatMap((call) =>
    (call[0] as Array<{ body: DiscoveryQueueMessage }>).map((entry) => entry.body.organizationId),
  );
}

async function eventTypesForOrg(organizationId: string): Promise<string[]> {
  const rows = await createDb(env.DB)
    .select({ type: schema.scanEvents.type })
    .from(schema.scanEvents)
    .where(eq(schema.scanEvents.organizationId, organizationId));
  return rows.map((row) => row.type);
}

/** A registry that lists one staged publish and allows the tarball probe. */
function stagedListFetchMock() {
  return vi.fn(async (input: Request | string | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    expect(url).toContain("/-/stage");
    if (url.endsWith(`/-/stage/${STAGE_ID}/tarball`)) return new Response("", { status: 206 });
    return Response.json({
      items: [{ id: STAGE_ID, name: "demo-package", version: "1.0.0" }],
      total: 1,
      perPage: 50,
      page: 0,
    });
  });
}

describe("discovery sweep producer", () => {
  beforeEach(async () => {
    await createDb(env.DB).delete(schema.npmConnections);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("enqueues one sweep per eligible org and sweeps nothing itself", async () => {
    const valid = await seedOrg({ index: 0, validationStatus: "valid" });
    const unvalidated = await seedOrg({ index: 1, validationStatus: "unvalidated" });
    const invalid = await seedOrg({ index: 2, validationStatus: "invalid" });

    // The tick must not touch the registry at all: that work belongs to the
    // consumer now. Any fetch here is a regression back to the O(orgs) tick.
    const fetchMock = vi.fn(async () => new Response("unexpected", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const sendBatch = vi.fn(async () => undefined);
    const ctx = createExecutionContext();
    await worker.scheduled(
      scheduledController(),
      { ...env, DISCOVERY_QUEUE: { sendBatch } } as unknown as Cloudflare.Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendBatch).toHaveBeenCalledTimes(1);
    const enqueued = enqueuedOrganizationIds(sendBatch);
    expect(enqueued).toHaveLength(2);
    expect(new Set(enqueued)).toEqual(new Set([valid.organizationId, unvalidated.organizationId]));
    expect(enqueued).not.toContain(invalid.organizationId);
    for (const call of sendBatch.mock.calls) {
      for (const entry of call[0] as Array<{ body: DiscoveryQueueMessage }>) {
        expect(entry.body.kind).toBe("discovery_sweep");
        // No credential material may ride along on a queue message.
        expect(Object.keys(entry.body).sort()).toEqual(["kind", "organizationId"]);
      }
    }

    const enqueuedLog = logSpy.mock.calls.find(
      (call) => call[0] === "staged_publishes.cron.enqueued",
    );
    expect(enqueuedLog).toBeDefined();
    expect(enqueuedLog![1]).toMatchObject({ organizations: 2, batches: 1, truncated: false });
    // The queue path replaces the inline sweep entirely.
    expect(logSpy.mock.calls.find((call) => call[0] === "staged_publishes.cron.swept")).toBe(
      undefined,
    );
  });

  test("uses the eligible-only partial index for the discovery cursor query", async () => {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT id, organization_id
       FROM npm_connections
       WHERE validation_status in ('valid', 'unvalidated') AND organization_id > ?
       ORDER BY organization_id
       LIMIT ?`,
    )
      .bind("org_cursor", 100)
      .all<{ detail: string }>();

    expect(plan.results.map((row) => row.detail).join("\n")).toContain(
      "npm_connections_discovery_cursor_idx",
    );
  });

  test("pages by stable organization id while connections change", async () => {
    // 101 eligible orgs: the cursor has to advance past the first full page, and
    // no single sendBatch may exceed the Queues limit of 100 messages. Updating
    // unvalidated rows after the first send simulates consumers validating the
    // connections while the producer is still enumerating later pages.
    const expected: string[] = [];
    const organizationPrefix = `org_${crypto.randomUUID()}_`;
    let tail: SeededOrg | null = null;
    for (let index = 0; index < 101; index++) {
      const seeded = await seedOrg({
        index,
        validationStatus: index % 2 === 0 ? "valid" : "unvalidated",
        connectionId: `npmconn_${String(index).padStart(4, "0")}`,
        organizationId: `${organizationPrefix}${String(index).padStart(4, "0")}`,
      });
      expected.push(seeded.organizationId);
      tail = seeded;
    }

    vi.spyOn(console, "log").mockImplementation(() => {});
    let batchesSent = 0;
    const sendBatch = vi.fn(async () => {
      batchesSent++;
      if (batchesSent !== 1) return;
      await createDb(env.DB)
        .update(schema.npmConnections)
        .set({ validationStatus: "valid" })
        .where(eq(schema.npmConnections.validationStatus, "unvalidated"));
      // Replacing the only row still beyond the cursor rotates its connection
      // id. Pagination must remain anchored to the immutable organization id.
      const encrypted = await encryptNpmToken(env, "npm_replacement_token_0123456789");
      await upsertNpmConnection(createDb(env.DB), {
        organizationId: tail!.organizationId,
        registryUrl: REGISTRY_URL,
        label: "replacement registry",
        createdByUserId: tail!.userId,
        ...encrypted,
      });
    });
    const ctx = createExecutionContext();
    await worker.scheduled(
      scheduledController(),
      { ...env, DISCOVERY_QUEUE: { sendBatch } } as unknown as Cloudflare.Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(sendBatch.mock.calls[0]![0]).toHaveLength(100);
    expect(sendBatch.mock.calls[1]![0]).toHaveLength(1);
    const enqueued = enqueuedOrganizationIds(sendBatch);
    expect(enqueued).toHaveLength(101);
    expect(new Set(enqueued).size).toBe(101);
    expect(enqueued).toEqual(expected);
  });

  test("retries a throughput rejection without starving later cursor pages", async () => {
    const expected: string[] = [];
    const organizationPrefix = `org_${crypto.randomUUID()}_`;
    for (let index = 0; index < 101; index++) {
      const seeded = await seedOrg({
        index,
        validationStatus: "valid",
        connectionId: `npmconn_${String(index).padStart(4, "0")}`,
        organizationId: `${organizationPrefix}${String(index).padStart(4, "0")}`,
      });
      expected.push(seeded.organizationId);
    }

    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const delivered: Array<{ body: DiscoveryQueueMessage }> = [];
    let attempts = 0;
    const sendBatch = vi.fn(async (batch: Array<{ body: DiscoveryQueueMessage }>) => {
      attempts++;
      if (attempts === 2) throw new Error("429 Too Many Requests");
      delivered.push(...batch);
    });
    const queueEnv = { ...env, DISCOVERY_QUEUE: { sendBatch } } as unknown as Cloudflare.Env;

    await enqueueDiscoverySweeps(queueEnv, createExecutionContext(), {
      queueRetryBaseDelayMs: 1,
    });

    expect(sendBatch).toHaveBeenCalledTimes(3);
    expect(delivered.map((entry) => entry.body.organizationId)).toEqual(expected);
    expect(
      warnSpy.mock.calls.find(
        (call) => call[0] === "staged_publishes.discovery_queue.rate_limited",
      )?.[1],
    ).toMatchObject({
      operation: "sweep_enumeration",
      messages: 1,
      attempt: 1,
      nextDelayMs: 1,
    });
  });

  test("does not replay an ambiguous queue send failure", async () => {
    await seedOrg({ index: 0, validationStatus: "valid" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sendBatch = vi.fn(async () => {
      throw new Error("connection reset after send");
    });
    const queueEnv = { ...env, DISCOVERY_QUEUE: { sendBatch } } as unknown as Cloudflare.Env;

    await expect(enqueueDiscoverySweeps(queueEnv, createExecutionContext())).rejects.toThrowError(
      "connection reset after send",
    );
    expect(sendBatch).toHaveBeenCalledTimes(1);
  });

  test("flags truncation only when the page budget actually leaves orgs behind", async () => {
    // Exhausting the page budget on an exact page boundary is not truncation:
    // an org count that happens to be a multiple of the page size must not raise
    // an error-level alarm every tick. One page of budget, then exactly one full
    // page of orgs, then one more org so the same budget really does truncate.
    const organizationPrefix = `org_${crypto.randomUUID()}_`;
    for (let index = 0; index < 100; index++) {
      await seedOrg({
        index,
        validationStatus: "valid",
        connectionId: `npmconn_${String(index).padStart(4, "0")}`,
        organizationId: `${organizationPrefix}${String(index).padStart(4, "0")}`,
      });
    }
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sendBatch = vi.fn(async () => undefined);
    const queueEnv = { ...env, DISCOVERY_QUEUE: { sendBatch } } as unknown as Cloudflare.Env;

    const ctx = createExecutionContext();
    await enqueueDiscoverySweeps(queueEnv, ctx, { maxPages: 1 });
    await waitOnExecutionContext(ctx);

    const boundaryLog = logSpy.mock.calls.find(
      (call) => call[0] === "staged_publishes.cron.enqueued",
    );
    expect(boundaryLog![1]).toMatchObject({ organizations: 100, batches: 1, truncated: false });
    expect(
      errorSpy.mock.calls.find((call) => call[0] === "staged_publishes.cron.enqueued"),
    ).toBeUndefined();

    await seedOrg({
      index: 100,
      validationStatus: "valid",
      connectionId: "npmconn_0100",
      organizationId: `${organizationPrefix}0100`,
    });
    const secondCtx = createExecutionContext();
    await enqueueDiscoverySweeps(queueEnv, secondCtx, { maxPages: 1 });
    await waitOnExecutionContext(secondCtx);

    const truncatedLog = errorSpy.mock.calls.find(
      (call) => call[0] === "staged_publishes.cron.enqueued",
    );
    expect(truncatedLog).toBeDefined();
    expect(truncatedLog![1]).toMatchObject({ organizations: 100, batches: 1, truncated: true });
  });

  test("logs and completes the tick when the enumeration read fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const brokenDb = {
      prepare(): never {
        throw new Error("D1_ERROR: simulated outage");
      },
    } as unknown as D1Database;
    const sendBatch = vi.fn(async () => undefined);

    const ctx = createExecutionContext();
    await worker.scheduled(
      scheduledController(),
      { ...env, DB: brokenDb, DISCOVERY_QUEUE: { sendBatch } } as unknown as Cloudflare.Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(sendBatch).not.toHaveBeenCalled();
    const events = errorSpy.mock.calls.map((call) => call[0]);
    expect(events).toContain("staged_publishes.cron.failed");
    // Audit pruning still runs (and fails against the same broken binding).
    expect(events).toContain("audit_events.prune_failed");
  });
});

describe("discovery sweep consumer", () => {
  beforeEach(async () => {
    await createDb(env.DB).delete(schema.npmConnections);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("sweeps the org in the message and queues the discovered scan", async () => {
    const org = await seedOrg({ index: 0, validationStatus: "valid" });
    vi.stubGlobal("fetch", stagedListFetchMock());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const scanQueue = { sendBatch: vi.fn(async () => undefined) };
    const ctx = createExecutionContext();
    await worker.queue(
      sweepBatch([org.organizationId]),
      { ...env, SCAN_QUEUE: scanQueue } as unknown as Cloudflare.Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(scanQueue.sendBatch).toHaveBeenCalledTimes(1);
    expect(scanQueue.sendBatch.mock.calls[0]![0]).toMatchObject([
      {
        body: {
          organizationId: org.organizationId,
          stageId: STAGE_ID,
          connectionId: org.connectionId,
          source: "auto_discovery",
        },
      },
    ]);
    const { scans } = await listScans(createDb(env.DB), org.organizationId);
    expect(scans.map((scan) => scan.stageId)).toEqual([STAGE_ID]);

    const completed = logSpy.mock.calls.find(
      (call) => call[0] === "staged_publishes.cron.org_completed",
    );
    expect(completed).toBeDefined();
    expect(completed![1]).toMatchObject({
      organizationId: org.organizationId,
      found: 1,
      created: 1,
    });
  });

  test("fans large listings into sibling batches without re-listing or recursive sends", async () => {
    const org = await seedOrg({ index: 0, validationStatus: "valid" });
    const stagedItems = Array.from({ length: 160 }, (_, index) => ({
      id: `stage-${String(index).padStart(3, "0")}`,
      name: `demo-${index}`,
      version: "1.0.0",
    }));
    const fetchMock = vi.fn(async (input: Request | string | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/-/stage?")) {
        return Response.json({ items: stagedItems, total: 160, perPage: 50, page: 0 });
      }
      expect(url).toMatch(/\/-\/stage\/stage-\d{3}\/tarball$/);
      return new Response("", { status: 206 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const scanQueue = { sendBatch: vi.fn(async () => undefined) };
    const discoverySendBatch = vi.fn(async () => undefined);
    const queueEnv = {
      ...env,
      SCAN_QUEUE: scanQueue,
      DISCOVERY_QUEUE: { sendBatch: discoverySendBatch },
    } as unknown as Cloudflare.Env;

    const initialCtx = createExecutionContext();
    await worker.queue(sweepBatch([org.organizationId]), queueEnv, initialCtx);
    await waitOnExecutionContext(initialCtx);

    expect(scanQueue.sendBatch).toHaveBeenCalledTimes(1);
    expect(scanQueue.sendBatch.mock.calls[0]![0]).toHaveLength(50);
    expect(discoverySendBatch).toHaveBeenCalledTimes(2);
    const candidateMessages = discoverySendBatch.mock.calls.flatMap(
      ([batch]) => batch as Array<{ body: DiscoveryQueueMessage }>,
    );
    expect(candidateMessages).toHaveLength(3);
    expect(candidateMessages[0]!.body).toMatchObject({
      kind: "discovery_scan_batch",
      organizationId: org.organizationId,
      connectionId: org.connectionId,
      source: "auto_discovery",
      actorUserId: org.userId,
    });
    if (candidateMessages[0]!.body.kind !== "discovery_scan_batch") {
      throw new Error("expected a discovery candidate batch");
    }
    expect(
      candidateMessages.map((entry) =>
        entry.body.kind === "discovery_scan_batch" ? entry.body.candidates.length : 0,
      ),
    ).toEqual([50, 50, 10]);

    discoverySendBatch.mockClear();
    for (const candidateMessage of candidateMessages) {
      const candidateCtx = createExecutionContext();
      await worker.queue(discoveryBatch([candidateMessage.body]), queueEnv, candidateCtx);
      await waitOnExecutionContext(candidateCtx);
    }

    expect(scanQueue.sendBatch).toHaveBeenCalledTimes(4);
    expect(scanQueue.sendBatch.mock.calls.map(([batch]) => batch.length)).toEqual([50, 50, 50, 10]);
    expect(discoverySendBatch).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).includes("/-/stage?")),
    ).toHaveLength(1);
    const persisted = await createDb(env.DB)
      .select({ id: schema.scans.id })
      .from(schema.scans)
      .where(eq(schema.scans.organizationId, org.organizationId));
    expect(persisted).toHaveLength(160);
  });

  test("drops candidate batches after the npm connection is replaced", async () => {
    const org = await seedOrg({ index: 0, validationStatus: "valid" });
    const replacementToken = await encryptNpmToken(env, "npm_replacement_token_0123456789");
    const replacement = await upsertNpmConnection(createDb(env.DB), {
      organizationId: org.organizationId,
      registryUrl: "https://replacement-registry.example.com",
      label: "replacement registry",
      createdByUserId: org.userId,
      ...replacementToken,
    });
    expect(replacement?.id).not.toBe(org.connectionId);

    const fetchMock = vi.fn(async () => new Response("unexpected", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const candidateMessage = {
      kind: "discovery_scan_batch",
      organizationId: org.organizationId,
      connectionId: org.connectionId,
      source: "auto_discovery",
      actorUserId: org.userId,
      candidates: [{ stageId: STAGE_ID, packageName: "old-package", version: "1.0.0" }],
    } satisfies DiscoveryQueueMessage;

    const ctx = createExecutionContext();
    await worker.queue(discoveryBatch([candidateMessage]), env as Cloudflare.Env, ctx);
    await waitOnExecutionContext(ctx);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await listScans(createDb(env.DB), org.organizationId)).scans).toHaveLength(0);
    expect(
      logSpy.mock.calls.find((call) => call[0] === "staged_publishes.cron.skipped")?.[1],
    ).toMatchObject({
      organizationId: org.organizationId,
      reason: "npm_connection_replaced",
    });
  });

  test("discards a scan when its connection is replaced after candidate dispatch", async () => {
    const org = await seedOrg({ index: 0, validationStatus: "valid" });
    const fetchMock = stagedListFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const scanQueue = { sendBatch: vi.fn(async () => undefined) };
    const queueEnv = { ...env, SCAN_QUEUE: scanQueue } as unknown as Cloudflare.Env;
    const candidateMessage = {
      kind: "discovery_scan_batch",
      organizationId: org.organizationId,
      connectionId: org.connectionId,
      source: "auto_discovery",
      actorUserId: org.userId,
      candidates: [{ stageId: STAGE_ID, packageName: "old-package", version: "1.0.0" }],
    } satisfies DiscoveryQueueMessage;

    const candidateCtx = createExecutionContext();
    await worker.queue(discoveryBatch([candidateMessage]), queueEnv, candidateCtx);
    await waitOnExecutionContext(candidateCtx);
    const scanMessage = (
      scanQueue.sendBatch.mock.calls[0]![0] as Array<{ body: ScanQueueMessage }>
    )[0].body;
    expect(scanMessage.connectionId).toBe(org.connectionId);

    const replacementToken = await encryptNpmToken(env, "npm_replacement_token_0123456789");
    await upsertNpmConnection(createDb(env.DB), {
      organizationId: org.organizationId,
      registryUrl: "https://replacement-registry.example.com",
      label: "replacement registry",
      createdByUserId: org.userId,
      ...replacementToken,
    });
    fetchMock.mockClear();

    const scanCtx = createExecutionContext();
    await worker.queue(
      {
        queue: "staged-publish-review-scans",
        messages: [
          {
            id: "scan-message",
            timestamp: new Date(),
            attempts: 1,
            body: scanMessage,
            retry: vi.fn(),
            ack() {},
          },
        ],
        retryAll() {},
        ackAll() {},
      } as unknown as MessageBatch<ScanQueueMessage>,
      queueEnv,
      scanCtx,
    );
    await waitOnExecutionContext(scanCtx);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await listScans(createDb(env.DB), org.organizationId)).scans).toHaveLength(0);
    expect(warnSpy.mock.calls.find((call) => call[0] === "scan.job.skipped")?.[1]).toMatchObject({
      organizationId: org.organizationId,
      reason: "npm_connection_replaced",
    });
  });

  test("does not re-create a scan the org already has for that stage id", async () => {
    const org = await seedOrg({ index: 0, validationStatus: "valid" });
    vi.stubGlobal("fetch", stagedListFetchMock());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const scanQueue = { sendBatch: vi.fn(async () => undefined) };

    for (const _run of [1, 2]) {
      const ctx = createExecutionContext();
      await worker.queue(
        sweepBatch([org.organizationId]),
        { ...env, SCAN_QUEUE: scanQueue } as unknown as Cloudflare.Env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
    }

    // Per-org dedup is `listExistingScanStageIds`, which survives the move to
    // per-message sweeps: the second delivery creates nothing.
    expect(scanQueue.sendBatch).toHaveBeenCalledTimes(1);
    const { scans } = await listScans(createDb(env.DB), org.organizationId);
    expect(scans).toHaveLength(1);
    const completions = logSpy.mock.calls
      .filter((call) => call[0] === "staged_publishes.cron.org_completed")
      .map((call) => call[1] as { created: number; skipped: number });
    expect(completions).toMatchObject([
      { created: 1, skipped: 0 },
      { created: 0, skipped: 1 },
    ]);
  });

  test("lets two orgs scan the same stage id, one message each", async () => {
    // Cross-org duplicate scans of one staged publish are intended (each org
    // owns its own review and decision), which is why the removed
    // StageStartCoordinator is not needed on the queue path.
    const orgA = await seedOrg({ index: 0, validationStatus: "valid" });
    const orgB = await seedOrg({ index: 1, validationStatus: "valid" });
    vi.stubGlobal("fetch", stagedListFetchMock());
    vi.spyOn(console, "log").mockImplementation(() => {});

    const scanQueue = { sendBatch: vi.fn(async () => undefined) };
    const ctx = createExecutionContext();
    await worker.queue(
      sweepBatch([orgA.organizationId, orgB.organizationId]),
      { ...env, SCAN_QUEUE: scanQueue } as unknown as Cloudflare.Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const db = createDb(env.DB);
    expect((await listScans(db, orgA.organizationId)).scans.map((scan) => scan.stageId)).toEqual([
      STAGE_ID,
    ]);
    expect((await listScans(db, orgB.organizationId)).scans.map((scan) => scan.stageId)).toEqual([
      STAGE_ID,
    ]);
    expect(scanQueue.sendBatch).toHaveBeenCalledTimes(2);
  });

  test("keeps a registry 500 a transient warning and never retries the message", async () => {
    const org = await seedOrg({ index: 0, validationStatus: "valid" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream boom", { status: 500 })),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const retry = vi.fn();
    const ctx = createExecutionContext();
    await worker.queue(sweepBatch([org.organizationId], retry), env as Cloudflare.Env, ctx);
    await waitOnExecutionContext(ctx);

    const failure = warnSpy.mock.calls.find(
      (call) => call[0] === "staged_publishes.cron.org_failed",
    );
    expect(failure).toBeDefined();
    expect(failure![1]).toMatchObject({
      organizationId: org.organizationId,
      transient: true,
      error: { status: 500 },
    });
    expect(
      errorSpy.mock.calls.find((call) => call[0] === "staged_publishes.cron.org_failed"),
    ).toBeUndefined();
    // The next tick re-enqueues the org, so a queue retry would only duplicate
    // work — and a thrown message would poison the whole batch.
    expect(retry).not.toHaveBeenCalled();
    const connection = await getNpmConnection(createDb(env.DB), org.organizationId);
    expect(connection?.validationStatus).toBe("valid");
  });

  test("keeps a non-transient registry failure at error level", async () => {
    const org = await seedOrg({ index: 0, validationStatus: "valid" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ctx = createExecutionContext();
    await worker.queue(sweepBatch([org.organizationId]), env as Cloudflare.Env, ctx);
    await waitOnExecutionContext(ctx);

    const failure = errorSpy.mock.calls.find(
      (call) => call[0] === "staged_publishes.cron.org_failed",
    );
    expect(failure).toBeDefined();
    expect(failure![1]).toMatchObject({
      organizationId: org.organizationId,
      transient: false,
      error: { status: 404 },
    });
    expect(
      warnSpy.mock.calls.find((call) => call[0] === "staged_publishes.cron.org_failed"),
    ).toBeUndefined();
  });

  test("invalidates and alerts on an expired token instead of logging a sweep failure", async () => {
    const org = await seedOrg({ index: 0, validationStatus: "valid" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("token expired", { status: 401 })),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const send = vi.fn(async () => undefined);
    const ctx = createExecutionContext();
    await worker.queue(
      sweepBatch([org.organizationId]),
      { ...env, SEND_EMAIL: { send } } as unknown as Cloudflare.Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const connection = await getNpmConnection(createDb(env.DB), org.organizationId);
    expect(connection?.validationStatus).toBe("invalid");
    const events = await eventTypesForOrg(org.organizationId);
    expect(events).toContain("npm_connection.token_expired");
    expect(events).toContain("npm_connection.notification_sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      errorSpy.mock.calls.find((call) => call[0] === "staged_publishes.cron.org_failed"),
    ).toBeUndefined();
  });

  test("alerts only once when duplicate deliveries observe the same expired token", async () => {
    const org = await seedOrg({ index: 0, validationStatus: "valid" });
    let requestsStarted = 0;
    let releaseRequests!: () => void;
    const bothRequestsStarted = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        requestsStarted++;
        if (requestsStarted === 2) releaseRequests();
        await bothRequestsStarted;
        return new Response("token expired", { status: 401 });
      }),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const send = vi.fn(async () => undefined);
    const queueEnv = { ...env, SEND_EMAIL: { send } } as unknown as Cloudflare.Env;
    const ctxA = createExecutionContext();
    const ctxB = createExecutionContext();

    await Promise.all([
      worker.queue(sweepBatch([org.organizationId]), queueEnv, ctxA),
      worker.queue(sweepBatch([org.organizationId]), queueEnv, ctxB),
    ]);
    await Promise.all([waitOnExecutionContext(ctxA), waitOnExecutionContext(ctxB)]);

    const connection = await getNpmConnection(createDb(env.DB), org.organizationId);
    expect(connection?.validationStatus).toBe("invalid");
    const events = await eventTypesForOrg(org.organizationId);
    expect(events.filter((type) => type === "npm_connection.token_expired")).toHaveLength(1);
    expect(events.filter((type) => type === "npm_connection.notification_sent")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("skips a message whose connection vanished before delivery", async () => {
    const org = await seedOrg({ index: 0, validationStatus: "valid" });
    await createDb(env.DB)
      .delete(schema.npmConnections)
      .where(eq(schema.npmConnections.organizationId, org.organizationId));
    const fetchMock = vi.fn(async () => new Response("unexpected", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const ctx = createExecutionContext();
    await worker.queue(sweepBatch([org.organizationId]), env as Cloudflare.Env, ctx);
    await waitOnExecutionContext(ctx);

    expect(fetchMock).not.toHaveBeenCalled();
    const skipped = logSpy.mock.calls.find((call) => call[0] === "staged_publishes.cron.skipped");
    expect(skipped).toBeDefined();
    expect(skipped![1]).toMatchObject({
      organizationId: org.organizationId,
      reason: "npm_connection_missing",
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("skips a message whose connection was invalidated before delivery", async () => {
    const org = await seedOrg({ index: 0, validationStatus: "invalid" });
    const fetchMock = vi.fn(async () => new Response("unexpected", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const ctx = createExecutionContext();
    await worker.queue(sweepBatch([org.organizationId]), env as Cloudflare.Env, ctx);
    await waitOnExecutionContext(ctx);

    expect(fetchMock).not.toHaveBeenCalled();
    const skipped = logSpy.mock.calls.find((call) => call[0] === "staged_publishes.cron.skipped");
    expect(skipped![1]).toMatchObject({
      organizationId: org.organizationId,
      reason: "npm_connection_invalid",
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("queue message routing guard", () => {
  beforeEach(async () => {
    await createDb(env.DB).delete(schema.npmConnections);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function batchOn(queue: string, body: unknown) {
    return {
      queue,
      messages: [
        { id: "msg-0", timestamp: new Date(), attempts: 1, body, retry: vi.fn(), ack() {} },
      ],
      retryAll() {},
      ackAll() {},
    } as unknown as MessageBatch<DiscoveryQueueMessage>;
  }

  test("accepts only bounded candidate-batch messages", () => {
    expect(
      isDiscoveryQueueMessage({
        kind: "discovery_scan_batch",
        organizationId: "org_x",
        connectionId: "connection_x",
        source: "manual",
        actorUserId: "user_x",
        candidates: [{ stageId: "stage_50", packageName: "demo", version: "1.0.0" }],
      }),
    ).toBe(true);
    expect(
      isDiscoveryQueueMessage({
        kind: "discovery_scan_batch",
        organizationId: "org_x",
        source: "manual",
        actorUserId: "user_x",
        candidates: [{ stageId: "stage_50", packageName: "demo", version: "1.0.0" }],
      }),
    ).toBe(false);
    expect(
      isDiscoveryQueueMessage({
        kind: "discovery_scan_batch",
        organizationId: "org_x",
        connectionId: "connection_x",
        source: "manual",
        actorUserId: "user_x",
        candidates: Array.from({ length: 51 }, (_, index) => ({
          stageId: `stage_${index}`,
          packageName: "demo",
          version: "1.0.0",
        })),
      }),
    ).toBe(false);
    expect(
      isDiscoveryQueueMessage({
        kind: "discovery_scan_batch",
        organizationId: "org_x",
        connectionId: "connection_x",
        source: "manual",
        actorUserId: "user_x",
        candidates: [{ stageId: "stage_50", packageName: "x".repeat(513), version: "1.0.0" }],
      }),
    ).toBe(false);
  });

  test("drops an unrecognized message kind instead of running the scan handler", async () => {
    // Before the explicit guard this body fell through to executeScanJob and ran
    // it with undefined ids — and on the discovery queue (no dead-letter queue)
    // it would then be dropped with no record of why.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response("unexpected", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createExecutionContext();
    await worker.queue(
      batchOn("staged-publish-review-scans", { kind: "release_sentinel", organizationId: "org_x" }),
      env as Cloudflare.Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const dropped = errorSpy.mock.calls.find((call) => call[0] === "queue.message.unknown_kind");
    expect(dropped).toBeDefined();
    expect(dropped![1]).toMatchObject({
      queue: "staged-publish-review-scans",
      kind: "release_sentinel",
      reason: "unrecognized_body",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    // No scan handler ran, so no scan lifecycle event was logged either.
    expect(
      errorSpy.mock.calls.find((call) => call[0] === "scan.queue.message_failed"),
    ).toBeUndefined();
  });

  test.each([
    ["null", null, null],
    ["a primitive", "orphaned-message", null],
    [
      "an incomplete workflow gate",
      { kind: "workflow_gate", organizationId: "org_x" },
      "workflow_gate",
    ],
  ])("drops %s body without invoking a typed handler", async (_label, body, kind) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const ctx = createExecutionContext();
    await worker.queue(batchOn("staged-publish-review-scans", body), env as Cloudflare.Env, ctx);
    await waitOnExecutionContext(ctx);

    const dropped = errorSpy.mock.calls.find((call) => call[0] === "queue.message.unknown_kind");
    expect(dropped![1]).toMatchObject({
      queue: "staged-publish-review-scans",
      kind,
      reason: "unrecognized_body",
    });
    expect(
      errorSpy.mock.calls.find((call) => call[0] === "workflow_gate.queue.message_failed"),
    ).toBeUndefined();
  });

  test("refuses a discovery sweep that arrives on the scan queue", async () => {
    const org = await seedOrg({ index: 0, validationStatus: "valid" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response("unexpected", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createExecutionContext();
    await worker.queue(
      batchOn("staged-publish-review-scans", {
        kind: "discovery_sweep",
        organizationId: org.organizationId,
      }),
      env as Cloudflare.Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // The sweep must not run from the wrong consumer: no registry traffic.
    expect(fetchMock).not.toHaveBeenCalled();
    const dropped = errorSpy.mock.calls.find((call) => call[0] === "queue.message.unknown_kind");
    expect(dropped![1]).toMatchObject({
      queue: "staged-publish-review-scans",
      kind: "discovery_sweep",
      reason: "sweep_off_discovery_queue",
    });
  });

  test("refuses a scan message that arrives on the discovery queue", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const ctx = createExecutionContext();
    await worker.queue(
      batchOn("staged-publish-review-discovery", {
        scanId: "scan_x",
        organizationId: "org_x",
        stageId: "stage_x",
        actorUserId: "user_x",
      }),
      env as Cloudflare.Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const dropped = errorSpy.mock.calls.find((call) => call[0] === "queue.message.unknown_kind");
    expect(dropped![1]).toMatchObject({
      queue: "staged-publish-review-discovery",
      kind: null,
      reason: "non_sweep_on_discovery_queue",
    });
    // The scan handler never claimed it, so no skip/failure event was emitted.
    expect([...errorSpy.mock.calls].some((call) => String(call[0]).startsWith("scan."))).toBe(
      false,
    );
  });

  test("drops a malformed discovery sweep instead of treating it as completed", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response("unexpected", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createExecutionContext();
    await worker.queue(
      batchOn("staged-publish-review-discovery", { kind: "discovery_sweep" }),
      env as Cloudflare.Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const dropped = errorSpy.mock.calls.find((call) => call[0] === "queue.message.unknown_kind");
    expect(dropped![1]).toMatchObject({
      queue: "staged-publish-review-discovery",
      kind: "discovery_sweep",
      reason: "non_sweep_on_discovery_queue",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      logSpy.mock.calls.find(
        (call) => call[0] === "staged_publishes.sweep.queue.message.completed",
      ),
    ).toBeUndefined();
  });
});
