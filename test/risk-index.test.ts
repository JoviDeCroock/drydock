import { describe, expect, test } from "vitest";
import { unpinnedFindings } from "../src/features/review/risk-index";
import type { FindingWithDiffStatus } from "../src/features/review/types";
import { RELEASE_PROCESS_FINDING_FILE } from "../server/lib/release-fingerprint";

function item(
  id: string,
  overrides: Partial<FindingWithDiffStatus["finding"]> = {},
  releaseDelta = true,
): FindingWithDiffStatus {
  return {
    finding: {
      id,
      severity: "high",
      file: "index.js",
      line: 3,
      evidence: "evidence",
      reason: "reason",
      source: "rule",
      ...overrides,
    },
    diffStatus: releaseDelta ? "modified" : "unchanged",
    releaseDelta,
  };
}

describe("unpinnedFindings", () => {
  const diffPaths = new Set(["index.js", "dist/addon.node"]);

  test("drops a release finding the diff pins to a changed line", () => {
    expect(unpinnedFindings([item("pinned")], diffPaths)).toEqual([]);
  });

  test("keeps everything the diff has no changed line for", () => {
    const kept = [
      item("context", {}, false),
      item("ai", { source: "ai" }),
      item("release-process", { file: RELEASE_PROCESS_FINDING_FILE }),
      item("whole-file", { file: "dist/addon.node", line: null }),
      item("outside-comparison", { file: "lib/other.js" }),
    ];
    expect(unpinnedFindings([item("pinned"), ...kept], diffPaths).map((x) => x.finding.id)).toEqual(
      kept.map((x) => x.finding.id),
    );
  });
});
