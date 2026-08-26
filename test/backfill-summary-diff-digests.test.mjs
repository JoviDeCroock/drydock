import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { summaryDiffEntries } from "../server/lib/review/diff.ts";

// The backfill is a hand-written UPDATE that rewrites every production
// `summary_json` in place. It is the one piece of this change with no type
// checker behind it, so it runs here against real SQLite rather than being
// eyeballed: subtype loss through the aggregate subquery would silently store
// the rewritten array as a quoted *string*, and every reader would then see a
// scan with no diff at all.
const BACKFILL_SQL = readFileSync(
  fileURLToPath(new URL("../scripts/backfill-summary-diff-digests.sql", import.meta.url)),
  "utf8",
);

const DIFF = [
  {
    path: "index.js",
    status: "modified",
    previousSize: 10,
    stagedSize: 12,
    previousSha256: "a".repeat(64),
    stagedSha256: "b".repeat(64),
    flags: ["executable"],
  },
  { path: "added.js", status: "added", stagedSize: 4, stagedSha256: "c".repeat(64), flags: [] },
  {
    path: "gone.js",
    status: "removed",
    previousSize: 7,
    previousSha256: "d".repeat(64),
    flags: [],
  },
  { path: "same.js", status: "unchanged", previousSize: 1, stagedSize: 1, flags: [] },
];

function seedDb(rows) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE scans (id TEXT PRIMARY KEY, summary_json TEXT)");
  const insert = db.prepare("INSERT INTO scans (id, summary_json) VALUES (?, ?)");
  for (const [id, summary] of rows) insert.run(id, summary === null ? null : summary);
  return db;
}

function readSummary(db, id) {
  const row = db.prepare("SELECT summary_json AS s FROM scans WHERE id = ?").get(id);
  return row.s === null ? null : JSON.parse(row.s);
}

describe("backfill-summary-diff-digests.sql", () => {
  test("strips both digests while preserving every other field and the array order", () => {
    const summary = {
      report: { digest: "abc", version: 1 },
      packageJsonDiff: { name: "@org/pkg" },
      diff: DIFF,
      risk: { artifactRisk: "high" },
    };
    const db = seedDb([["scan_1", JSON.stringify(summary)]]);

    db.exec(BACKFILL_SQL);

    // Byte-for-byte the projection the pipeline now writes — the property the
    // report export's degraded fallback depends on.
    expect(readSummary(db, "scan_1")).toEqual({ ...summary, diff: summaryDiffEntries(DIFF) });
    db.close();
  });

  test("is idempotent and leaves rows without diff digests untouched", () => {
    const alreadyStripped = { diff: summaryDiffEntries(DIFF) };
    const noDiff = { risk: { artifactRisk: "low" } };
    const emptyDiff = { diff: [] };
    const db = seedDb([
      ["scan_stripped", JSON.stringify(alreadyStripped)],
      ["scan_no_diff", JSON.stringify(noDiff)],
      ["scan_empty", JSON.stringify(emptyDiff)],
      ["scan_null", null],
      ["scan_full", JSON.stringify({ diff: DIFF })],
    ]);

    db.exec(BACKFILL_SQL);
    const firstPass = readSummary(db, "scan_full");
    db.exec(BACKFILL_SQL);

    expect(readSummary(db, "scan_full")).toEqual(firstPass);
    expect(readSummary(db, "scan_stripped")).toEqual(alreadyStripped);
    expect(readSummary(db, "scan_no_diff")).toEqual(noDiff);
    expect(readSummary(db, "scan_empty")).toEqual(emptyDiff);
    expect(readSummary(db, "scan_null")).toBeNull();
    db.close();
  });

  test("rewrites the diff as JSON, not as a quoted string", () => {
    const db = seedDb([["scan_1", JSON.stringify({ diff: DIFF })]]);

    db.exec(BACKFILL_SQL);

    const type = db
      .prepare("SELECT json_type(summary_json, '$.diff') AS t FROM scans WHERE id = 'scan_1'")
      .get();
    expect(type.t).toBe("array");
    db.close();
  });
});
