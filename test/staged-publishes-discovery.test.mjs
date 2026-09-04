import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const dbMock = vi.hoisted(() => ({
  createScanJob: vi.fn(),
  deletePendingScanJobs: vi.fn(),
  invalidateNpmConnectionIfCurrent: vi.fn(),
  listExistingScanStageIds: vi.fn(),
  markNpmConnectionUsed: vi.fn(),
  recordScanEvent: vi.fn(),
  updateNpmConnectionValidationIfCurrent: vi.fn(),
}));
const npmConnectionMock = vi.hoisted(() => ({
  decryptNpmToken: vi.fn(),
  validateNpmCredential: vi.fn(),
}));
const stagedPublishesMock = vi.hoisted(() => ({
  checkStagedPublishAccess: vi.fn(),
  listStagedPublishes: vi.fn(),
  StagedPublishesFetchError: class StagedPublishesFetchError extends Error {},
}));
const scanJobMock = vi.hoisted(() => ({ executeScanJob: vi.fn() }));
const releaseOutcomeMock = vi.hoisted(() => ({ resolveNpmReleaseOutcomes: vi.fn() }));

vi.mock("../server/db/events.ts", () => dbMock);
vi.mock("../server/db/npm-connections.ts", () => dbMock);
vi.mock("../server/db/scans.ts", () => dbMock);
vi.mock("../server/lib/ecosystems/npm/connection.ts", () => npmConnectionMock);
vi.mock("../server/lib/ecosystems/npm/staged-publishes.ts", () => stagedPublishesMock);
vi.mock("../server/lib/scan/job.ts", () => scanJobMock);
vi.mock("../server/lib/ecosystems/npm/release-outcome.ts", () => releaseOutcomeMock);

const {
  ensureUsableNpmConnection,
  discoverAndQueueStagedPublishes,
  queueStagedPublishCandidates,
  InvalidNpmConnectionError,
  isNpmConnectionAuthFailure,
  isTransientSweepFailure,
} = await import("../server/lib/ecosystems/npm/staged-publishes-discovery.ts");

const env = {
  DB: {},
  SCAN_QUEUE: { sendBatch: vi.fn() },
  DISCOVERY_QUEUE: { send: vi.fn() },
};

/** Every message body handed to SCAN_QUEUE.sendBatch, flattened across batches. */
function sentScanMessages() {
  return env.SCAN_QUEUE.sendBatch.mock.calls.flatMap(([batch]) => batch.map((entry) => entry.body));
}
const ctx = { waitUntil: vi.fn() };
const db = {};

beforeEach(() => {
  stagedPublishesMock.checkStagedPublishAccess.mockResolvedValue({
    allowed: true,
    status: 206,
    detail: null,
  });
  npmConnectionMock.decryptNpmToken.mockResolvedValue("npm_secret_token");
  npmConnectionMock.validateNpmCredential.mockResolvedValue({
    ok: true,
    status: "valid",
    capabilities: { registryAuth: true, stagedListAccess: true, registryUrl: "" },
  });
  releaseOutcomeMock.resolveNpmReleaseOutcomes.mockResolvedValue({
    checked: 0,
    resolved: 0,
    statuses: {},
    reminded: 0,
  });
  dbMock.invalidateNpmConnectionIfCurrent.mockResolvedValue(true);
  dbMock.updateNpmConnectionValidationIfCurrent.mockResolvedValue(true);
});

afterEach(() => {
  for (const fn of [
    ...Object.values(dbMock),
    ...Object.values(npmConnectionMock),
    ...Object.values(stagedPublishesMock),
    ...Object.values(scanJobMock),
    ...Object.values(releaseOutcomeMock),
  ]) {
    if (typeof fn?.mockReset === "function") fn.mockReset();
  }
  env.SCAN_QUEUE.sendBatch.mockReset();
  env.DISCOVERY_QUEUE.send.mockReset();
  ctx.waitUntil.mockReset();
});

describe("ensureUsableNpmConnection token state branching", () => {
  test("returns the decrypted token without revalidating a valid connection", async () => {
    const result = await ensureUsableNpmConnection({
      db,
      env,
      connection: {
        id: "connection_a",
        organizationId: "org_a",
        registryUrl: "https://registry.npmjs.org",
        validationStatus: "valid",
        tokenCiphertext: "x",
        tokenNonce: "y",
      },
      actorUserId: "user_a",
    });

    expect(result).toEqual({
      token: "npm_secret_token",
      registryUrl: "https://registry.npmjs.org",
      connectionId: "connection_a",
    });
    expect(npmConnectionMock.validateNpmCredential).not.toHaveBeenCalled();
    expect(dbMock.updateNpmConnectionValidationIfCurrent).not.toHaveBeenCalled();
  });

  test("rejects invalid connections without contacting the registry", async () => {
    await expect(
      ensureUsableNpmConnection({
        db,
        env,
        connection: {
          id: "connection_a",
          organizationId: "org_a",
          registryUrl: "https://registry.npmjs.org",
          validationStatus: "invalid",
          tokenCiphertext: "x",
          tokenNonce: "y",
        },
        actorUserId: "user_a",
      }),
    ).rejects.toBeInstanceOf(InvalidNpmConnectionError);

    expect(npmConnectionMock.validateNpmCredential).not.toHaveBeenCalled();
  });

  test("validates an unvalidated connection and persists the result on success", async () => {
    const result = await ensureUsableNpmConnection({
      db,
      env,
      connection: {
        id: "connection_a",
        organizationId: "org_a",
        registryUrl: "https://registry.npmjs.org",
        validationStatus: "unvalidated",
        tokenCiphertext: "x",
        tokenNonce: "y",
      },
      actorUserId: "user_a",
    });

    expect(result.token).toBe("npm_secret_token");
    expect(npmConnectionMock.validateNpmCredential).toHaveBeenCalledTimes(1);
    expect(dbMock.updateNpmConnectionValidationIfCurrent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        organizationId: "org_a",
        connectionId: "connection_a",
        expectedValidationStatus: "unvalidated",
        validationStatus: "valid",
      }),
    );
  });

  test("does not return an old token when validation loses a connection-generation race", async () => {
    dbMock.updateNpmConnectionValidationIfCurrent.mockResolvedValueOnce(false);

    await expect(
      ensureUsableNpmConnection({
        db,
        env,
        connection: {
          id: "connection_a",
          organizationId: "org_a",
          registryUrl: "https://registry.npmjs.org",
          validationStatus: "unvalidated",
          tokenCiphertext: "x",
          tokenNonce: "y",
        },
        actorUserId: "user_a",
      }),
    ).rejects.toBeInstanceOf(InvalidNpmConnectionError);

    expect(dbMock.recordScanEvent).not.toHaveBeenCalled();
  });

  test("marks unvalidated connections as invalid when validation fails with an auth status", async () => {
    npmConnectionMock.validateNpmCredential.mockResolvedValueOnce({
      ok: false,
      status: "invalid",
      capabilities: {
        registryAuth: false,
        stagedListAccess: false,
        registryUrl: "",
        status: 401,
      },
    });

    const failure = await ensureUsableNpmConnection({
      db,
      env,
      connection: {
        id: "connection_a",
        organizationId: "org_a",
        registryUrl: "https://registry.npmjs.org",
        validationStatus: "unvalidated",
        tokenCiphertext: "x",
        tokenNonce: "y",
      },
      actorUserId: "user_a",
    }).catch((err) => err);

    expect(failure).toBeInstanceOf(InvalidNpmConnectionError);
    expect(isNpmConnectionAuthFailure(failure)).toBe(true);
    expect(failure.expirationClaimed).toBe(true);
    expect(dbMock.invalidateNpmConnectionIfCurrent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ organizationId: "org_a", connectionId: "connection_a" }),
    );
  });

  test("keeps unvalidated connections retryable when validation fails without auth status", async () => {
    npmConnectionMock.validateNpmCredential.mockResolvedValueOnce({
      ok: false,
      status: "invalid",
      capabilities: {
        registryAuth: false,
        stagedListAccess: false,
        registryUrl: "",
        status: 500,
        stagedListStatus: 500,
      },
    });

    const failure = await ensureUsableNpmConnection({
      db,
      env,
      connection: {
        id: "connection_a",
        organizationId: "org_a",
        registryUrl: "https://registry.npmjs.org",
        validationStatus: "unvalidated",
        tokenCiphertext: "x",
        tokenNonce: "y",
      },
      actorUserId: "user_a",
    }).catch((err) => err);

    expect(failure).toBeInstanceOf(InvalidNpmConnectionError);
    expect(isNpmConnectionAuthFailure(failure)).toBe(false);
    expect(dbMock.updateNpmConnectionValidationIfCurrent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ organizationId: "org_a", validationStatus: "unvalidated" }),
    );
  });

  test("keeps unvalidated connections retryable when validation has no status", async () => {
    npmConnectionMock.validateNpmCredential.mockResolvedValueOnce({
      ok: false,
      status: "invalid",
      capabilities: {
        registryAuth: false,
        stagedListAccess: false,
        registryUrl: "",
        detail: "fetch failed",
      },
    });

    await expect(
      ensureUsableNpmConnection({
        db,
        env,
        connection: {
          id: "connection_a",
          organizationId: "org_a",
          registryUrl: "https://registry.npmjs.org",
          validationStatus: "unvalidated",
          tokenCiphertext: "x",
          tokenNonce: "y",
        },
        actorUserId: "user_a",
      }),
    ).rejects.toBeInstanceOf(InvalidNpmConnectionError);

    const failure = dbMock.updateNpmConnectionValidationIfCurrent.mock.calls[0];
    expect(failure).toBeDefined();
    expect(dbMock.updateNpmConnectionValidationIfCurrent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ organizationId: "org_a", validationStatus: "unvalidated" }),
    );
  });
});

describe("discoverAndQueueStagedPublishes", () => {
  test("awaits a bounded release-outcome slice during cron discovery", async () => {
    stagedPublishesMock.listStagedPublishes.mockResolvedValue({ items: [] });
    dbMock.listExistingScanStageIds.mockResolvedValue(new Set());
    let finishOutcome;
    releaseOutcomeMock.resolveNpmReleaseOutcomes.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOutcome = resolve;
        }),
    );

    let settled = false;
    const discovery = discoverAndQueueStagedPublishes(
      {
        db,
        env,
        executionCtx: ctx,
        organizationId: "org_a",
        actorUserId: "user_a",
        source: "auto_discovery",
        eventSource: "staged_publishes.cron",
        awaitReleaseOutcomes: true,
      },
      { token: "npm_secret_token", registryUrl: "https://registry.npmjs.org" },
    ).then((result) => {
      settled = true;
      return result;
    });
    await flushPromises();

    expect(settled).toBe(false);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(releaseOutcomeMock.resolveNpmReleaseOutcomes).toHaveBeenCalledWith(
      expect.objectContaining({ lookupLimit: 8, lookupConcurrency: 1 }),
    );

    finishOutcome({ checked: 0, resolved: 0, statuses: {}, reminded: 0 });
    await expect(discovery).resolves.toEqual(
      expect.objectContaining({ found: 0, created: 0, skipped: 0 }),
    );
  });

  test("resolves outcomes for existing stages but defers unprepared new candidates", async () => {
    const existing = { id: "stage-existing", packageName: "pkg-existing", version: "1.0.0" };
    const newCandidates = Array.from({ length: 51 }, (_, index) => ({
      id: `stage-new-${index}`,
      packageName: `pkg-new-${index}`,
      version: "1.0.0",
    }));
    stagedPublishesMock.listStagedPublishes.mockResolvedValue({
      items: [existing, ...newCandidates],
    });
    dbMock.listExistingScanStageIds.mockResolvedValue(new Set([existing.id]));
    dbMock.createScanJob.mockResolvedValue({ id: "scan-new" });
    const scheduleCandidateBatches = vi.fn();

    const result = await discoverAndQueueStagedPublishes(
      {
        db,
        env,
        executionCtx: ctx,
        organizationId: "org_a",
        actorUserId: "user_a",
        source: "auto_discovery",
        eventSource: "staged_publishes.cron",
        scheduleCandidateBatches,
        awaitReleaseOutcomes: true,
      },
      {
        token: "npm_secret_token",
        registryUrl: "https://registry.npmjs.org",
        connectionId: "connection_a",
      },
    );

    expect(result).toEqual(expect.objectContaining({ created: 50, deferred: 1 }));
    const outcomeInput = releaseOutcomeMock.resolveNpmReleaseOutcomes.mock.calls[0][0];
    expect(outcomeInput.stagedItems.map((item) => item.id)).toEqual([
      existing.id,
      ...newCandidates.slice(0, 50).map((item) => item.id),
    ]);
    expect(outcomeInput.stagedItems).not.toContainEqual(newCandidates[50]);
  });

  test("queues new stages with the auto_discovery source and skips already-known ones", async () => {
    stagedPublishesMock.listStagedPublishes.mockResolvedValue({
      items: [
        {
          id: "stage-new-1",
          packageName: "pkg-a",
          version: "1.0.0",
          tag: "latest",
          access: "public",
          actor: "octocat",
          createdAt: "2026-05-26T00:00:00.000Z",
        },
        {
          id: "stage-existing",
          packageName: "pkg-b",
          version: "2.0.0",
          tag: null,
          access: null,
          actor: null,
          createdAt: null,
        },
      ],
    });
    dbMock.listExistingScanStageIds.mockResolvedValue(new Set(["stage-existing"]));
    dbMock.createScanJob.mockResolvedValue({ id: "scan-new-1" });

    const result = await discoverAndQueueStagedPublishes(
      {
        db,
        env,
        executionCtx: ctx,
        organizationId: "org_a",
        actorUserId: "user_a",
        source: "auto_discovery",
        eventSource: "staged_publishes.cron",
      },
      {
        token: "npm_secret_token",
        registryUrl: "https://registry.npmjs.org",
        connectionId: "connection_a",
      },
    );

    expect(result).toEqual(
      expect.objectContaining({ found: 2, created: 1, skipped: 1, queued: true }),
    );
    expect(result.scans).toHaveLength(1);
    expect(result.scans[0]).toEqual(
      expect.objectContaining({ stageId: "stage-new-1", packageName: "pkg-a" }),
    );

    expect(dbMock.createScanJob).toHaveBeenCalledTimes(1);
    expect(dbMock.createScanJob).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        source: "auto_discovery",
        stageId: "stage-new-1",
        registryUrl: "https://registry.npmjs.org",
      }),
    );

    // One batched send carrying the single new stage, not one send per scan.
    expect(env.SCAN_QUEUE.sendBatch).toHaveBeenCalledTimes(1);
    expect(sentScanMessages()).toEqual([
      expect.objectContaining({
        source: "auto_discovery",
        stageId: "stage-new-1",
        connectionId: "connection_a",
      }),
    ]);
    expect(dbMock.markNpmConnectionUsed).toHaveBeenCalledWith(db, "org_a");
  });

  test("filters stage ids the organization token cannot access before creating scans", async () => {
    stagedPublishesMock.listStagedPublishes.mockResolvedValue({
      items: [
        { id: "stage-allowed", packageName: "@org/allowed", version: "1.0.0" },
        { id: "stage-denied", packageName: "@other/denied", version: "1.0.0" },
      ],
    });
    stagedPublishesMock.checkStagedPublishAccess
      .mockResolvedValueOnce({ allowed: true, status: 206, detail: null })
      .mockResolvedValueOnce({ allowed: false, status: 403, detail: "Forbidden" });
    dbMock.listExistingScanStageIds.mockResolvedValue(new Set());
    dbMock.createScanJob.mockResolvedValue({ id: "scan-allowed" });

    const result = await discoverAndQueueStagedPublishes(
      {
        db,
        env,
        executionCtx: ctx,
        organizationId: "org_a",
        actorUserId: "user_a",
        source: "auto_discovery",
        eventSource: "staged_publishes.cron",
      },
      {
        token: "npm_secret_token",
        registryUrl: "https://registry.npmjs.org",
        connectionId: "connection_a",
      },
    );

    expect(result).toEqual(
      expect.objectContaining({ found: 2, created: 1, skipped: 1, queued: true }),
    );
    expect(stagedPublishesMock.checkStagedPublishAccess).toHaveBeenCalledTimes(2);
    expect(dbMock.createScanJob).toHaveBeenCalledTimes(1);
    expect(dbMock.createScanJob).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ stageId: "stage-allowed" }),
    );
    expect(env.SCAN_QUEUE.sendBatch).toHaveBeenCalledTimes(1);
    expect(sentScanMessages()).toEqual([expect.objectContaining({ stageId: "stage-allowed" })]);
  });

  test("fetches additional staged publish pages before deduping", async () => {
    stagedPublishesMock.listStagedPublishes
      .mockResolvedValueOnce({
        items: [
          { id: "stage-page-1", packageName: "pkg-a", version: "1.0.0" },
          { id: "stage-page-2", packageName: "pkg-b", version: "1.0.0" },
        ],
        total: 3,
        perPage: 2,
        page: 1,
      })
      .mockResolvedValueOnce({
        items: [
          { id: "stage-page-3", packageName: "pkg-c", version: "1.0.0" },
          { id: "stage-page-2", packageName: "pkg-b", version: "1.0.0" },
        ],
        total: 3,
        perPage: 2,
        page: 2,
      });
    dbMock.listExistingScanStageIds.mockResolvedValue(new Set());
    dbMock.createScanJob.mockResolvedValue({ id: "scan-new" });

    const result = await discoverAndQueueStagedPublishes(
      {
        db,
        env,
        executionCtx: ctx,
        organizationId: "org_a",
        actorUserId: "user_a",
        source: "auto_discovery",
        eventSource: "staged_publishes.cron",
      },
      {
        token: "npm_secret_token",
        registryUrl: "https://registry.npmjs.org",
        connectionId: "connection_a",
      },
    );

    expect(stagedPublishesMock.listStagedPublishes).toHaveBeenCalledTimes(2);
    expect(stagedPublishesMock.listStagedPublishes.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ perPage: 50 }),
    );
    expect(stagedPublishesMock.listStagedPublishes.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ perPage: 50, page: 2 }),
    );
    expect(dbMock.listExistingScanStageIds).toHaveBeenCalledWith(db, "org_a", [
      "stage-page-1",
      "stage-page-2",
      "stage-page-3",
    ]);
    expect(result).toEqual(
      expect.objectContaining({ found: 3, created: 3, skipped: 0, queued: true }),
    );
    expect(stagedPublishesMock.checkStagedPublishAccess).toHaveBeenCalledTimes(3);
    expect(
      stagedPublishesMock.checkStagedPublishAccess.mock.calls.filter(
        (call) => call[2] === "stage-page-2",
      ),
    ).toHaveLength(1);
  });

  test("starts queued scans with bounded concurrency", async () => {
    stagedPublishesMock.listStagedPublishes.mockResolvedValue({
      items: Array.from({ length: 6 }, (_, index) => ({
        id: `stage-${index}`,
        packageName: `pkg-${index}`,
        version: "1.0.0",
      })),
    });
    dbMock.listExistingScanStageIds.mockResolvedValue(new Set());
    dbMock.createScanJob.mockResolvedValue({ id: "scan-new" });

    let activeAccessChecks = 0;
    let maxActiveAccessChecks = 0;
    const releases = [];
    stagedPublishesMock.checkStagedPublishAccess.mockImplementation(async () => {
      activeAccessChecks++;
      maxActiveAccessChecks = Math.max(maxActiveAccessChecks, activeAccessChecks);
      await new Promise((resolve) => releases.push(resolve));
      activeAccessChecks--;
      return { allowed: true, status: 206, detail: null };
    });

    const pending = discoverAndQueueStagedPublishes(
      {
        db,
        env,
        executionCtx: ctx,
        organizationId: "org_a",
        actorUserId: "user_a",
        source: "auto_discovery",
        eventSource: "staged_publishes.cron",
      },
      {
        token: "npm_secret_token",
        registryUrl: "https://registry.npmjs.org",
        connectionId: "connection_a",
      },
    );
    await flushPromises();

    expect(stagedPublishesMock.checkStagedPublishAccess).toHaveBeenCalledTimes(5);
    expect(maxActiveAccessChecks).toBe(5);

    releases.shift()?.();
    await flushPromises();
    expect(stagedPublishesMock.checkStagedPublishAccess).toHaveBeenCalledTimes(6);
    expect(maxActiveAccessChecks).toBe(5);

    for (const release of releases) release();
    const result = await pending;

    expect(result).toEqual(
      expect.objectContaining({ found: 6, created: 6, skipped: 0, queued: true }),
    );
    // Six new stages, still a single batched send.
    expect(env.SCAN_QUEUE.sendBatch).toHaveBeenCalledTimes(1);
    expect(sentScanMessages()).toHaveLength(6);
  });

  // Cross-org stage coordination was removed with the per-org discovery queue:
  // two organizations that can both see one staged publish now sweep in separate
  // invocations, so nothing could serialize their starts anyway. Duplicate
  // cross-org scans of the same stage id are intended — each org owns its own
  // scan row and decision.
  test("lets two organizations start the same stage id independently", async () => {
    stagedPublishesMock.listStagedPublishes.mockResolvedValue({
      items: [{ id: "stage-shared", packageName: "pkg-a", version: "1.0.0" }],
    });
    dbMock.listExistingScanStageIds.mockResolvedValue(new Set());
    dbMock.createScanJob.mockResolvedValue({ id: "scan-new" });

    const results = await Promise.all([
      discoverAndQueueStagedPublishes(
        {
          db,
          env,
          executionCtx: ctx,
          organizationId: "org_a",
          actorUserId: "user_a",
          source: "auto_discovery",
          eventSource: "staged_publishes.cron",
        },
        {
          token: "npm_secret_token_a",
          registryUrl: "https://registry.npmjs.org",
          connectionId: "connection_a",
        },
      ),
      discoverAndQueueStagedPublishes(
        {
          db,
          env,
          executionCtx: ctx,
          organizationId: "org_b",
          actorUserId: "user_b",
          source: "auto_discovery",
          eventSource: "staged_publishes.cron",
        },
        {
          token: "npm_secret_token_b",
          registryUrl: "https://registry.npmjs.org",
          connectionId: "connection_b",
        },
      ),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ created: 1, skipped: 0 }),
      expect.objectContaining({ created: 1, skipped: 0 }),
    ]);
    expect(dbMock.createScanJob).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ organizationId: "org_a", stageId: "stage-shared" }),
    );
    expect(dbMock.createScanJob).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ organizationId: "org_b", stageId: "stage-shared" }),
    );
    expect(sentScanMessages()).toEqual([
      expect.objectContaining({ organizationId: "org_a", stageId: "stage-shared" }),
      expect.objectContaining({ organizationId: "org_b", stageId: "stage-shared" }),
    ]);
  });

  test("dispatches large discovery in bounded preparation batches", async () => {
    // Each bounded slice reaches SCAN_QUEUE before the next one is prepared, so
    // a later failure cannot strand every row the invocation created.
    stagedPublishesMock.listStagedPublishes.mockResolvedValue({
      items: Array.from({ length: 140 }, (_, index) => ({
        id: `stage-${index}`,
        packageName: `pkg-${index}`,
        version: "1.0.0",
      })),
    });
    dbMock.listExistingScanStageIds.mockResolvedValue(new Set());
    dbMock.createScanJob.mockResolvedValue({ id: "scan-new" });

    const result = await discoverAndQueueStagedPublishes(
      {
        db,
        env,
        executionCtx: ctx,
        organizationId: "org_a",
        actorUserId: "user_a",
        source: "auto_discovery",
        eventSource: "staged_publishes.cron",
      },
      {
        token: "npm_secret_token",
        registryUrl: "https://registry.npmjs.org",
        connectionId: "connection_a",
      },
    );

    expect(result).toEqual(expect.objectContaining({ found: 140, created: 140 }));
    expect(env.SCAN_QUEUE.sendBatch).toHaveBeenCalledTimes(3);
    expect(env.SCAN_QUEUE.sendBatch.mock.calls[0][0]).toHaveLength(50);
    expect(env.SCAN_QUEUE.sendBatch.mock.calls[1][0]).toHaveLength(50);
    expect(env.SCAN_QUEUE.sendBatch.mock.calls[2][0]).toHaveLength(40);
    expect(sentScanMessages()).toHaveLength(140);
  });

  test("hands off each candidate immediately without a discovery queue", async () => {
    stagedPublishesMock.listStagedPublishes.mockResolvedValue({
      items: Array.from({ length: 3 }, (_, index) => ({
        id: `stage-${index}`,
        packageName: `pkg-${index}`,
        version: "1.0.0",
      })),
    });
    dbMock.listExistingScanStageIds.mockResolvedValue(new Set());
    dbMock.createScanJob.mockResolvedValue({ id: "scan-new" });
    const fallbackEnv = { DB: {}, SCAN_QUEUE: env.SCAN_QUEUE };

    const result = await discoverAndQueueStagedPublishes(
      {
        db,
        env: fallbackEnv,
        executionCtx: ctx,
        organizationId: "org_a",
        actorUserId: "user_a",
        source: "auto_discovery",
        eventSource: "staged_publishes.cron",
      },
      {
        token: "npm_secret_token",
        registryUrl: "https://registry.npmjs.org",
        connectionId: "connection_a",
      },
    );

    expect(result).toEqual(expect.objectContaining({ created: 3, deferred: 0 }));
    expect(env.SCAN_QUEUE.sendBatch).toHaveBeenCalledTimes(3);
    for (const [batch] of env.SCAN_QUEUE.sendBatch.mock.calls) expect(batch).toHaveLength(1);
  });

  test("lists once and fans remaining candidates into independent bounded work", async () => {
    stagedPublishesMock.listStagedPublishes.mockResolvedValue({
      items: Array.from({ length: 60 }, (_, index) => ({
        id: `stage-${String(index).padStart(2, "0")}`,
        packageName: `pkg-${index}`,
        version: "1.0.0",
      })),
      total: 60,
      perPage: 60,
      page: 0,
    });
    dbMock.listExistingScanStageIds.mockResolvedValue(new Set());
    dbMock.createScanJob.mockResolvedValue({ id: "scan-new" });
    const scheduleCandidateBatches = vi.fn();

    const first = await discoverAndQueueStagedPublishes(
      {
        db,
        env,
        executionCtx: ctx,
        organizationId: "org_a",
        actorUserId: "user_a",
        source: "auto_discovery",
        eventSource: "staged_publishes.cron",
        scheduleCandidateBatches,
      },
      {
        token: "npm_secret_token",
        registryUrl: "https://registry.npmjs.org",
        connectionId: "connection_a",
      },
    );

    expect(first).toEqual(
      expect.objectContaining({ found: 60, created: 50, skipped: 0, deferred: 10 }),
    );
    expect(env.SCAN_QUEUE.sendBatch).toHaveBeenCalledTimes(1);
    expect(env.SCAN_QUEUE.sendBatch.mock.calls[0][0]).toHaveLength(50);
    expect(scheduleCandidateBatches).toHaveBeenCalledTimes(1);
    const deferredCandidates = scheduleCandidateBatches.mock.calls[0][0];
    expect(deferredCandidates.map((candidate) => candidate.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `stage-${index + 50}`),
    );

    env.SCAN_QUEUE.sendBatch.mockClear();
    const continuation = await queueStagedPublishCandidates(
      {
        db,
        env,
        executionCtx: ctx,
        organizationId: "org_a",
        actorUserId: "user_a",
        source: "auto_discovery",
        eventSource: "staged_publishes.cron",
      },
      {
        token: "npm_secret_token",
        registryUrl: "https://registry.npmjs.org",
        connectionId: "connection_a",
      },
      deferredCandidates,
    );

    expect(continuation).toEqual(
      expect.objectContaining({ found: 10, created: 10, skipped: 0, deferred: 0 }),
    );
    expect(env.SCAN_QUEUE.sendBatch).toHaveBeenCalledTimes(1);
    expect(env.SCAN_QUEUE.sendBatch.mock.calls[0][0]).toHaveLength(10);
    expect(stagedPublishesMock.listStagedPublishes).toHaveBeenCalledTimes(1);
  });

  test("rolls back every scan row a failed batch left off the queue", async () => {
    // The second bounded slice fails: the 50 scans already accepted keep
    // running, and the next 50 rows are deleted so the next sweep
    // rediscovers them instead of seeing a permanently pending scan.
    stagedPublishesMock.listStagedPublishes.mockResolvedValue({
      items: Array.from({ length: 140 }, (_, index) => ({
        id: `stage-${index}`,
        packageName: `pkg-${index}`,
        version: "1.0.0",
      })),
    });
    dbMock.listExistingScanStageIds.mockResolvedValue(new Set());
    dbMock.createScanJob.mockResolvedValue({ id: "scan-new" });
    env.SCAN_QUEUE.sendBatch
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("queue unavailable"));

    await expect(
      discoverAndQueueStagedPublishes(
        {
          db,
          env,
          executionCtx: ctx,
          organizationId: "org_a",
          actorUserId: "user_a",
          source: "auto_discovery",
          eventSource: "staged_publishes.cron",
        },
        {
          token: "npm_secret_token",
          registryUrl: "https://registry.npmjs.org",
          connectionId: "connection_a",
        },
      ),
    ).rejects.toThrow("queue unavailable");

    // One batched delete, not 50 sequential ones. Only the accepted slice's scan
    // rows survive; the rejected slice's 50 are exactly the deleted ones.
    expect(dbMock.deletePendingScanJobs).toHaveBeenCalledTimes(1);
    const acceptedScanIds = new Set(
      env.SCAN_QUEUE.sendBatch.mock.calls[0][0].map((entry) => entry.body.scanId),
    );
    const rejectedScanIds = env.SCAN_QUEUE.sendBatch.mock.calls[1][0].map(
      (entry) => entry.body.scanId,
    );
    const [, deletedScanIds, deletedOrganizationId] = dbMock.deletePendingScanJobs.mock.calls[0];
    expect(deletedScanIds).toEqual(rejectedScanIds);
    expect(deletedOrganizationId).toBe("org_a");
    for (const scanId of deletedScanIds) expect(acceptedScanIds.has(scanId)).toBe(false);
  });

  test("removes the pending scan when queue dispatch fails", async () => {
    const queueError = new Error("queue unavailable");
    stagedPublishesMock.listStagedPublishes.mockResolvedValue({
      items: [{ id: "stage-queue-fail", packageName: "pkg-a", version: "1.0.0" }],
    });
    dbMock.listExistingScanStageIds.mockResolvedValue(new Set());
    dbMock.createScanJob.mockResolvedValue({ id: "scan-new-1" });
    env.SCAN_QUEUE.sendBatch.mockRejectedValueOnce(queueError);

    await expect(
      discoverAndQueueStagedPublishes(
        {
          db,
          env,
          executionCtx: ctx,
          organizationId: "org_a",
          actorUserId: "user_a",
          source: "auto_discovery",
          eventSource: "staged_publishes.cron",
        },
        {
          token: "npm_secret_token",
          registryUrl: "https://registry.npmjs.org",
          connectionId: "connection_a",
        },
      ),
    ).rejects.toThrow("queue unavailable");

    const createdScanId = dbMock.createScanJob.mock.calls[0]?.[1]?.id;
    expect(dbMock.deletePendingScanJobs).toHaveBeenCalledWith(db, [createdScanId], "org_a");
  });

  test("removes rows already created when a later candidate fails before dispatch", async () => {
    // Rows are created for every candidate before anything is sent, so a
    // candidate that throws mid-sweep must not leave the earlier rows pending
    // with no queue message behind them: nothing is dispatched, and every row
    // this sweep wrote is deleted.
    stagedPublishesMock.listStagedPublishes.mockResolvedValue({
      items: [
        { id: "stage-ok", packageName: "pkg-a", version: "1.0.0" },
        { id: "stage-boom", packageName: "pkg-b", version: "1.0.0" },
      ],
    });
    dbMock.listExistingScanStageIds.mockResolvedValue(new Set());
    dbMock.createScanJob
      .mockResolvedValueOnce({ id: "scan-ok" })
      .mockRejectedValueOnce(new Error("D1_ERROR: write failed"));

    await expect(
      discoverAndQueueStagedPublishes(
        {
          db,
          env,
          executionCtx: ctx,
          organizationId: "org_a",
          actorUserId: "user_a",
          source: "auto_discovery",
          eventSource: "staged_publishes.cron",
        },
        {
          token: "npm_secret_token",
          registryUrl: "https://registry.npmjs.org",
          connectionId: "connection_a",
        },
      ),
    ).rejects.toThrow("D1_ERROR: write failed");

    expect(env.SCAN_QUEUE.sendBatch).not.toHaveBeenCalled();
    const createdScanId = dbMock.createScanJob.mock.calls[0]?.[1]?.id;
    expect(dbMock.deletePendingScanJobs).toHaveBeenCalledTimes(1);
    expect(dbMock.deletePendingScanJobs).toHaveBeenCalledWith(db, [createdScanId], "org_a");
  });

  test("starts nothing when every discovered stage is already known", async () => {
    stagedPublishesMock.listStagedPublishes.mockResolvedValue({
      items: [{ id: "stage-known", packageName: "pkg-a", version: "1.0.0" }],
    });
    dbMock.listExistingScanStageIds.mockResolvedValue(new Set(["stage-known"]));

    const result = await discoverAndQueueStagedPublishes(
      {
        db,
        env,
        executionCtx: ctx,
        organizationId: "org_a",
        actorUserId: "user_a",
        source: "auto_discovery",
        eventSource: "staged_publishes.cron",
      },
      {
        token: "npm_secret_token",
        registryUrl: "https://registry.npmjs.org",
        connectionId: "connection_a",
      },
    );

    expect(result).toEqual(expect.objectContaining({ found: 1, created: 0, skipped: 1 }));
    expect(dbMock.createScanJob).not.toHaveBeenCalled();
    expect(env.SCAN_QUEUE.sendBatch).not.toHaveBeenCalled();
  });

  test("starts a scan for each newly discovered stage", async () => {
    stagedPublishesMock.listStagedPublishes.mockResolvedValue({
      items: [{ id: "stage-new", packageName: "pkg-a", version: "1.0.0" }],
    });
    dbMock.listExistingScanStageIds.mockResolvedValue(new Set());
    dbMock.createScanJob.mockResolvedValue({ id: "scan-new" });

    const result = await discoverAndQueueStagedPublishes(
      {
        db,
        env,
        executionCtx: ctx,
        organizationId: "org_a",
        actorUserId: "user_a",
        source: "auto_discovery",
        eventSource: "staged_publishes.cron",
      },
      {
        token: "npm_secret_token",
        registryUrl: "https://registry.npmjs.org",
        connectionId: "connection_a",
      },
    );

    expect(result).toEqual(
      expect.objectContaining({ found: 1, created: 1, skipped: 0, queued: true }),
    );
    expect(result.scans).toHaveLength(1);
    expect(dbMock.createScanJob).toHaveBeenCalledTimes(1);
    expect(dbMock.createScanJob).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ stageId: "stage-new" }),
    );
    expect(env.SCAN_QUEUE.sendBatch).toHaveBeenCalledTimes(1);
    expect(sentScanMessages()).toEqual([expect.objectContaining({ stageId: "stage-new" })]);
  });
});

describe("isTransientSweepFailure", () => {
  function fetchError(status) {
    const err = new stagedPublishesMock.StagedPublishesFetchError();
    err.status = status;
    return err;
  }

  test("classifies transport and registry-side failures as transient", () => {
    // 0 is the reliableFetch abort (timeout/DNS/TLS); the rest are the registry
    // declining to serve after retries.
    for (const status of [0, 408, 429, 500, 502, 503, 504]) {
      expect(isTransientSweepFailure(fetchError(status))).toBe(true);
    }
  });

  test("keeps auth and client-side statuses actionable", () => {
    // 401/403 never reach the generic failure log (they take the expired-token
    // path), but classification must not quietly downgrade them if they do.
    for (const status of [400, 401, 403, 404, 410, 422]) {
      expect(isTransientSweepFailure(fetchError(status))).toBe(false);
    }
  });

  test("treats non-fetch failures as actionable", () => {
    // A D1 error or a bug in the sweep is ours to fix, not upstream weather.
    expect(isTransientSweepFailure(new Error("D1_ERROR"))).toBe(false);
    expect(isTransientSweepFailure(new InvalidNpmConnectionError("org_a"))).toBe(false);
    expect(isTransientSweepFailure(null)).toBe(false);
  });
});

async function flushPromises() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
