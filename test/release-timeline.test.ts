import { describe, expect, test } from "vitest";
import {
  buildReleaseTimeline,
  formatDelta,
} from "../src/pages/Dashboard/ScanDetail/release-timeline";

const T0 = Date.UTC(2026, 8, 3, 10, 0, 0);
const minutes = (n: number) => n * 60 * 1000;

function scan(overrides: Partial<Parameters<typeof buildReleaseTimeline>[0]> = {}) {
  return {
    status: "complete",
    createdAt: T0 + minutes(1),
    startedAt: null,
    completedAt: null,
    decision: null,
    decidedAt: null,
    decidedByName: null,
    registryVersionStatus: null,
    registryVersionStatusAt: null,
    registryStatusSupersededAt: null,
    ...overrides,
  };
}

describe("buildReleaseTimeline", () => {
  test("orders every dated event oldest first, whatever order the fields arrive in", () => {
    const events = buildReleaseTimeline(
      scan({
        decision: "publish",
        decidedAt: T0 + minutes(30),
        decidedByName: "Jane",
        registryVersionStatus: "staged",
        registryVersionStatusAt: T0 + minutes(12),
        completedAt: T0 + minutes(5),
        startedAt: T0 + minutes(2),
      }),
      { stagedPublish: { createdAt: new Date(T0).toISOString() } },
    );
    expect(events.map((event) => event.key)).toEqual([
      "staged",
      "queued",
      "started",
      "completed",
      "registry_status",
      "decided",
    ]);
    expect(events.map((event) => event.at)).toEqual([
      T0,
      T0 + minutes(1),
      T0 + minutes(2),
      T0 + minutes(5),
      T0 + minutes(12),
      T0 + minutes(30),
    ]);
    expect(events.find((event) => event.key === "decided")?.detail).toBe("publish · by Jane");
  });

  test("omits events without a timestamp instead of inventing one", () => {
    const events = buildReleaseTimeline(scan(), {});
    expect(events.map((event) => event.key)).toEqual(["queued"]);
  });

  test("an unknown npm status renders nothing, validating and staged use the documented phrasing", () => {
    const at = T0 + minutes(3);
    expect(
      buildReleaseTimeline(
        scan({ registryVersionStatus: null, registryVersionStatusAt: at }),
        {},
      ).some((event) => event.key === "registry_status"),
    ).toBe(false);
    expect(
      buildReleaseTimeline(
        scan({ registryVersionStatus: "quarantined", registryVersionStatusAt: at }),
        {},
      ).some((event) => event.key === "registry_status"),
    ).toBe(false);
    expect(
      buildReleaseTimeline(
        scan({ registryVersionStatus: "validating", registryVersionStatusAt: at }),
        {},
      ).find((event) => event.key === "registry_status")?.detail,
    ).toBe("npm is still validating");
    expect(
      buildReleaseTimeline(
        scan({ registryVersionStatus: "staged", registryVersionStatusAt: at }),
        {},
      ).find((event) => event.key === "registry_status")?.detail,
    ).toBe("approvable on npm");
    expect(
      buildReleaseTimeline(
        scan({ registryVersionStatus: "blocked", registryVersionStatusAt: at }),
        {},
      ).find((event) => event.key === "registry_status")?.detail,
    ).toBe("blocked by npm's validation");
  });

  test("a superseded review drops its stale npm status and shows the supersession instead", () => {
    const events = buildReleaseTimeline(
      scan({
        registryVersionStatus: "staged",
        registryVersionStatusAt: T0 + minutes(3),
        registryStatusSupersededAt: T0 + minutes(40),
      }),
      {},
    );
    expect(events.map((event) => event.key)).toEqual(["queued", "superseded"]);
  });

  test("a decision without a recorded time is not shown, and an unknown decision value is ignored", () => {
    expect(
      buildReleaseTimeline(scan({ decision: "publish", decidedAt: null }), {}).some(
        (event) => event.key === "decided",
      ),
    ).toBe(false);
    expect(
      buildReleaseTimeline(scan({ decision: "maybe", decidedAt: T0 + minutes(2) }), {}).some(
        (event) => event.key === "decided",
      ),
    ).toBe(false);
    expect(
      buildReleaseTimeline(scan({ decision: "no_publish", decidedAt: T0 + minutes(2) }), {}).find(
        (event) => event.key === "decided",
      )?.detail,
    ).toBe("do not publish");
  });

  test("ignores unparseable timestamps and a non-string stage creation time", () => {
    const events = buildReleaseTimeline(scan({ startedAt: "not a date" }), {
      stagedPublish: { createdAt: 12345 as unknown as string },
    });
    expect(events.map((event) => event.key)).toEqual(["queued"]);
  });

  test("a failed review names its terminal stamp as a failure, not a completion", () => {
    const events = buildReleaseTimeline(
      scan({ status: "failed", completedAt: T0 + minutes(4) }),
      {},
    );
    expect(events.find((event) => event.key === "completed")?.label).toBe("Review failed");
  });

  test("ties keep pipeline order so a same-millisecond start and completion stay readable", () => {
    const at = T0 + minutes(1);
    const events = buildReleaseTimeline(scan({ completedAt: at, startedAt: at }), {});
    expect(events.map((event) => event.key)).toEqual(["queued", "started", "completed"]);
  });
});

describe("formatDelta", () => {
  test("scales its unit with the gap", () => {
    expect(formatDelta(0)).toBe("+0s");
    expect(formatDelta(999)).toBe("+0s");
    expect(formatDelta(42_000)).toBe("+42s");
    expect(formatDelta(minutes(12))).toBe("+12m");
    expect(formatDelta(minutes(185))).toBe("+3h 05m");
    expect(formatDelta(minutes(60 * 52))).toBe("+2d 4h");
    expect(formatDelta(minutes(60 * 48))).toBe("+2d");
  });

  test("never renders a negative gap", () => {
    expect(formatDelta(-5000)).toBe("+0s");
  });
});
