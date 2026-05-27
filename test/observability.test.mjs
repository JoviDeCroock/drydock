import { describe, expect, test, vi } from "vitest";

const {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
  sanitizeOperationalFields,
} = await import("../server/lib/observability.ts");

describe("operational observability helpers", () => {
  test("redacts token-like fields before logging", () => {
    const sanitized = sanitizeOperationalFields({
      scanId: "scan_1",
      npmToken: "npm_secret_token",
      nested: {
        authorization: "Bearer abc123secret",
        tokenFingerprint: "fp_should_not_log",
      },
      message: "upstream said Bearer abc123secret",
    });

    expect(sanitized).toEqual({
      scanId: "scan_1",
      npmToken: "[redacted]",
      nested: {
        authorization: "[redacted]",
        tokenFingerprint: "[redacted]",
      },
      message: "upstream said Bearer [redacted]",
    });
  });

  test("logs structured events with bounded duration fields", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      emitOperationalEvent("warn", "scan.queue.retry_scheduled", {
        scanId: "scan_1",
        durationMs: durationMsSince(100, 175),
        token: "npm_secret_token",
      });

      expect(spy).toHaveBeenCalledWith("scan.queue.retry_scheduled", {
        event: "scan.queue.retry_scheduled",
        scanId: "scan_1",
        durationMs: 75,
        token: "[redacted]",
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("describes errors without carrying raw messages", () => {
    expect(describeOperationalError(new Error("D1_ERROR: column not found"))).toEqual({
      name: "Error",
    });
  });
});
