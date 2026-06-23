import { describe, expect, test } from "vitest";
import {
  computeNextNpmConnectionDiscovery,
  DISCOVERY_ACTIVE_INTERVAL_MS,
  DISCOVERY_QUIET_INTERVALS_MS,
} from "../server/db/npm-connections.ts";
import {
  allowInsecureLocalRegistry,
  isLoopbackHostname,
  publicNpmConnection,
  registryProtocolAllowed,
} from "../server/lib/npm-connection.ts";

describe("isLoopbackHostname", () => {
  test("identifies localhost", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("Localhost")).toBe(true);
    expect(isLoopbackHostname("LOCALHOST")).toBe(true);
  });

  test("identifies 127.0.0.1", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
  });

  test("identifies ::1 (IPv6 loopback)", () => {
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  test("identifies long-form IPv6 loopback", () => {
    expect(isLoopbackHostname("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isLoopbackHostname("[0:0:0:0:0:0:0:1]")).toBe(true);
  });

  test("rejects non-loopback hostnames", () => {
    expect(isLoopbackHostname("registry.npmjs.org")).toBe(false);
    expect(isLoopbackHostname("192.168.1.1")).toBe(false);
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
    expect(isLoopbackHostname("example.com")).toBe(false);
  });
});

describe("computeNextNpmConnectionDiscovery", () => {
  const now = new Date("2026-06-23T12:00:00.000Z");

  test("keeps active discoveries on the base cadence and resets quiet backoff", () => {
    const schedule = computeNextNpmConnectionDiscovery({
      outcome: "active",
      currentBackoffLevel: 2,
      now,
      jitterMs: 0,
    });

    expect(schedule.discoveryBackoffLevel).toBe(0);
    expect(schedule.delayMs).toBe(DISCOVERY_ACTIVE_INTERVAL_MS);
    expect(schedule.nextDiscoveryAt.getTime()).toBe(now.getTime() + DISCOVERY_ACTIVE_INTERVAL_MS);
  });

  test("backs quiet connections off through the capped intervals", () => {
    const firstQuiet = computeNextNpmConnectionDiscovery({
      outcome: "quiet",
      currentBackoffLevel: 0,
      now,
      jitterMs: 0,
    });
    const cappedQuiet = computeNextNpmConnectionDiscovery({
      outcome: "quiet",
      currentBackoffLevel: 99,
      now,
      jitterMs: 0,
    });

    expect(firstQuiet.discoveryBackoffLevel).toBe(1);
    expect(firstQuiet.delayMs).toBe(DISCOVERY_QUIET_INTERVALS_MS[0]);
    expect(cappedQuiet.discoveryBackoffLevel).toBe(DISCOVERY_QUIET_INTERVALS_MS.length);
    expect(cappedQuiet.delayMs).toBe(
      DISCOVERY_QUIET_INTERVALS_MS[DISCOVERY_QUIET_INTERVALS_MS.length - 1],
    );
  });

  test("keeps retry discoveries on the base cadence without changing backoff", () => {
    const schedule = computeNextNpmConnectionDiscovery({
      outcome: "retry",
      currentBackoffLevel: 2,
      now,
      jitterMs: 0,
    });

    expect(schedule.discoveryBackoffLevel).toBe(2);
    expect(schedule.delayMs).toBe(DISCOVERY_ACTIVE_INTERVAL_MS);
  });
});

describe("registryProtocolAllowed", () => {
  test("allows https always", () => {
    const url = new URL("https://registry.npmjs.org");
    expect(registryProtocolAllowed(url)).toBe(true);
  });

  test("rejects http by default", () => {
    const url = new URL("http://registry.npmjs.org");
    expect(registryProtocolAllowed(url)).toBe(false);
  });

  test("allows http for loopback when allowInsecureLocalhost is true", () => {
    const url = new URL("http://localhost:4873");
    expect(registryProtocolAllowed(url, { allowInsecureLocalhost: true })).toBe(true);
  });

  test("still rejects http for non-loopback even with allowInsecureLocalhost", () => {
    const url = new URL("http://registry.npmjs.org");
    expect(registryProtocolAllowed(url, { allowInsecureLocalhost: true })).toBe(false);
  });

  test("allows http for 127.0.0.1 when allowInsecureLocalhost is true", () => {
    const url = new URL("http://127.0.0.1:5000");
    expect(registryProtocolAllowed(url, { allowInsecureLocalhost: true })).toBe(true);
  });
});

describe("allowInsecureLocalRegistry", () => {
  test("returns true when ALLOW_INSECURE_LOCAL_REGISTRY is 'true'", () => {
    expect(allowInsecureLocalRegistry({ ALLOW_INSECURE_LOCAL_REGISTRY: "true" })).toBe(true);
  });

  test("returns false for other values", () => {
    expect(allowInsecureLocalRegistry({ ALLOW_INSECURE_LOCAL_REGISTRY: "false" })).toBe(false);
    expect(allowInsecureLocalRegistry({ ALLOW_INSECURE_LOCAL_REGISTRY: undefined })).toBe(false);
    expect(allowInsecureLocalRegistry({ ALLOW_INSECURE_LOCAL_REGISTRY: "1" })).toBe(false);
  });
});

describe("publicNpmConnection", () => {
  test("returns null for null input", () => {
    expect(publicNpmConnection(null)).toBe(null);
  });

  test("returns null for undefined input", () => {
    expect(publicNpmConnection(undefined)).toBe(null);
  });

  test("strips sensitive fields and returns public shape", () => {
    const connection = {
      id: "conn-1",
      organizationId: "org-1",
      registryUrl: "https://registry.npmjs.org",
      label: "My Token",
      tokenFingerprint: "fp-xyz",
      tokenLast4: "ab12",
      tokenCiphertext: "SECRET_CIPHER",
      tokenNonce: "SECRET_NONCE",
      validationStatus: "valid",
      capabilitiesJson: { registryAuth: true },
      validatedAt: "2024-01-01T00:00:00Z",
      lastUsedAt: null,
      createdByUserId: "user-1",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    const result = publicNpmConnection(connection);
    expect(result).toEqual({
      id: "conn-1",
      organizationId: "org-1",
      registryUrl: "https://registry.npmjs.org",
      label: "My Token",
      tokenFingerprint: "fp-xyz",
      tokenLast4: "ab12",
      validationStatus: "valid",
      capabilitiesJson: { registryAuth: true },
      validatedAt: "2024-01-01T00:00:00Z",
      lastUsedAt: null,
      createdByUserId: "user-1",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });
    expect(result).not.toHaveProperty("tokenCiphertext");
    expect(result).not.toHaveProperty("tokenNonce");
  });
});
