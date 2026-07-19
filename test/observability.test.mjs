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

  test("describes errors with sanitizable messages", () => {
    expect(describeOperationalError(new Error("D1_ERROR: column not found"))).toEqual({
      name: "Error",
      message: "D1_ERROR: column not found",
    });
  });

  test("surfaces the cause chain so wrapped D1 errors stay diagnosable", () => {
    // Drizzle wraps the real D1 failure: without the cause, the log only says
    // "Failed query" and the outage on the other end is invisible.
    const wrapped = new Error('Failed query: select "id" from "npm_connections"', {
      cause: new Error("D1_ERROR: Network connection lost."),
    });
    expect(describeOperationalError(wrapped)).toEqual({
      name: "Error",
      message: 'Failed query: select "id" from "npm_connections"',
      cause: { name: "Error", message: "D1_ERROR: Network connection lost." },
    });
  });

  test("bounds the described cause chain depth", () => {
    let err = new Error("level-5");
    for (let level = 4; level >= 0; level -= 1) {
      err = new Error(`level-${level}`, { cause: err });
    }
    let described = describeOperationalError(err);
    let depth = 0;
    while (described.cause) {
      described = described.cause;
      depth += 1;
    }
    expect(depth).toBe(3);
  });

  test("redacts bound parameters from failed-query messages", () => {
    const wrapped = new Error(
      'Failed query: update "npm_connections" set "last_used_at" = ? where "organization_id" = ?\nparams: 1784219455018,personal:abc123',
    );
    expect(describeOperationalError(wrapped).message).toBe(
      'Failed query: update "npm_connections" set "last_used_at" = ? where "organization_id" = ?\nparams: [redacted]',
    );
    // Non-query messages that merely mention params are left alone.
    expect(describeOperationalError(new Error("invalid params: foo")).message).toBe(
      "invalid params: foo",
    );
  });

  test("sanitizes error messages and causes inside logged fields", () => {
    const sanitized = sanitizeOperationalFields({
      error: new Error("upstream said Bearer abc123secret", {
        cause: new Error("also Bearer abc123secret"),
      }),
    });
    expect(sanitized).toEqual({
      error: {
        name: "Error",
        message: "upstream said Bearer [redacted]",
        cause: { name: "Error", message: "also Bearer [redacted]" },
      },
    });
  });
});
