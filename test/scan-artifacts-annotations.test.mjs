import { describe, expect, test } from "vitest";
import { parseReportFindings } from "../server/lib/scan/artifacts/parse";

describe("persisted finding annotations", () => {
  const finding = {
    severity: "high",
    file: "index.js",
    evidence: "e",
    reason: "r",
    ruleId: "code.process-execution",
  };
  const parse = (annotation) =>
    [
      ...parseReportFindings(
        JSON.stringify({ ruleFindings: [finding], findingAnnotations: [annotation] }),
        "scan-1",
      ).annotations.values(),
    ][0];

  test("keeps an expanded release-delta marker", () => {
    expect(
      parse({
        findingIndex: 0,
        diffStatus: "modified",
        releaseDelta: true,
        releaseDeltaKind: "expanded",
      }),
    ).toEqual({
      diffStatus: "modified",
      releaseDelta: true,
      releaseDeltaKind: "expanded",
    });
  });

  test("drops the marker from reports that predate it, off the delta, or with unknown values", () => {
    expect(parse({ findingIndex: 0, diffStatus: "modified", releaseDelta: true })).toEqual({
      diffStatus: "modified",
      releaseDelta: true,
    });
    expect(
      parse({
        findingIndex: 0,
        diffStatus: "unchanged",
        releaseDelta: false,
        releaseDeltaKind: "expanded",
      }),
    ).toEqual({
      diffStatus: "unchanged",
      releaseDelta: false,
    });
    expect(
      parse({
        findingIndex: 0,
        diffStatus: "modified",
        releaseDelta: true,
        releaseDeltaKind: "bogus",
      }),
    ).toEqual({
      diffStatus: "modified",
      releaseDelta: true,
    });
  });
});
