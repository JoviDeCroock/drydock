import { describe, expect, test } from "vitest";
import {
  capabilityDeltaDescription,
  capabilityEmptyState,
} from "../src/features/review/CapabilitiesSection";
import type { CapabilityDelta, CapabilitySet } from "../server/lib/review";

function side(overrides: Partial<CapabilitySet> = {}): CapabilitySet {
  return { capabilities: [], inspectedFiles: 1, uninspectedFiles: 0, complete: true, ...overrides };
}

describe("CapabilitiesSection", () => {
  test("does not claim no changes or success when the comparison is incomplete", () => {
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
    expect(capabilityEmptyState(delta.to)).toEqual({ tone: "neutral", label: "none visible" });
  });

  test("reports no changes and a successful empty state for a complete comparison", () => {
    const delta: CapabilityDelta = {
      from: side(),
      to: side(),
      escalations: [],
      reductions: [],
      confident: true,
    };

    expect(capabilityDeltaDescription(delta)).toContain("No capability changes");
    expect(capabilityEmptyState(delta.to)).toEqual({ tone: "ok", label: "none detected" });
  });

  test("discloses target coverage gaps without a baseline", () => {
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
    expect(capabilityEmptyState(delta.to)).toEqual({ tone: "neutral", label: "none visible" });
  });
});
