import { describe, expect, test } from "vitest";
import {
  annotationLabel,
  maxSeverity,
  partitionFindingsByLine,
  severityGroup,
} from "../src/components/diff-annotations.ts";

describe("maxSeverity", () => {
  test("returns the higher-ranked severity", () => {
    expect(maxSeverity("low", "critical")).toBe("critical");
    expect(maxSeverity("critical", "low")).toBe("critical");
    expect(maxSeverity("medium", "high")).toBe("high");
    expect(maxSeverity("ok", "info")).toBe("info");
  });

  test("treats null as 'no severity yet'", () => {
    expect(maxSeverity(null, "medium")).toBe("medium");
    expect(maxSeverity("medium", null)).toBe("medium");
    expect(maxSeverity(null, null)).toBeNull();
  });

  test("ranks an unknown severity below any known one", () => {
    expect(maxSeverity("weird", "ok")).toBe("ok");
  });
});

describe("severityGroup", () => {
  test("maps the six severities onto the four chromatic groups", () => {
    expect(severityGroup("critical")).toBe("danger");
    expect(severityGroup("high")).toBe("danger");
    expect(severityGroup("medium")).toBe("warn");
    expect(severityGroup("low")).toBe("info");
    expect(severityGroup("info")).toBe("info");
    expect(severityGroup("ok")).toBe("ok");
  });

  test("falls back to info for an unknown severity", () => {
    expect(severityGroup("weird")).toBe("info");
  });
});

describe("annotationLabel", () => {
  test("joins ruleId and line with the metadata separator", () => {
    expect(annotationLabel({ ruleId: "NPM_LIFECYCLE_SCRIPT", line: 7 })).toBe(
      "NPM_LIFECYCLE_SCRIPT · line 7",
    );
  });

  test("renders either part alone", () => {
    expect(annotationLabel({ ruleId: "RULE", line: null })).toBe("RULE");
    expect(annotationLabel({ ruleId: null, line: 12 })).toBe("line 12");
  });

  test("returns null when neither part is present", () => {
    expect(annotationLabel({ ruleId: null, line: null })).toBeNull();
  });
});

describe("partitionFindingsByLine", () => {
  const present = new Set([1, 2, 7]);

  test("pins findings whose line is present in the rendered sample", () => {
    const { pinned, unpinned } = partitionFindingsByLine(
      [
        { id: "a", line: 7 },
        { id: "b", line: 1 },
      ],
      present,
    );
    expect(pinned.get(7)?.map((f) => f.id)).toEqual(["a"]);
    expect(pinned.get(1)?.map((f) => f.id)).toEqual(["b"]);
    expect(unpinned).toEqual([]);
  });

  test("groups multiple findings on the same line, preserving order", () => {
    const { pinned } = partitionFindingsByLine(
      [
        { id: "a", line: 7 },
        { id: "b", line: 7 },
      ],
      present,
    );
    expect(pinned.get(7)?.map((f) => f.id)).toEqual(["a", "b"]);
  });

  test("treats line-less findings as unpinned", () => {
    const { pinned, unpinned } = partitionFindingsByLine(
      [{ id: "a", line: null }, { id: "b" }],
      present,
    );
    expect(pinned.size).toBe(0);
    expect(unpinned.map((f) => f.id)).toEqual(["a", "b"]);
  });

  test("treats a line outside the sample as unpinned so it is never hidden", () => {
    const { unpinned } = partitionFindingsByLine([{ id: "a", line: 999 }], present);
    expect(unpinned.map((f) => f.id)).toEqual(["a"]);
  });
});
