import { describe, expect, test } from "vitest";
import { packageDecisionNeedsAttention } from "../src/pages/Dashboard/ScanDetail/GateDecisionDialog";

describe("gate package row attention", () => {
  test("colors only the rows holding the release up", () => {
    expect(packageDecisionNeedsAttention({ decision: "no_publish", status: "complete" })).toBe(
      true,
    );
    expect(packageDecisionNeedsAttention({ decision: null, status: "failed" })).toBe(true);
    expect(packageDecisionNeedsAttention({ decision: null, status: "complete" })).toBe(false);
    expect(packageDecisionNeedsAttention({ decision: null, status: "running" })).toBe(false);
    expect(packageDecisionNeedsAttention({ decision: "publish", status: "complete" })).toBe(false);
  });

  test("an approval over a failed review reads as the decision, not an alarm", () => {
    expect(packageDecisionNeedsAttention({ decision: "publish", status: "failed" })).toBe(false);
  });
});
