import { describe, expect, test, vi } from "vitest";
import {
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_SCHEMA_VERSION,
  recordProductEvent,
} from "../server/lib/platform/analytics.ts";

function fakeDataset() {
  const points = [];
  return {
    points,
    env: { PRODUCT_ANALYTICS: { writeDataPoint: (point) => points.push(point) } },
  };
}

describe("recordProductEvent", () => {
  test("writes a schema-versioned point with the event as the sampling index", () => {
    const { points, env } = fakeDataset();
    recordProductEvent(env, {
      name: "scan.completed",
      organizationId: "org_1",
      ecosystem: "npm",
      source: "auto_discovery",
      releaseRisk: "low",
      artifactRisk: "high",
      contextRisk: "high",
      durationMs: 4200,
      ruleFindingCount: 7,
      aiFindingCount: 1,
    });

    expect(points).toHaveLength(1);
    // The index is the sampling key: a high-volume event must not be able to
    // starve a low-volume one out of the dataset.
    expect(points[0].indexes).toEqual(["scan.completed"]);
    expect(points[0].blobs).toEqual([
      ANALYTICS_SCHEMA_VERSION,
      "scan.completed",
      "org_1",
      "npm",
      "auto_discovery",
      "low",
      "high",
      "high",
    ]);
    expect(points[0].doubles).toEqual([4200, 7, 1]);
  });

  test("public diff events carry no organization id", () => {
    const { points, env } = fakeDataset();
    recordProductEvent(env, {
      name: "public_diff.viewed",
      ecosystem: "pypi",
      packageName: "requests",
      cache: "hit",
      risk: "low",
      durationMs: 12,
    });

    // Anonymous by construction — the /diff endpoints have no session, and
    // nothing about the visitor may be recorded.
    expect(points[0].blobs[2]).toBe("");
    expect(points[0].blobs).toContain("requests");
  });

  test("is a no-op without the binding", () => {
    expect(() =>
      recordProductEvent(undefined, {
        name: "npm_connection.validated",
        organizationId: "org_1",
        outcome: "ok",
      }),
    ).not.toThrow();
    expect(() =>
      recordProductEvent(
        {},
        {
          name: "npm_connection.validated",
          organizationId: "org_1",
          outcome: "ok",
        },
      ),
    ).not.toThrow();
  });

  test("a failing dataset write never reaches the caller", () => {
    // Analytics is the least important thing in any request that emits it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = {
      PRODUCT_ANALYTICS: {
        writeDataPoint: () => {
          throw new Error("dataset unavailable");
        },
      },
    };
    expect(() =>
      recordProductEvent(env, {
        name: "scan.queued",
        organizationId: "org_1",
        ecosystem: "npm",
        source: "manual",
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("records no PII-shaped fields for any event in the union", () => {
    const { points, env } = fakeDataset();
    const events = [
      {
        name: "scan.completed",
        organizationId: "org_1",
        ecosystem: "npm",
        source: "manual",
        releaseRisk: "low",
        artifactRisk: "low",
        contextRisk: "low",
        durationMs: 1,
        ruleFindingCount: 0,
        aiFindingCount: 0,
      },
      { name: "npm_connection.validated", organizationId: "org_1", outcome: "ok" },
      {
        name: "public_diff.viewed",
        ecosystem: "npm",
        packageName: "left-pad",
        cache: "miss",
        risk: "low",
        durationMs: 3,
      },
      {
        name: "public_diff.verdict_served",
        ecosystem: "npm",
        packageName: "left-pad",
        grade: "clear",
        durationMs: 3,
      },
      { name: "scan.queued", organizationId: "org_1", ecosystem: "npm", source: "manual" },
      {
        name: "scan.failed",
        organizationId: "org_1",
        ecosystem: "npm",
        source: "manual",
        code: "staged_tarball_unavailable",
        durationMs: 10,
      },
      {
        name: "scan.decided",
        organizationId: "org_1",
        ecosystem: "npm",
        decision: "publish",
        releaseRisk: "low",
        artifactRisk: "high",
        timeToDecisionMs: 300_000,
      },
      {
        name: "ai_review.finished",
        organizationId: "org_1",
        ecosystem: "npm",
        status: "unavailable",
        model: "@cf/meta/llama",
        reviewerVersion: "1.0.0",
        durationMs: 50,
        findingCount: 0,
        steps: 1,
        inputTokens: 200,
        cachedInputTokens: 100,
        outputTokens: 20,
        totalTokens: 220,
      },
      {
        name: "ai_review.attempted",
        ecosystem: "npm",
        outcome: "rate_limited",
        action: "fallback",
        model: "@cf/meta/llama",
        reviewerVersion: "1.3.0",
        durationMs: 50,
        attempt: 1,
        steps: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      {
        name: "ai_review.decided",
        organizationId: "org_1",
        ecosystem: "npm",
        decision: "publish",
        status: "complete",
        releaseAssessment: "nothing_unusual",
        model: "@cf/meta/llama",
        reviewerVersion: "1.0.0",
      },
      {
        name: "scan.discarded",
        organizationId: "org_1",
        ecosystem: "npm",
        source: "auto_discovery",
        reason: "staged_tarball_unavailable",
        durationMs: 12,
      },
      { name: "user.signed_up", method: "email_password", outcome: "verification_pending" },
      { name: "organization.created", organizationId: "org_1" },
      { name: "integration.connected", organizationId: "org_1", kind: "github", outcome: "active" },
      { name: "workflow_gate.opened", organizationId: "org_1" },
      {
        name: "workflow_gate.reviewed",
        organizationId: "org_1",
        recommendation: "approve",
        timeoutState: "on_time",
        durationMs: 900,
        packageCount: 3,
      },
      {
        name: "workflow_gate.decided",
        organizationId: "org_1",
        surface: "human",
        decision: "approved",
        packageCount: 3,
      },
    ];
    for (const event of events) recordProductEvent(env, event);

    // Exhaustiveness: every arm of the AnalyticsEvent union must be exercised,
    // so adding an event without a privacy assertion fails here rather than
    // shipping unreviewed. ANALYTICS_EVENT_NAMES is tied to the union by a
    // compile-time assertion in analytics.ts, so this compares against the real
    // union rather than a second hand-maintained copy of it.
    expect([...new Set(events.map((event) => event.name))].sort()).toEqual(
      [...ANALYTICS_EVENT_NAMES].sort(),
    );

    // Blobs are a fixed positional schema; nothing here may look like an email,
    // an IP address, a bearer token, or a file path from a package.
    for (const point of points) {
      for (const blob of point.blobs) {
        expect(blob).not.toMatch(/@[\w.-]+\.\w+$/); // email
        expect(blob).not.toMatch(/^\d{1,3}(\.\d{1,3}){3}$/); // IPv4
        expect(blob).not.toMatch(/Bearer\s/i);
      }
    }
    // The model id legitimately contains a slash and an @; assert it is the
    // only such value and that it is a model, not a path.
    expect(new Set(points.flatMap((p) => p.blobs).filter((b) => b.includes("/")))).toEqual(
      new Set(["@cf/meta/llama"]),
    );
  });
});
