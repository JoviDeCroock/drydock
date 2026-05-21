import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const { classifyScanError, retryDelaySeconds } = await import("../server/lib/scan-job.ts");
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
        new SandboxError(JSON.stringify({ error: "download failed", status: 403 })),
      ),
    ).toMatchObject({
      code: "staged_tarball_unavailable",
      retryable: false,
    });
  });

  test("uses bounded quadratic retry delays", () => {
    expect(retryDelaySeconds(1)).toBe(5);
    expect(retryDelaySeconds(2)).toBe(20);
    expect(retryDelaySeconds(10)).toBe(60);
  });
});
