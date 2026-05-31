import { describe, expect, test } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { AI_MODEL, analyzeWithAi, displayedAiResult } from "../server/lib/ai-review.ts";
import {
  buildReviewerSystemPrompt,
  MAX_AI_FINDINGS,
  normalizeAiReviewEcosystem,
} from "../server/lib/ai-review-contract.ts";
import { computeScanRisk } from "../server/lib/risk.ts";

const EMPTY_PACKAGE_JSON_DIFF = {
  name: null,
  previousVersion: null,
  stagedVersion: null,
  scripts: [],
  dependencies: [],
  entrypointsChanged: false,
};

const BASE_OPTIONS = {
  ecosystem: "npm",
  files: [],
  diff: [],
  packageJsonDiff: EMPTY_PACKAGE_JSON_DIFF,
  ruleFindings: [],
  previousVersionAvailable: true,
};

const VALID_REVIEW = {
  risk: "low",
  releaseAssessment: "nothing_unusual",
  summary: "No unusual changes.",
  findings: [],
  requiresManualReview: false,
};

function generateResult(content, finishReason) {
  return {
    content,
    finishReason,
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 },
    },
    warnings: [],
  };
}

function mockModel(doGenerate) {
  return new MockLanguageModelV3({ modelId: "mock-reviewer", doGenerate });
}

// A model that immediately submits a review through the submit_review tool.
function submittingModel(review) {
  return mockModel(async () =>
    generateResult(
      [
        {
          type: "tool-call",
          toolCallId: "submit-1",
          toolName: "submit_review",
          input: JSON.stringify(review),
        },
      ],
      "tool-calls",
    ),
  );
}

// A model that answers in plain text without calling any tool.
function textOnlyModel(text) {
  return mockModel(async () => generateResult([{ type: "text", text }], "stop"));
}

function aiFinding(severity, file) {
  return {
    severity,
    file,
    evidence: `evidence in ${file}`,
    reason: `reason for ${file}`,
    recommendation: "review manually",
  };
}

// Routing invariants only. We deliberately do NOT assert exact prompt copy
// (technique wording, lifecycle-script phrasing, etc.) — that wording is tuned
// often and string-match assertions break with no behavior change. The invariant
// that matters is that each ecosystem routes to its own prompt and does not leak
// the other ecosystem's guidance.
describe("AI review prompt selection", () => {
  test("routes the npm ecosystem to the npm prompt without PyPI leakage", () => {
    const prompt = buildReviewerSystemPrompt("npm");

    expect(prompt).toContain("Ecosystem: npm.");
    expect(prompt).not.toContain("Ecosystem: PyPI.");
  });

  test("routes the pypi ecosystem to the PyPI prompt without npm leakage", () => {
    const prompt = buildReviewerSystemPrompt("pypi");

    expect(prompt).toContain("Ecosystem: PyPI.");
    expect(prompt).not.toContain("optionalDependencies");
  });

  test("falls back to generic package guidance for unknown adapters", () => {
    expect(normalizeAiReviewEcosystem("rubygems")).toBe("generic");
    expect(normalizeAiReviewEcosystem(undefined)).toBe("generic");
    expect(buildReviewerSystemPrompt("rubygems")).toContain("Ecosystem: generic package release.");
  });
});

describe("ai review orchestration", () => {
  test("pins the single Kimi reviewer model id", () => {
    expect(AI_MODEL).toBe("@cf/moonshotai/kimi-k2.5");
  });

  test("a submit_review tool call produces a complete review and records the model", async () => {
    const { review: ai, usage } = await analyzeWithAi(
      {},
      "mock-reviewer",
      BASE_OPTIONS,
      submittingModel(VALID_REVIEW),
    );

    expect(ai.status).toBe("complete");
    expect(ai.risk).toBe("low");
    expect(ai.releaseAssessment).toBe("nothing_unusual");
    expect(ai.summary).toBe("No unusual changes.");
    expect(ai.model).toBe("mock-reviewer");
    expect(computeScanRisk([], ai)).toBe("low");

    // Usage telemetry is captured from the generateText result.
    expect(usage).not.toBeNull();
    expect(usage.steps).toBe(1);
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(10);
  });

  test("a high/critical finding raises package risk", async () => {
    const { review: ai } = await analyzeWithAi(
      {},
      "mock-reviewer",
      BASE_OPTIONS,
      submittingModel({
        risk: "high",
        releaseAssessment: "suspicious",
        summary: "Install hook reaches the network.",
        findings: [aiFinding("high", "package/scripts/postinstall.js")],
        requiresManualReview: true,
      }),
    );

    expect(ai.status).toBe("complete");
    expect(ai.risk).toBe("high");
    expect(ai.findings).toHaveLength(1);
    expect(computeScanRisk([], ai)).toBe("high");
  });

  test("keeps only the top critical/high findings, most severe first", async () => {
    const { review: ai } = await analyzeWithAi(
      {},
      "mock-reviewer",
      BASE_OPTIONS,
      submittingModel({
        risk: "critical",
        releaseAssessment: "blocked",
        summary: "Multiple issues.",
        findings: [
          aiFinding("high", "package/a.js"),
          aiFinding("medium", "package/b.js"),
          aiFinding("critical", "package/c.js"),
          aiFinding("low", "package/d.js"),
          aiFinding("high", "package/e.js"),
          aiFinding("critical", "package/f.js"),
          aiFinding("high", "package/g.js"),
          aiFinding("high", "package/h.js"),
          aiFinding("info", "package/i.js"),
        ],
        requiresManualReview: true,
      }),
    );

    expect(ai.status).toBe("complete");
    // medium/low/info dropped; capped at MAX_AI_FINDINGS; critical before high.
    expect(ai.findings).toHaveLength(MAX_AI_FINDINGS);
    expect(
      ai.findings.every(
        (finding) => finding.severity === "critical" || finding.severity === "high",
      ),
    ).toBe(true);
    expect(ai.findings.slice(0, 2).map((finding) => finding.severity)).toEqual([
      "critical",
      "critical",
    ]);
    expect(ai.findings.map((finding) => finding.file)).toEqual([
      "package/c.js",
      "package/f.js",
      "package/a.js",
      "package/e.js",
      "package/g.js",
      "package/h.js",
    ]);
  });

  test("a complete review without evidence does not raise package risk", async () => {
    const { review: ai } = await analyzeWithAi(
      {},
      "mock-reviewer",
      BASE_OPTIONS,
      submittingModel({
        ...VALID_REVIEW,
        risk: "medium",
        releaseAssessment: "review_recommended",
      }),
    );

    expect(ai.status).toBe("complete");
    expect(computeScanRisk([], ai)).toBe("low");
  });

  test("a review returned as JSON text without a tool call still completes", async () => {
    const { review: ai } = await analyzeWithAi(
      {},
      "mock-reviewer",
      BASE_OPTIONS,
      textOnlyModel(JSON.stringify(VALID_REVIEW)),
    );

    expect(ai.status).toBe("complete");
    expect(ai.releaseAssessment).toBe("nothing_unusual");
  });

  test("non-JSON text without a tool call degrades to invalid, not medium risk", async () => {
    const { review: ai } = await analyzeWithAi(
      {},
      "mock-reviewer",
      BASE_OPTIONS,
      textOnlyModel("I could not finish the review."),
    );

    expect(ai.status).toBe("invalid");
    expect(ai.risk).toBe("low");
    expect(ai.releaseAssessment).toBe("not_assessed");
    expect(ai.requiresManualReview).toBe(false);
    expect(computeScanRisk([], ai)).toBe("low");
  });

  test("an incomplete submission degrades to invalid", async () => {
    const { review: ai } = await analyzeWithAi(
      {},
      "mock-reviewer",
      BASE_OPTIONS,
      textOnlyModel(JSON.stringify({ findings: [], requiresManualReview: false })),
    );

    expect(ai.status).toBe("invalid");
    expect(ai.releaseAssessment).toBe("not_assessed");
    expect(computeScanRisk([], ai)).toBe("low");
  });

  test("a model error degrades to unavailable", async () => {
    const { review: ai, usage } = await analyzeWithAi(
      {},
      "mock-reviewer",
      BASE_OPTIONS,
      mockModel(async () => {
        throw new Error("model exploded");
      }),
    );

    expect(ai.status).toBe("unavailable");
    expect(ai.risk).toBe("low");
    expect(ai.releaseAssessment).toBe("not_assessed");
    expect(ai.model).toBe("mock-reviewer");
    expect(computeScanRisk([], ai)).toBe("low");
    // No generateText result on the error path, so there is no usage to report.
    expect(usage).toBeNull();
  });
});

describe("displayedAiResult", () => {
  test("returns null when no review is provided", () => {
    expect(displayedAiResult(null)).toBeNull();
    expect(displayedAiResult(undefined)).toBeNull();
  });

  test("invalid status produces an unavailable result that hides fallback risk/assessment", () => {
    const result = displayedAiResult({
      status: "invalid",
      risk: "low",
      releaseAssessment: "not_assessed",
      summary: "Assistant returned non-JSON output.",
      findings: [],
      requiresManualReview: false,
      model: "test-model",
    });
    expect(result).toEqual({
      kind: "unavailable",
      status: "invalid",
      model: "test-model",
      summary: "Assistant returned non-JSON output.",
    });
    expect(result).not.toHaveProperty("risk");
    expect(result).not.toHaveProperty("releaseAssessment");
  });

  test("unavailable status produces an unavailable result", () => {
    const result = displayedAiResult({
      status: "unavailable",
      risk: "low",
      releaseAssessment: "not_assessed",
      summary: "AI review is disabled.",
      findings: [],
      requiresManualReview: false,
      model: null,
    });
    expect(result).toEqual({
      kind: "unavailable",
      status: "unavailable",
      model: null,
      summary: "AI review is disabled.",
    });
  });

  test("complete review exposes risk/assessment", () => {
    const result = displayedAiResult({
      status: "complete",
      risk: "medium",
      releaseAssessment: "review_recommended",
      summary: "Network behavior needs review.",
      findings: [
        {
          severity: "medium",
          file: "package/index.js",
          evidence: "fetch('https://example.com')",
          reason: "outbound network call",
          recommendation: "review manually",
        },
      ],
      requiresManualReview: true,
      model: "test-model",
    });
    expect(result).toEqual({
      kind: "complete",
      model: "test-model",
      summary: "Network behavior needs review.",
      risk: "medium",
      releaseAssessment: "review_recommended",
      findings: [
        {
          severity: "medium",
          file: "package/index.js",
          evidence: "fetch('https://example.com')",
          reason: "outbound network call",
          recommendation: "review manually",
        },
      ],
      requiresManualReview: true,
    });
  });

  test("complete review with not_assessed assessment is treated as unavailable (defensive)", () => {
    const result = displayedAiResult({
      status: "complete",
      risk: "low",
      releaseAssessment: "not_assessed",
      summary: "Stored without an assessment.",
      findings: [],
      requiresManualReview: false,
      model: "test-model",
    });
    expect(result).toEqual({
      kind: "unavailable",
      status: "invalid",
      model: "test-model",
      summary: "Stored without an assessment.",
    });
  });
});
