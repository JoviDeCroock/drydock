import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const dbMock = vi.hoisted(() => ({
  createScanJob: vi.fn(),
  deletePendingScanJob: vi.fn(),
  listExistingScanStageIds: vi.fn(),
  markNpmConnectionUsed: vi.fn(),
  recordScanEvent: vi.fn(),
  updateNpmConnectionValidation: vi.fn(),
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

vi.mock("../server/db/index.ts", () => dbMock);
vi.mock("../server/lib/npm-connection.ts", () => npmConnectionMock);
vi.mock("../server/lib/staged-publishes.ts", () => stagedPublishesMock);
vi.mock("../server/lib/scan-job.ts", () => scanJobMock);

const {
  ensureUsableNpmConnection,
  discoverAndQueueStagedPublishes,
  InvalidNpmConnectionError,
  isNpmConnectionAuthFailure,
} = await import("../server/lib/staged-publishes-discovery.ts");

const env = { DB: {}, SCAN_QUEUE: { send: vi.fn() } };
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
});

afterEach(() => {
  for (const fn of [
    ...Object.values(dbMock),
    ...Object.values(npmConnectionMock),
    ...Object.values(stagedPublishesMock),
    ...Object.values(scanJobMock),
  ]) {
    if (typeof fn?.mockReset === "function") fn.mockReset();
  }
  env.SCAN_QUEUE.send.mockReset();
  ctx.waitUntil.mockReset();
});

describe("ensureUsableNpmConnection token state branching", () => {
  test("returns the decrypted token without revalidating a valid connection", async () => {
    const result = await ensureUsableNpmConnection({
      db,
      env,
      connection: {
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
    });
    expect(npmConnectionMock.validateNpmCredential).not.toHaveBeenCalled();
    expect(dbMock.updateNpmConnectionValidation).not.toHaveBeenCalled();
  });

  test("rejects invalid connections without contacting the registry", async () => {
    await expect(
      ensureUsableNpmConnection({
        db,
        env,
        connection: {
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
    expect(dbMock.updateNpmConnectionValidation).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ organizationId: "org_a", validationStatus: "valid" }),
    );
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
    expect(dbMock.updateNpmConnectionValidation).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ organizationId: "org_a", validationStatus: "invalid" }),
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
    expect(dbMock.updateNpmConnectionValidation).toHaveBeenCalledWith(
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
          organizationId: "org_a",
          registryUrl: "https://registry.npmjs.org",
          validationStatus: "unvalidated",
          tokenCiphertext: "x",
          tokenNonce: "y",
        },
        actorUserId: "user_a",
      }),
    ).rejects.toBeInstanceOf(InvalidNpmConnectionError);

    const failure = dbMock.updateNpmConnectionValidation.mock.calls[0];
    expect(failure).toBeDefined();
    expect(dbMock.updateNpmConnectionValidation).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ organizationId: "org_a", validationStatus: "unvalidated" }),
    );
  });
});

describe("discoverAndQueueStagedPublishes", () => {
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
      { token: "npm_secret_token", registryUrl: "https://registry.npmjs.org" },
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
      expect.objectContaining({ source: "auto_discovery", stageId: "stage-new-1" }),
    );

    expect(env.SCAN_QUEUE.send).toHaveBeenCalledTimes(1);
    expect(env.SCAN_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({ source: "auto_discovery", stageId: "stage-new-1" }),
    );
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
      { token: "npm_secret_token", registryUrl: "https://registry.npmjs.org" },
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
    expect(env.SCAN_QUEUE.send).toHaveBeenCalledTimes(1);
    expect(env.SCAN_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({ stageId: "stage-allowed" }),
    );
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
      { token: "npm_secret_token", registryUrl: "https://registry.npmjs.org" },
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
  });

  test("removes the pending scan when queue dispatch fails", async () => {
    const queueError = new Error("queue unavailable");
    stagedPublishesMock.listStagedPublishes.mockResolvedValue({
      items: [{ id: "stage-queue-fail", packageName: "pkg-a", version: "1.0.0" }],
    });
    dbMock.listExistingScanStageIds.mockResolvedValue(new Set());
    dbMock.createScanJob.mockResolvedValue({ id: "scan-new-1" });
    env.SCAN_QUEUE.send.mockRejectedValueOnce(queueError);

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
        { token: "npm_secret_token", registryUrl: "https://registry.npmjs.org" },
      ),
    ).rejects.toThrow("queue unavailable");

    const createdScanId = dbMock.createScanJob.mock.calls[0]?.[1]?.id;
    expect(dbMock.deletePendingScanJob).toHaveBeenCalledWith(db, createdScanId, "org_a");
    expect(
      dbMock.recordScanEvent.mock.calls.some(([, payload]) => payload?.type === "scan.queued"),
    ).toBe(false);
  });

  test("does not record scans_started when the sweep starts nothing", async () => {
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
      { token: "npm_secret_token", registryUrl: "https://registry.npmjs.org" },
    );

    expect(result).toEqual(expect.objectContaining({ found: 1, created: 0, skipped: 1 }));
    expect(
      dbMock.recordScanEvent.mock.calls.some(
        ([, payload]) => payload?.type === "staged_publishes.scans_started",
      ),
    ).toBe(false);
  });

  test("records scans_started when the sweep starts scans", async () => {
    stagedPublishesMock.listStagedPublishes.mockResolvedValue({
      items: [{ id: "stage-new", packageName: "pkg-a", version: "1.0.0" }],
    });
    dbMock.listExistingScanStageIds.mockResolvedValue(new Set());
    dbMock.createScanJob.mockResolvedValue({ id: "scan-new" });

    await discoverAndQueueStagedPublishes(
      {
        db,
        env,
        executionCtx: ctx,
        organizationId: "org_a",
        actorUserId: "user_a",
        source: "auto_discovery",
        eventSource: "staged_publishes.cron",
      },
      { token: "npm_secret_token", registryUrl: "https://registry.npmjs.org" },
    );

    const startedEvents = dbMock.recordScanEvent.mock.calls.filter(
      ([, payload]) => payload?.type === "staged_publishes.scans_started",
    );
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]?.[1]?.metadata).toEqual(
      expect.objectContaining({ found: 1, created: 1, skipped: 0 }),
    );
  });
});
