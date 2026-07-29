import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker, { redactCapabilityPath } from "../../server";

const HSTS_VALUE = "max-age=31536000; includeSubDomains; preload";

// HSTS guards against protocol-downgrade / SSL-stripping man-in-the-middle
// attacks by forcing clients onto HTTPS. It must ride on every response the
// Worker emits, including error responses, so a single missed path can't be the
// one a downgrade attack lands on. The static-asset delivery path is covered
// separately by test/security-headers.test.ts (public/_headers drift guard).
describe("worker security headers", () => {
  async function fetchHeaders(path: string, method = "GET"): Promise<Headers> {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`http://example.com${path}`, { method }), env, ctx);
    await waitOnExecutionContext(ctx);
    return res.headers;
  }

  test("sets a one-year HSTS policy with includeSubDomains and preload", async () => {
    const headers = await fetchHeaders("/api/health");
    expect(headers.get("Strict-Transport-Security")).toBe(HSTS_VALUE);
  });

  test("applies HSTS to non-API responses too", async () => {
    const headers = await fetchHeaders("/does-not-exist");
    expect(headers.get("Strict-Transport-Security")).toBe(HSTS_VALUE);
  });

  // Local-dev escape hatch: DISABLE_SECURITY_HEADERS skips the whole policy so
  // the strict CSP doesn't break Vite HMR and HSTS doesn't pin localhost to
  // HTTPS. The flag is absent from every deployed config (wrangler.jsonc /
  // test/config/wrangler.jsonc), so the tests above prove production fails closed.
  test("omits all security headers when DISABLE_SECURITY_HEADERS is set", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://example.com/api/health"),
      { ...env, DISABLE_SECURITY_HEADERS: "true" },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("X-Frame-Options")).toBeNull();
  });

  // The public report routes are Worker-owned but live outside /api/*, so they
  // need the locked-down API policy explicitly rather than inheriting the
  // document policy static assets get.
  test("serves the API CSP on the unauthenticated /public routes", async () => {
    const apiHeaders = await fetchHeaders("/api/health");
    const publicHeaders = await fetchHeaders(`/public/reports/${"A".repeat(43)}`);
    expect(publicHeaders.get("Content-Security-Policy")).toBe(
      apiHeaders.get("Content-Security-Policy"),
    );
    expect(publicHeaders.get("Strict-Transport-Security")).toBe(HSTS_VALUE);
    // Still readable by a cross-origin verifier even though it is a 404.
    expect(publicHeaders.get("access-control-allow-origin")).toBe("*");
  });
});

// A share link's capability IS its token, so it must never reach a log line.
describe("capability path redaction", () => {
  test("replaces the share token and leaves everything else alone", () => {
    const token = "A".repeat(43);
    expect(redactCapabilityPath(`/public/reports/${token}`)).toBe("/public/reports/:token");
    expect(redactCapabilityPath(`/public/reports/${token}/attestation`)).toBe(
      "/public/reports/:token/attestation",
    );
    // Percent-encoded and otherwise odd tokens are still one path segment.
    expect(redactCapabilityPath("/public/reports/%2e%2e%2f%2e%2e")).toBe("/public/reports/:token");
    expect(redactCapabilityPath("/public/reports/")).toBe("/public/reports/");
    expect(redactCapabilityPath("/public/attestation-key")).toBe("/public/attestation-key");
    expect(redactCapabilityPath("/api/v1/scans/scan_123")).toBe("/api/v1/scans/scan_123");
  });

  test("does not leave a token behind when the prefix is not at the start", () => {
    const token = "B".repeat(43);
    // Only the anchored prefix is a capability path; anything else must not be
    // silently treated as redacted when it still carries the token.
    expect(redactCapabilityPath(`/public/reports/${token}`)).not.toContain(token);
  });
});
