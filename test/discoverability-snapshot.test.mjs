import { describe, expect, test } from "vitest";
import {
  parseSnapshotArgs,
  runDiscoverabilitySnapshot,
  snapshotQueries,
} from "../scripts/discoverability-snapshot.mjs";

describe("discoverability snapshot", () => {
  test("uses sampled aggregate counts without visitor or customer dimensions", () => {
    const queries = snapshotQueries("drydock_product_events", 28);
    expect(queries).toHaveLength(4);
    for (const query of queries) {
      expect(query.sql).toContain("SUM(_sample_interval)");
      expect(query.sql).toContain("INTERVAL '28' DAY");
      expect(query.sql).not.toMatch(/blob3|organization_id|package_name|user_id|email|ip_address/i);
    }
  });

  test("rejects interpolated identifiers and unreasonable windows", () => {
    expect(() => snapshotQueries("events; DROP TABLE events", 28)).toThrow("SQL identifier");
    expect(() => snapshotQueries("events", 0)).toThrow("1 to 90");
    expect(() => snapshotQueries("events", 91)).toThrow("1 to 90");
  });

  test("parses operator settings from dedicated Drydock variables", () => {
    expect(
      parseSnapshotArgs(["--days", "14"], {
        DRYDOCK_CF_ACCOUNT_ID: "a".repeat(32),
        DRYDOCK_CF_ANALYTICS_TOKEN: "secret",
      }),
    ).toMatchObject({ accountId: "a".repeat(32), token: "secret", days: 14 });
  });

  test("queries the Cloudflare SQL endpoint and never returns the token", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return Response.json([{ event: "public_diff.viewed", events: 12 }]);
    };
    const report = await runDiscoverabilitySnapshot(
      {
        accountId: "a".repeat(32),
        token: "top-secret",
        dataset: "drydock_product_events",
        days: 28,
      },
      fetchImpl,
    );

    expect(calls).toHaveLength(4);
    expect(calls[0].url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/analytics_engine/sql`,
    );
    expect(calls.every((call) => call.init.method === "POST")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("top-secret");
    expect(report.queries.discovery_outcomes).toEqual([
      { event: "public_diff.viewed", events: 12 },
    ]);
  });

  test("reports status only when a query fails", async () => {
    await expect(
      runDiscoverabilitySnapshot(
        {
          accountId: "a".repeat(32),
          token: "must-not-leak",
          dataset: "drydock_product_events",
          days: 28,
        },
        async () => new Response("denied", { status: 403 }),
      ),
    ).rejects.not.toThrow("must-not-leak");
  });
});
