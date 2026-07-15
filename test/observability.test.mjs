import { describe, expect, test, vi } from "vitest";

const {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
  projectOperationalEvent,
  sanitizeOperationalFields,
} = await import("../server/lib/observability.ts");
const { withTelemetryContext } = await import("../server/lib/telemetry/context.ts");

describe("operational telemetry contract", () => {
  test("redacts denied keys, bearer values, and arbitrary error messages", () => {
    const sanitized = sanitizeOperationalFields({
      scanId: "scan_1",
      npmToken: "npm_secret_token",
      nested: {
        authorization: "Bearer abc123secret",
        tokenFingerprint: "fp_should_not_log",
      },
      message: "upstream said Bearer abc123secret",
      error: new Error("D1_ERROR: column not found"),
    });

    expect(sanitized).toEqual({
      scanId: "scan_1",
      npmToken: "[redacted]",
      nested: {
        authorization: "[redacted]",
        tokenFingerprint: "[redacted]",
      },
      message: "[redacted]",
      error: { code: "internal.unclassified" },
    });
  });

  test("logs one versioned top-level object with correlation and a stable failure envelope", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const telemetry = withTelemetryContext(
        {
          requestId: "req_12345678",
          journeyId: "jny_12345678",
          serviceVersion: "version_1",
          environment: "test",
        },
        () =>
          emitOperationalEvent("warn", "scan.queue.retry_scheduled", {
            scanId: "scan_1",
            organizationId: "org_1",
            durationMs: durationMsSince(100, 175),
            attempt: 2,
            error: {
              code: "sandbox_download_transient",
              message: "Bearer upstream-secret",
              retryable: true,
            },
          }),
      );

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(telemetry);
      expect(telemetry).toMatchObject({
        event: {
          id: expect.stringMatching(/^evt_/),
          name: "scan.queue.retry_scheduled",
          version: 1,
          occurred_at: expect.any(String),
        },
        service: { version: "version_1", environment: "test" },
        correlation: {
          request_id: "req_12345678",
          journey_id: "jny_12345678",
          scan_id: "scan_1",
        },
        tenant: { organization_id: "org_1" },
        outcome: {
          status: "retry",
          error: {
            code: "sandbox_download_transient",
            class: "external_dependency",
            phase: "artifact_acquisition",
            retryable: true,
            fingerprint: expect.stringMatching(/^v1:/),
          },
        },
        measurements: { duration_ms: 75, attempt: 2, count: 1 },
      });
      expect(JSON.stringify(telemetry)).not.toContain("upstream-secret");
    } finally {
      spy.mockRestore();
    }
  });

  test("uses explicit sink allowlists for package-derived and free-form fields", () => {
    const telemetry = projectOperationalEvent("error", "scan.pipeline.failed", {
      scanId: "scan_1",
      organizationId: "org_1",
      packageName: "private-package-name",
      stageId: "private-stage-id",
      path: "/private/package/path",
      reason: "external response body",
      error: { code: "archive_invalid", retryable: false },
    });
    const serialized = JSON.stringify(telemetry);
    expect(serialized).not.toContain("private-package-name");
    expect(serialized).not.toContain("private-stage-id");
    expect(serialized).not.toContain("external response body");
    expect(serialized).not.toContain("/private/package/path");
    expect(telemetry.outcome.error).toMatchObject({
      code: "archive_invalid",
      class: "policy_block",
      customer_visible: true,
    });
    expect(telemetry.outcome.reference_id).toMatch(/^ref_/);
  });

  test("describes unknown errors without copying their name or message", () => {
    expect(describeOperationalError(new Error("D1_ERROR: column not found"))).toEqual({
      code: "internal.unclassified",
      retryable: true,
      customerVisible: false,
    });
  });
});
