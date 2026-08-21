import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_QUERIES,
  assertAggregateOnly,
  assertRowShape,
  parseSnapshotArgs,
  resolveSnapshotDir,
} from "../scripts/ops-snapshot.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("ops snapshot queries", () => {
  it("every shipped query is an aggregate-only SELECT", () => {
    expect(SNAPSHOT_QUERIES.length).toBeGreaterThanOrEqual(5);
    for (const query of SNAPSHOT_QUERIES) {
      expect(() => assertAggregateOnly(query)).not.toThrow();
    }
  });

  it("covers the standard operator dimensions", () => {
    const names = SNAPSHOT_QUERIES.map((query) => query.name);
    expect(names).toContain("scan_volume_by_day_14d");
    expect(names).toContain("scans_by_source");
    expect(names).toContain("finding_counts_by_rule");
    expect(names).toContain("gate_decisions_by_outcome");
    expect(names).toContain("scan_events_by_type_14d");
  });

  it("rejects non-SELECT statements", () => {
    expect(() => assertAggregateOnly({ name: "bad", sql: "DELETE FROM scans" })).toThrow(
      /must be a SELECT/,
    );
  });

  it("rejects unaggregated row dumps", () => {
    expect(() => assertAggregateOnly({ name: "bad", sql: "SELECT status FROM scans" })).toThrow(
      /GROUP BY count aggregate/,
    );
  });

  it("rejects queries touching identifier columns", () => {
    for (const column of [
      "organization_id",
      "package_name",
      "stage_id",
      "email",
      "owner_user_id",
    ]) {
      expect(() =>
        assertAggregateOnly({
          name: "bad",
          sql: `SELECT ${column}, COUNT(*) AS n FROM scans GROUP BY ${column}`,
        }),
      ).toThrow(/forbidden identifier column/);
    }
  });

  it("rejects result rows carrying undeclared columns", () => {
    const query = { name: "scans_by_source", columns: ["source", "scans"] };
    expect(() => assertRowShape(query, [{ source: "manual", scans: 3 }])).not.toThrow();
    expect(() =>
      assertRowShape(query, [{ source: "manual", scans: 3, organization_id: "org_123" }]),
    ).toThrow(/unexpected column "organization_id"/);
  });
});

describe("ops snapshot output directory", () => {
  it("defaults to ~/.drydock-ops/snapshots outside the repo", () => {
    const dir = resolveSnapshotDir({}, repoRoot);
    expect(dir.endsWith(path.join(".drydock-ops", "snapshots"))).toBe(true);
    expect(path.relative(repoRoot, dir).startsWith("..")).toBe(true);
  });

  it("refuses an output directory inside the repository", () => {
    expect(() =>
      resolveSnapshotDir({ DRYDOCK_OPS_DIR: path.join(repoRoot, "ops") }, repoRoot),
    ).toThrow(/inside the repository/);
    expect(() => resolveSnapshotDir({ DRYDOCK_OPS_DIR: repoRoot }, repoRoot)).toThrow(
      /inside the repository/,
    );
  });

  it("accepts an explicit directory outside the repository", () => {
    const outside = path.resolve(repoRoot, "..", "drydock-ops-scratch");
    expect(resolveSnapshotDir({ DRYDOCK_OPS_DIR: outside }, repoRoot)).toBe(
      path.join(outside, "snapshots"),
    );
  });
});

describe("ops snapshot argument parsing", () => {
  it("defaults to the remote production database", () => {
    const options = parseSnapshotArgs([], {});
    expect(options.mode).toBe("remote");
    expect(options.database).toBe("staged-publish-review");
    expect(options.wranglerBin).toBe("pnpm");
    expect(options.wranglerPrefix).toEqual(["exec", "wrangler"]);
  });

  it("supports local validation flags", () => {
    const options = parseSnapshotArgs(
      ["--local", "--database", "staged-publish-review-e2e", "--persist-to", "/tmp/state"],
      {},
    );
    expect(options.mode).toBe("local");
    expect(options.database).toBe("staged-publish-review-e2e");
    expect(options.persistTo).toBe("/tmp/state");
  });

  it("rejects unknown arguments", () => {
    expect(() => parseSnapshotArgs(["--drop-tables"], {})).toThrow(/unknown argument/);
  });
});
