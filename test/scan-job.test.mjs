import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const dbMock = vi.hoisted(() => ({
  claimScanForRun: vi.fn(),
  createDb: vi.fn(() => ({})),
  discardScanAttempt: vi.fn(),
  getNpmConnection: vi.fn(),
  markNpmConnectionUsed: vi.fn(),
  markScanFailed: vi.fn(),
  recordScanEvent: vi.fn(),
}));
const pipelineMock = vi.hoisted(() => ({ runScanPipeline: vi.fn() }));
const npmConnectionMock = vi.hoisted(() => ({ decryptNpmToken: vi.fn() }));
const notifyMock = vi.hoisted(() => ({
  notifyScanCompletion: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../server/db/index.ts", () => dbMock);
vi.mock("../server/lib/scan-pipeline.ts", () => pipelineMock);
vi.mock("../server/lib/npm-connection.ts", () => npmConnectionMock);
vi.mock("../server/lib/notify.ts", () => notifyMock);

const { classifyScanError, executeScanJob, retryDelaySeconds } =
  await import("../server/lib/scan-job.ts");
const { SandboxError } = await import("../server/lib/sandbox.ts");

describe("scan job retry classification", () => {
  test("retries transient sandbox download failures and does not leak raw detail", () => {
    const safe = classifyScanError(
      new SandboxError(JSON.stringify({ error: "download failed", status: 503 })),
    );

    expect(safe).toMatchObject({
      code: "sandbox_download_transient",
      retryable: true,
    });
    expect(safe).not.toHaveProperty("detail");
  });

  test("does not include raw error messages on generic failures", () => {
    const safe = classifyScanError(new Error("D1_ERROR: column not found"));
    expect(safe).toEqual({
      code: "scan_failed",
      message: "The scan failed before a report could be generated.",
      retryable: true,
    });
    expect(JSON.stringify(safe)).not.toContain("D1_ERROR");
  });

  test("does not retry credential and missing-stage sandbox failures", () => {
    expect(
      classifyScanError(
        new Error("Connect an organization npm token before scanning staged publishes."),
      ),
    ).toMatchObject({
      code: "npm_connection_missing",
      retryable: false,
    });
    expect(
      classifyScanError(
        new Error("Validate the organization npm token before scanning staged publishes."),
      ),
    ).toMatchObject({
      code: "npm_connection_unvalidated",
      retryable: false,
    });
    expect(
      classifyScanError(
        new SandboxError(JSON.stringify({ error: "download failed", status: 403 })),
      ),
    ).toMatchObject({
      code: "staged_tarball_unavailable",
      retryable: false,
    });
  });

  test("does not retry archive file-count limit failures", () => {
    const safe = classifyScanError(
      new SandboxError(JSON.stringify({ error: "archive contains too many files", status: 413 })),
    );

    expect(safe).toEqual({
      code: "archive_too_many_files",
      message: "The staged tarball contains more files than the scanner can safely review.",
      retryable: false,
    });
  });

  test("uses bounded quadratic retry delays", () => {
    expect(retryDelaySeconds(1)).toBe(5);
    expect(retryDelaySeconds(2)).toBe(20);
    expect(retryDelaySeconds(10)).toBe(60);
  });
});

describe("executeScanJob idempotency", () => {
  const env = { DB: {} };
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const message = {
    scanId: "scan_1",
    organizationId: "org_a",
    actorUserId: "user_a",
    stageId: "stage-abc",
  };

  beforeEach(() => {
    dbMock.getNpmConnection.mockResolvedValue({
      registryUrl: "https://registry.npmjs.org",
      tokenFingerprint: "fp",
      validationStatus: "valid",
    });
    npmConnectionMock.decryptNpmToken.mockResolvedValue("npm_token");
    pipelineMock.runScanPipeline.mockResolvedValue({ id: message.scanId });
  });

  afterEach(() => {
    for (const fn of Object.values(dbMock)) if (typeof fn?.mockReset === "function") fn.mockReset();
    pipelineMock.runScanPipeline.mockReset();
    npmConnectionMock.decryptNpmToken.mockReset();
    notifyMock.notifyScanCompletion.mockClear();
  });

  test("returns null without running the pipeline when claim is rejected", async () => {
    dbMock.claimScanForRun.mockResolvedValue(false);

    const result = await executeScanJob(env, ctx, message, {}, { attempt: 2 });

    expect(result).toBeNull();
    expect(pipelineMock.runScanPipeline).not.toHaveBeenCalled();
    expect(dbMock.recordScanEvent).not.toHaveBeenCalled();
    expect(dbMock.markScanFailed).not.toHaveBeenCalled();
  });

  test("emits scan.started exactly once after a successful claim", async () => {
    dbMock.claimScanForRun.mockResolvedValue(true);

    await executeScanJob(env, ctx, message, {}, { attempt: 1 });

    const started = dbMock.recordScanEvent.mock.calls.filter(
      ([, payload]) => payload?.type === "scan.started",
    );
    expect(started).toHaveLength(1);
    expect(pipelineMock.runScanPipeline).toHaveBeenCalledTimes(1);
  });

  test("records scan.failed and marks the scan failed on a terminal error in the final attempt", async () => {
    dbMock.claimScanForRun.mockResolvedValue(true);
    pipelineMock.runScanPipeline.mockRejectedValue(
      new SandboxError(JSON.stringify({ error: "denied", status: 403 })),
    );

    await expect(
      executeScanJob(env, ctx, message, {}, { attempt: 1, finalAttempt: true }),
    ).rejects.toBeInstanceOf(SandboxError);

    expect(dbMock.markScanFailed).toHaveBeenCalledTimes(1);
    const failed = dbMock.recordScanEvent.mock.calls.filter(
      ([, payload]) => payload?.type === "scan.failed",
    );
    expect(failed).toHaveLength(1);
  });

  test("fails before decrypting when the queued job sees an unvalidated rotated connection", async () => {
    dbMock.claimScanForRun.mockResolvedValue(true);
    dbMock.getNpmConnection.mockResolvedValue({
      registryUrl: "https://registry.npmjs.org",
      tokenFingerprint: "fp",
      validationStatus: "unvalidated",
    });

    await expect(
      executeScanJob(env, ctx, message, {}, { attempt: 1, finalAttempt: true }),
    ).rejects.toThrow("Validate the organization npm token");

    expect(npmConnectionMock.decryptNpmToken).not.toHaveBeenCalled();
    expect(dbMock.markNpmConnectionUsed).not.toHaveBeenCalled();
    expect(pipelineMock.runScanPipeline).not.toHaveBeenCalled();
    expect(dbMock.markScanFailed).toHaveBeenCalledWith({}, message.scanId, message.organizationId, {
      code: "npm_connection_unvalidated",
      message: "Validate the organization npm token before scanning staged publishes.",
      retryable: false,
    });
  });

  test("discards auto-discovered scans when the org's token cannot access the tarball", async () => {
    dbMock.claimScanForRun.mockResolvedValue(true);
    pipelineMock.runScanPipeline.mockRejectedValue(
      new SandboxError(JSON.stringify({ error: "denied", status: 403 })),
    );

    await expect(
      executeScanJob(
        env,
        ctx,
        { ...message, source: "auto_discovery" },
        {},
        { attempt: 1, finalAttempt: true },
      ),
    ).rejects.toBeInstanceOf(SandboxError);

    expect(dbMock.markScanFailed).not.toHaveBeenCalled();
    expect(dbMock.discardScanAttempt).toHaveBeenCalledWith(
      {},
      message.scanId,
      message.organizationId,
    );
    const failed = dbMock.recordScanEvent.mock.calls.filter(
      ([, payload]) => payload?.type === "scan.failed",
    );
    expect(failed).toHaveLength(0);
    const skipped = dbMock.recordScanEvent.mock.calls.filter(
      ([, payload]) => payload?.type === "scan.skipped",
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.[1]?.scanId).toBeUndefined();
    expect(skipped[0]?.[1]?.metadata).toMatchObject({
      scanId: message.scanId,
      stageId: message.stageId,
    });
    expect(notifyMock.notifyScanCompletion).not.toHaveBeenCalled();
  });

  test("still marks auto-discovered scans failed for non-tarball-access errors", async () => {
    dbMock.claimScanForRun.mockResolvedValue(true);
    pipelineMock.runScanPipeline.mockRejectedValue(
      new SandboxError(JSON.stringify({ error: "archive contains too many files", status: 413 })),
    );

    await expect(
      executeScanJob(
        env,
        ctx,
        { ...message, source: "auto_discovery" },
        {},
        { attempt: 1, finalAttempt: true },
      ),
    ).rejects.toBeInstanceOf(SandboxError);

    expect(dbMock.discardScanAttempt).not.toHaveBeenCalled();
    expect(dbMock.markScanFailed).toHaveBeenCalledTimes(1);
    expect(notifyMock.notifyScanCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed" }),
    );
  });

  test("records scan.retryable_failed without marking failed when a retryable error fires before exhaustion", async () => {
    dbMock.claimScanForRun.mockResolvedValue(true);
    pipelineMock.runScanPipeline.mockRejectedValue(
      new SandboxError(JSON.stringify({ error: "blip", status: 503 })),
    );

    await expect(
      executeScanJob(env, ctx, message, {}, { attempt: 1, finalAttempt: false }),
    ).rejects.toBeInstanceOf(SandboxError);

    expect(dbMock.markScanFailed).not.toHaveBeenCalled();
    const retryable = dbMock.recordScanEvent.mock.calls.filter(
      ([, payload]) => payload?.type === "scan.retryable_failed",
    );
    expect(retryable).toHaveLength(1);
  });
});
