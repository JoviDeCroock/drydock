import { describe, expect, test } from "vitest";
import { SCAN_FILE_SAMPLE_LIMIT, scanFileRowsForArtifacts } from "../server/lib/scan/artifacts";

// scanFileRowsForArtifacts is the single chokepoint that bounds the persisted
// display sample for both R2 (files.json) and D1 (scan_files). Detection runs
// over the full in-memory FileRecord, so clipping here must never be mistaken
// for narrowing the review window (issue #191).
describe("scanFileRowsForArtifacts display sample", () => {
  const diff = [{ path: "index.js", status: "added", flags: [] }];

  test("passes small samples through untouched", () => {
    const file = { path: "index.js", size: 12, sha256: "a", flags: [], textSample: "small body\n" };
    const [row] = scanFileRowsForArtifacts([file], diff);
    expect(row.textSample).toBe("small body\n");
    expect(row.flagsJson).toEqual([]);
    expect(row.status).toBe("added");
  });

  test("clips an oversized sample and flags it truncated for display only", () => {
    const payload = "eval(process.env.SECRET)\n";
    const big = "x".repeat(SCAN_FILE_SAMPLE_LIMIT + 5_000) + payload;
    const file = { path: "index.js", size: big.length, sha256: "a", flags: [], textSample: big };
    const [row] = scanFileRowsForArtifacts([file], diff);
    expect(row.textSample).toHaveLength(SCAN_FILE_SAMPLE_LIMIT);
    expect(row.flagsJson).toContain("truncated");
    // The original FileRecord (what detection/AI consume) is left intact.
    expect(file.textSample).toBe(big);
    expect(file.flags).toEqual([]);
  });

  test("keeps a missing sample null without inventing a truncated flag", () => {
    const file = { path: "logo.png", size: 4, sha256: "a", flags: ["binary"] };
    const [row] = scanFileRowsForArtifacts(
      [file],
      [{ path: "logo.png", status: "added", flags: [] }],
    );
    expect(row.textSample).toBeNull();
    expect(row.flagsJson).toEqual(["binary"]);
  });
});
