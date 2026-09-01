import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const dbMock = vi.hoisted(() => ({
  claimScanForRun: vi.fn(),
  createDb: vi.fn(() => ({})),
  discardScanAttempt: vi.fn(),
  getNpmConnection: vi.fn(),
  getScanReleaseIdentity: vi.fn(),
  markNpmConnectionUsed: vi.fn(),
  markScanFailed: vi.fn(),
  recordRegistryVersionStatus: vi.fn(),
  recordScanEvent: vi.fn(),
  scanExists: vi.fn(),
}));
const pipelineMock = vi.hoisted(() => ({ runScanPipeline: vi.fn() }));
const npmConnectionMock = vi.hoisted(() => ({
  allowInsecureLocalRegistry: vi.fn(),
  decryptNpmToken: vi.fn(),
  normalizeRegistryUrl: vi.fn((value) => value.replace(/\/+$/, "")),
}));
const notifyMock = vi.hoisted(() => ({
  notifyScanCompletion: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../server/db/client.ts", () => dbMock);
vi.mock("../server/db/events.ts", () => dbMock);
vi.mock("../server/db/npm-connections.ts", () => dbMock);
vi.mock("../server/db/scans.ts", () => dbMock);
vi.mock("../server/lib/scan/pipeline.ts", () => pipelineMock);
vi.mock("../server/lib/ecosystems/npm/connection.ts", () => npmConnectionMock);
vi.mock("../server/lib/notify/index.ts", () => notifyMock);

const { classifyScanError, executeScanJob, retryDelaySeconds } =
  await import("../server/lib/scan/job");
const { SandboxError } = await import("../server/lib/sandbox");

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

  test("classifies sandbox errors that crossed the Worker RPC boundary", () => {
    const safe = classifyScanError({
      name: "SandboxError",
      message: "sandbox download failed",
      detail: JSON.stringify({ error: "download failed", status: 503 }),
      remote: true,
    });

    expect(safe).toMatchObject({
      code: "sandbox_download_transient",
      retryable: true,
    });
    expect(safe).not.toHaveProperty("detail");
  });

  test("classifies RPC-safe sandbox errors serialized through message", () => {
    const safe = classifyScanError({
      name: "SandboxError",
      message: JSON.stringify({ error: "archive contains too many files", status: 413 }),
      remote: true,
    });

    expect(safe).toEqual({
      code: "archive_too_many_files",
      message: "The staged tarball contains more files than the scanner can safely review.",
      retryable: false,
    });
  });

  test("does not include raw error messages on generic failures", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const safe = classifyScanError(new Error("D1_ERROR: column not found"));
    expect(safe).toEqual({
      code: "scan_failed",
      message: "The scan failed before a report could be generated.",
      retryable: true,
    });
    expect(JSON.stringify(safe)).not.toContain("D1_ERROR");
    expect(errorSpy).toHaveBeenCalledWith("scan.error.unclassified", {
      event: "scan.error.unclassified",
      error: { name: "Error", message: "D1_ERROR: column not found" },
    });
    errorSpy.mockRestore();
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
        new Error("The npm connection was replaced before the staged review completed."),
      ),
    ).toMatchObject({
      code: "npm_connection_replaced",
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

  test("does not retry credential failures that crossed the Worker RPC boundary", () => {
    expect(
      classifyScanError({
        name: "Error",
        message: "Validate the organization npm token before scanning staged publishes.",
        remote: true,
      }),
    ).toMatchObject({
      code: "npm_connection_unvalidated",
      retryable: false,
    });
  });

  test("does not retry an atpm candidate that disappeared before the scan started", () => {
    expect(classifyScanError(new Error("staged release not found"))).toEqual({
      code: "staged_tarball_unavailable",
      message: "The staged candidate is no longer available for review.",
      retryable: false,
    });
  });

  test("does not retry a staged release identity mismatch", () => {
    expect(
      classifyScanError(
        new Error("The staged release identity changed after this scan was queued."),
      ),
    ).toEqual({
      code: "staged_release_identity_changed",
      message:
        "The staged release identity changed after this scan was queued. Run a new scan from the current staged release.",
      retryable: false,
    });
  });

  test("does not retry a queued scan without a captured registry", () => {
    expect(
      classifyScanError(new Error("The queued scan is missing its captured npm registry.")),
    ).toEqual({
      code: "npm_registry_identity_missing",
      message:
        "This queued scan has no captured npm registry. Run a new scan against the current connection.",
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
    connectionId: "connection_1",
  };

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    dbMock.getNpmConnection.mockResolvedValue({
      id: "connection_1",
      registryUrl: "https://registry.npmjs.org",
      tokenFingerprint: "fp",
      validationStatus: "valid",
    });
    dbMock.getScanReleaseIdentity.mockResolvedValue({
      registryUrl: "https://registry.npmjs.org",
      packageName: "pkg",
      stagedVersion: "1.0.0",
      registryStatusSupersededAt: null,
    });
    dbMock.recordRegistryVersionStatus.mockResolvedValue(true);
    npmConnectionMock.allowInsecureLocalRegistry.mockReturnValue(false);
    npmConnectionMock.decryptNpmToken.mockResolvedValue("npm_token");
    pipelineMock.runScanPipeline.mockResolvedValue({
      id: message.scanId,
      risk: "low",
      riskSummary: { releaseRisk: "low" },
      package: { name: null },
    });
  });

  afterEach(() => {
    for (const fn of Object.values(dbMock)) if (typeof fn?.mockReset === "function") fn.mockReset();
    pipelineMock.runScanPipeline.mockReset();
    npmConnectionMock.allowInsecureLocalRegistry.mockReset();
    npmConnectionMock.decryptNpmToken.mockReset();
    notifyMock.notifyScanCompletion.mockClear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("returns null without running the pipeline when claim is rejected", async () => {
    dbMock.claimScanForRun.mockResolvedValue(false);
    dbMock.scanExists.mockResolvedValue(true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await executeScanJob(env, ctx, message, {}, { attempt: 2 });

    expect(result).toBeNull();
    expect(pipelineMock.runScanPipeline).not.toHaveBeenCalled();
    expect(dbMock.recordScanEvent).not.toHaveBeenCalled();
    expect(dbMock.markScanFailed).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.find((call) => call[0] === "scan.job.skipped")?.[1]).toMatchObject({
      reason: "already_terminal",
    });
  });

  test("reports a rolled-back scan row as scan_row_missing, not already_terminal", async () => {
    // Discovery deletes a scan row when its sendBatch is rejected. The reject can
    // still have been delivered, so the consumer can receive a message pointing
    // at a row that no longer exists; calling that "already terminal" sent
    // whoever read the log looking for a completed scan that never ran.
    dbMock.claimScanForRun.mockResolvedValue(false);
    dbMock.scanExists.mockResolvedValue(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await executeScanJob(env, ctx, message, {}, { attempt: 1 });

    expect(result).toBeNull();
    expect(pipelineMock.runScanPipeline).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.find((call) => call[0] === "scan.job.skipped")?.[1]).toMatchObject({
      scanId: message.scanId,
      reason: "scan_row_missing",
    });
  });

  test("keeps a failed skip-reason lookup from retrying an already rejected claim", async () => {
    dbMock.claimScanForRun.mockResolvedValue(false);
    dbMock.scanExists.mockRejectedValue(new Error("D1_ERROR: transient read failure"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await executeScanJob(env, ctx, message, {}, { attempt: 1 });

    expect(result).toBeNull();
    expect(pipelineMock.runScanPipeline).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.find((call) => call[0] === "scan.job.skipped")?.[1]).toMatchObject({
      scanId: message.scanId,
      reason: "claim_rejected",
    });
    expect(
      warnSpy.mock.calls.find((call) => call[0] === "scan.job.skip_reason_unavailable")?.[1],
    ).toMatchObject({ scanId: message.scanId });
  });

  test("runs the pipeline exactly once after a successful claim", async () => {
    dbMock.claimScanForRun.mockResolvedValue(true);
    dbMock.getScanReleaseIdentity.mockResolvedValue({
      registryUrl: "https://registry.npmjs.org",
      packageName: "pkg",
      stagedVersion: "1.0.0",
      registryStatusSupersededAt: null,
    });

    await executeScanJob(env, ctx, message, {}, { attempt: 1 });

    expect(pipelineMock.runScanPipeline).toHaveBeenCalledTimes(1);
    expect(pipelineMock.runScanPipeline).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        connectionId: message.connectionId,
        registryUrl: "https://registry.npmjs.org",
      }),
    );
    expect(dbMock.markNpmConnectionUsed).toHaveBeenCalledWith({}, message.organizationId);
  });

  test("fails closed when the queued scan belongs to a previous registry connection", async () => {
    dbMock.claimScanForRun.mockResolvedValue(true);
    dbMock.getScanReleaseIdentity.mockResolvedValue({
      registryUrl: "https://registry.example.test",
      packageName: "pkg",
      stagedVersion: "1.0.0",
      registryStatusSupersededAt: null,
    });

    await expect(
      executeScanJob(env, ctx, message, {}, { attempt: 1, finalAttempt: true }),
    ).rejects.toThrow("npm registry changed after this scan was queued");

    expect(npmConnectionMock.decryptNpmToken).not.toHaveBeenCalled();
    expect(pipelineMock.runScanPipeline).not.toHaveBeenCalled();
    expect(dbMock.markScanFailed).toHaveBeenCalledWith({}, message.scanId, message.organizationId, {
      code: "npm_connection_changed",
      message:
        "The organization npm registry changed after this scan was queued. Run a new scan against the current connection.",
      retryable: false,
    });
  });

  test("fails closed when a legacy queued scan has no captured registry", async () => {
    dbMock.claimScanForRun.mockResolvedValue(true);
    dbMock.getScanReleaseIdentity.mockResolvedValue({
      registryUrl: null,
      packageName: null,
      stagedVersion: null,
      registryStatusSupersededAt: null,
    });

    await expect(
      executeScanJob(env, ctx, message, {}, { attempt: 1, finalAttempt: true }),
    ).rejects.toThrow("queued scan is missing its captured npm registry");

    expect(npmConnectionMock.decryptNpmToken).not.toHaveBeenCalled();
    expect(dbMock.markNpmConnectionUsed).not.toHaveBeenCalled();
    expect(pipelineMock.runScanPipeline).not.toHaveBeenCalled();
    expect(dbMock.markScanFailed).toHaveBeenCalledWith({}, message.scanId, message.organizationId, {
      code: "npm_registry_identity_missing",
      message:
        "This queued scan has no captured npm registry. Run a new scan against the current connection.",
      retryable: false,
    });
  });

  test("emits a structured completion log without token material", async () => {
    dbMock.claimScanForRun.mockResolvedValue(true);
    pipelineMock.runScanPipeline.mockResolvedValue({
      id: message.scanId,
      risk: "high",
      riskSummary: { releaseRisk: "low" },
      package: { name: "@scope/pkg" },
    });

    await executeScanJob(env, ctx, message, {}, { attempt: 1 });

    expect(console.log).toHaveBeenCalledWith(
      "scan.job.completed",
      expect.objectContaining({
        event: "scan.job.completed",
        scanId: message.scanId,
        organizationId: message.organizationId,
        stageId: message.stageId,
        source: "manual",
        attempt: 1,
        packageName: "@scope/pkg",
        releaseRisk: "low",
        artifactRisk: "high",
        durationMs: expect.any(Number),
      }),
    );
    expect(JSON.stringify(console.log.mock.calls)).not.toContain("npm_token");
  });

  test("notifies after a successful manual scan", async () => {
    dbMock.claimScanForRun.mockResolvedValue(true);

    await executeScanJob(env, ctx, message, {}, { attempt: 1 });

    expect(notifyMock.notifyScanCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        scanId: message.scanId,
        organizationId: message.organizationId,
        ownerUserId: message.actorUserId,
        outcome: "complete",
      }),
    );
  });

  test("marks the scan failed on a terminal error in the final attempt", async () => {
    dbMock.claimScanForRun.mockResolvedValue(true);
    pipelineMock.runScanPipeline.mockRejectedValue(
      new SandboxError(JSON.stringify({ error: "denied", status: 403 })),
    );

    await expect(
      executeScanJob(env, ctx, message, {}, { attempt: 1, finalAttempt: true }),
    ).rejects.toBeInstanceOf(SandboxError);

    expect(dbMock.markScanFailed).toHaveBeenCalledTimes(1);
    expect(notifyMock.notifyScanCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        scanId: message.scanId,
        organizationId: message.organizationId,
        ownerUserId: message.actorUserId,
        outcome: "failed",
        error: {
          code: "staged_tarball_unavailable",
          message: "The staged tarball could not be accessed with this organization's npm token.",
          retryable: false,
        },
      }),
    );
  });

  test.each([
    ["published", "staged_release_published", false],
    ["deleted", "staged_release_deleted", true],
  ])(
    "persists failed-scan status %s only if it cannot change",
    async (status, failureCode, persisted) => {
      dbMock.claimScanForRun.mockResolvedValue(true);
      dbMock.getScanReleaseIdentity.mockResolvedValue({
        packageName: "pkg",
        stagedVersion: "1.0.0",
        registryUrl: "https://registry.npmjs.org",
      });
      pipelineMock.runScanPipeline.mockRejectedValue(
        new SandboxError(JSON.stringify({ error: "denied", status: 403 })),
      );
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ packageName: "pkg", version: "1.0.0", status }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        executeScanJob(env, ctx, message, {}, { attempt: 1, finalAttempt: true }),
      ).rejects.toBeInstanceOf(SandboxError);

      expect(dbMock.getScanReleaseIdentity).toHaveBeenCalledWith(
        {},
        message.scanId,
        message.organizationId,
      );
      expect(npmConnectionMock.decryptNpmToken).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(dbMock.markScanFailed).toHaveBeenCalledWith(
        {},
        message.scanId,
        message.organizationId,
        expect.objectContaining({ code: failureCode }),
      );
      expect(dbMock.recordRegistryVersionStatus).toHaveBeenCalledTimes(persisted ? 1 : 0);
    },
  );

  test("fails before decrypting when the queued job sees an unvalidated rotated connection", async () => {
    dbMock.claimScanForRun.mockResolvedValue(true);
    dbMock.getNpmConnection.mockResolvedValue({
      id: "connection_1",
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

  test("discards a queued scan when its npm connection generation was replaced", async () => {
    dbMock.claimScanForRun.mockResolvedValue(true);
    dbMock.getNpmConnection.mockResolvedValue({
      id: "connection_2",
      registryUrl: "https://registry.npmjs.org",
      tokenFingerprint: "fp-new",
      validationStatus: "valid",
    });

    await expect(
      executeScanJob(env, ctx, message, {}, { attempt: 1, finalAttempt: true }),
    ).rejects.toThrow("npm connection was replaced");

    expect(dbMock.markNpmConnectionUsed).not.toHaveBeenCalled();
    expect(pipelineMock.runScanPipeline).not.toHaveBeenCalled();
    expect(dbMock.markScanFailed).not.toHaveBeenCalled();
    expect(dbMock.discardScanAttempt).toHaveBeenCalledWith(
      {},
      message.scanId,
      message.organizationId,
    );
    expect(notifyMock.notifyScanCompletion).not.toHaveBeenCalled();
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

  test("does not mark failed when a retryable error fires before exhaustion", async () => {
    dbMock.claimScanForRun.mockResolvedValue(true);
    pipelineMock.runScanPipeline.mockRejectedValue(
      new SandboxError(JSON.stringify({ error: "blip", status: 503 })),
    );

    await expect(
      executeScanJob(env, ctx, message, {}, { attempt: 1, finalAttempt: false }),
    ).rejects.toBeInstanceOf(SandboxError);

    expect(dbMock.markScanFailed).not.toHaveBeenCalled();
    expect(dbMock.discardScanAttempt).not.toHaveBeenCalled();
  });
});
