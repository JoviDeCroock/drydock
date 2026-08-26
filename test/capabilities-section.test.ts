import { describe, expect, test } from "vitest";
import {
  capabilityDeltaDescription,
  capabilityDeltaForComparison,
  capabilityEmptyState,
} from "../src/features/review/CapabilitiesSection";
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

  test("reports target coverage gaps when there is no baseline", () => {
    const delta: CapabilityDelta = {
      from: null,
      to: side({ uninspectedFiles: 2, complete: false }),
      escalations: [],
      reductions: [],
      confident: false,
    };

    const description = capabilityDeltaDescription(delta);
    expect(description).toContain("No comparable baseline");
    expect(description).toContain("Lower bound: 2 file bodies");
    expect(capabilityEmptyState(delta)).toEqual({
      tone: "neutral",
      label: "inspection incomplete",
    });
  });

  test("keeps the success empty state for a complete target", () => {
    const delta: CapabilityDelta = {
      from: side(),
      to: side(),
      escalations: [],
      reductions: [],
      confident: true,
    };

    expect(capabilityEmptyState(delta)).toEqual({ tone: "ok", label: "none detected" });
  });

  test("hides the persisted delta for a non-default comparison", () => {
    const delta: CapabilityDelta = {
      from: side(),
      to: side({ capabilities: ["network"] }),
      escalations: ["network"],
      reductions: [],
      confident: true,
    };

    expect(capabilityDeltaForComparison(delta, true)).toBe(delta);
    expect(capabilityDeltaForComparison(delta, false)).toBeNull();
  });
});
