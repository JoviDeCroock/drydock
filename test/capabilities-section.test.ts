import { describe, expect, test } from "vitest";
import { capabilityDeltaDescription } from "../src/features/review/CapabilitiesSection";
import type { CapabilityDelta, CapabilitySet } from "../server/lib/review";

function side(overrides: Partial<CapabilitySet> = {}): CapabilitySet {
  return { capabilities: [], inspectedFiles: 1, uninspectedFiles: 0, complete: true, ...overrides };
}

describe("capabilityDeltaDescription", () => {
  test("does not claim no changes when the comparison is incomplete", () => {
    const delta: CapabilityDelta = {
      from: side(),
      to: side({ uninspectedFiles: 1, complete: false }),
      escalations: [],
      reductions: [],
      confident: false,
    };

    const description = capabilityDeltaDescription(delta);
    expect(description).not.toContain("No capability changes");
    expect(description).toContain("Lower bound");
  });

  test("reports no changes for a complete comparison", () => {
    const delta: CapabilityDelta = {
      from: side(),
      to: side(),
      escalations: [],
      reductions: [],
      confident: true,
    };

    expect(capabilityDeltaDescription(delta)).toContain("No capability changes");
  });
});
