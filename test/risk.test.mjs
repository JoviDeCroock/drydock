import { describe, expect, test } from "vitest";
import {
  computeScanRisk,
  computeScanRiskBreakdown,
  normalizeScanRiskBreakdown,
} from "../server/lib/risk.ts";

function makeAiReview(overrides = {}) {
  return {
    status: "unavailable",
    risk: "low",
    releaseAssessment: "not_assessed",
    summary: "",
    findings: [],
    requiresManualReview: false,
    model: null,
    ...overrides,
  };
}

describe("computeScanRisk", () => {
  test("returns low when no findings and AI unavailable (model null)", () => {
    const result = computeScanRisk([], makeAiReview());
    expect(result).toBe("low");
  });

  test("returns deterministic risk when AI is unavailable with null model", () => {
    const findings = [{ severity: "high", file: "x.js", evidence: "e", reason: "r" }];
    const result = computeScanRisk(findings, makeAiReview());
    expect(result).toBe("high");
  });

  test("escalates to medium when AI was attempted but did not complete (model present)", () => {
    const result = computeScanRisk([], makeAiReview({ model: "llama-3" }));
    expect(result).toBe("medium");
  });

  test("does not escalate when AI is unavailable with null model (disabled)", () => {
    const result = computeScanRisk([], makeAiReview({ model: null }));
    expect(result).toBe("low");
  });

  test("combines AI risk when AI review is complete with evidence", () => {
    const aiReview = makeAiReview({
      status: "complete",
      releaseAssessment: "suspicious",
      risk: "high",
      findings: [
        { severity: "high", file: "f.js", evidence: "e", reason: "r", recommendation: "x" },
      ],
    });
    const result = computeScanRisk([], aiReview);
    expect(result).toBe("high");
  });

  test("combines AI requiresManualReview to medium floor", () => {
    const aiReview = makeAiReview({
      status: "complete",
      releaseAssessment: "review_recommended",
      risk: "low",
      findings: [],
      requiresManualReview: true,
    });
    const result = computeScanRisk([], aiReview);
    expect(result).toBe("medium");
  });

  test("deterministic findings dominate when higher than AI risk", () => {
    const findings = [{ severity: "critical", file: "x.js", evidence: "e", reason: "r" }];
    const aiReview = makeAiReview({
      status: "complete",
      releaseAssessment: "nothing_unusual",
      risk: "low",
      findings: [],
    });
    const result = computeScanRisk(findings, aiReview);
    expect(result).toBe("critical");
  });

  test("AI complete with no evidence stays low", () => {
    const aiReview = makeAiReview({
      status: "complete",
      releaseAssessment: "nothing_unusual",
      risk: "low",
      findings: [],
      requiresManualReview: false,
    });
    const result = computeScanRisk([], aiReview);
    expect(result).toBe("low");
  });
});

describe("computeScanRiskBreakdown", () => {
  test("separates release delta findings from context findings", () => {
    const findings = [
      { severity: "high", file: "a.js", evidence: "e", reason: "r", releaseDelta: true },
      { severity: "low", file: "b.js", evidence: "e", reason: "r", releaseDelta: false },
      {
        severity: "medium",
        file: "c.js",
        evidence: "e",
        reason: "r",
        releaseDelta: false,
        diffStatus: "unknown",
      },
    ];
    const result = computeScanRiskBreakdown(findings, makeAiReview());
    expect(result.releaseFindingCount).toBe(1);
    expect(result.contextFindingCount).toBe(2);
    expect(result.unknownFindingCount).toBe(1);
  });

  test("artifactRisk reflects all findings", () => {
    const findings = [
      { severity: "critical", file: "a.js", evidence: "e", reason: "r", releaseDelta: true },
      { severity: "low", file: "b.js", evidence: "e", reason: "r", releaseDelta: false },
    ];
    const result = computeScanRiskBreakdown(findings, makeAiReview());
    expect(result.artifactRisk).toBe("critical");
  });

  test("contextRisk is computed without AI review influence", () => {
    const findings = [
      { severity: "high", file: "a.js", evidence: "e", reason: "r", releaseDelta: false },
    ];
    const aiReview = makeAiReview({
      status: "complete",
      releaseAssessment: "nothing_unusual",
      risk: "low",
      findings: [],
    });
    const result = computeScanRiskBreakdown(findings, aiReview);
    expect(result.contextRisk).toBe("high");
  });

  test("releaseRisk includes AI review influence", () => {
    const findings = [
      { severity: "low", file: "a.js", evidence: "e", reason: "r", releaseDelta: true },
    ];
    const aiReview = makeAiReview({
      status: "complete",
      releaseAssessment: "suspicious",
      risk: "high",
      findings: [
        { severity: "high", file: "x.js", evidence: "e", reason: "r", recommendation: "fix" },
      ],
    });
    const result = computeScanRiskBreakdown(findings, aiReview);
    expect(result.releaseRisk).toBe("high");
  });

  test("returns zeros when no findings", () => {
    const result = computeScanRiskBreakdown([], makeAiReview());
    expect(result.releaseFindingCount).toBe(0);
    expect(result.contextFindingCount).toBe(0);
    expect(result.unknownFindingCount).toBe(0);
    expect(result.artifactRisk).toBe("low");
    expect(result.releaseRisk).toBe("low");
    expect(result.contextRisk).toBe("low");
  });
});

describe("normalizeScanRiskBreakdown", () => {
  test("returns null for null or non-object", () => {
    expect(normalizeScanRiskBreakdown(null)).toBe(null);
    expect(normalizeScanRiskBreakdown(undefined)).toBe(null);
    expect(normalizeScanRiskBreakdown("string")).toBe(null);
    expect(normalizeScanRiskBreakdown(42)).toBe(null);
    expect(normalizeScanRiskBreakdown([])).toBe(null);
  });

  test("returns null for empty object", () => {
    expect(normalizeScanRiskBreakdown({})).toBe(null);
  });

  test("normalizes valid risk levels", () => {
    const result = normalizeScanRiskBreakdown({
      artifactRisk: "high",
      releaseRisk: "critical",
      contextRisk: "low",
    });
    expect(result).toEqual({ artifactRisk: "high", releaseRisk: "critical", contextRisk: "low" });
  });

  test("normalizes unknown risk strings to medium", () => {
    const result = normalizeScanRiskBreakdown({
      artifactRisk: "unknown_value",
    });
    expect(result).toEqual({ artifactRisk: "medium" });
  });

  test("floors counts to zero and truncates decimals", () => {
    const result = normalizeScanRiskBreakdown({
      releaseFindingCount: -5,
      contextFindingCount: 3.7,
      unknownFindingCount: 0,
    });
    expect(result).toEqual({
      releaseFindingCount: 0,
      contextFindingCount: 3,
      unknownFindingCount: 0,
    });
  });

  test("ignores non-string risk and non-number counts", () => {
    const result = normalizeScanRiskBreakdown({
      artifactRisk: 42,
      releaseFindingCount: "five",
    });
    expect(result).toBe(null);
  });
});
