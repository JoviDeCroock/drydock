import { describe, expect, test } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  estimateCost,
  evaluateModel,
  renderMarkdown,
  renderTsv,
  summarize,
} from "./ai-review-harness.mjs";

// Drives the harness with mock reviewer output so the metric math is covered
// without any live model call. Each synthetic case carries a unique staged-file
// path used as a marker; the mock reads the serialized prompt to decide which
// review (or error) to return for that case.
function record({ id, verdict, expectMinRisk, threatClass = "test" }) {
  return {
    id,
    group: "regression",
    threatClass,
    verdict,
    expectMinRisk,
    fx: {
      previousPackageJson: { name: id, version: "1.0.0" },
      stagedPackageJson: { name: id, version: "1.0.1" },
      previousFiles: [
        {
          path: "package.json",
          size: 40,
          sha256: `prev-${id}`,
          flags: [],
          textSample: `{"name":"${id}","version":"1.0.0"}`,
        },
      ],
      stagedFiles: [
        {
          path: "package.json",
          size: 40,
          sha256: `staged-${id}`,
          flags: [],
          textSample: `{"name":"${id}","version":"1.0.1"}`,
        },
        {
          path: `marker-${id}.js`,
          size: 20,
          sha256: `code-${id}`,
          flags: [],
          textSample: `// marker-${id}\n`,
        },
      ],
    },
  };
}

function submission(risk) {
  return {
    risk,
    releaseAssessment:
      risk === "low" ? "nothing_unusual" : risk === "medium" ? "review_recommended" : "suspicious",
    summary: `verdict ${risk}`,
    findings: [],
    requiresManualReview: risk !== "low",
  };
}

function usage() {
  return {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 20, text: 20, reasoning: 0 },
  };
}

// review is a risk level to submit, or "error" to throw.
function scriptedModel(byMarker) {
  return new MockLanguageModelV3({
    modelId: "mock",
    doGenerate: async (options) => {
      const serialized = JSON.stringify(options.prompt);
      const match = Object.keys(byMarker).find((marker) =>
        serialized.includes(`marker-${marker}.js`),
      );
      const outcome = match ? byMarker[match] : "low";
      if (outcome === "error") throw new Error("model exploded");
      return {
        content: [
          {
            type: "tool-call",
            toolCallId: "submit-1",
            toolName: "submit_review",
            input: JSON.stringify(submission(outcome)),
          },
        ],
        finishReason: "tool-calls",
        usage: usage(),
        warnings: [],
      };
    },
  });
}

describe("ai review eval harness", () => {
  const cases = [
    record({ id: "mal-caught", verdict: "malicious", expectMinRisk: "high" }),
    record({ id: "mal-missed", verdict: "malicious", expectMinRisk: "high" }),
    record({ id: "mal-error", verdict: "malicious", expectMinRisk: "critical" }),
    record({ id: "ben-clean", verdict: "benign", expectMinRisk: "low" }),
    record({ id: "ben-fp", verdict: "benign", expectMinRisk: "low" }),
  ];

  const byMarker = {
    "mal-caught": "critical",
    "mal-missed": "low",
    "mal-error": "error",
    "ben-clean": "low",
    "ben-fp": "high",
  };

  test("computes recall, benign FP, error rate, and aggregates from mock reviews", async () => {
    const model = scriptedModel(byMarker);
    const { metrics } = await evaluateModel({
      model: "mock",
      createLanguageModel: () => model,
      cases,
      concurrency: 2,
    });

    expect(metrics.total).toBe(5);
    expect(metrics.malicious).toBe(3);
    expect(metrics.benign).toBe(2);

    // Only mal-caught (critical >= high) is caught; mal-missed (low) and
    // mal-error (threw) are misses.
    expect(metrics.recall).toBeCloseTo(1 / 3);
    expect(metrics.misses.map((miss) => miss.id).sort()).toEqual(["mal-error", "mal-missed"]);
    // A thrown model failure is caught by analyzeWithAi and fails safe to an
    // `unavailable` review, so the harness sees a non-complete status, not a raw error.
    expect(metrics.misses.find((miss) => miss.id === "mal-error").status).toBe("unavailable");

    // ben-fp rolls up to high -> false positive; ben-clean stays low.
    expect(metrics.benignFalsePositives).toBe(1);
    expect(metrics.benignFpRate).toBeCloseTo(1 / 2);
    expect(metrics.falsePositives.map((fp) => fp.id)).toEqual(["ben-fp"]);

    // One of five cases errored.
    expect(metrics.errored).toBe(1);
    expect(metrics.errorRate).toBeCloseTo(1 / 5);

    // Averages are over the four completed cases (mock usage: 100 in / 20 out).
    expect(metrics.completed).toBe(4);
    expect(metrics.avgInputTokens).toBe(100);
    expect(metrics.avgOutputTokens).toBe(20);
    expect(metrics.avgSteps).toBe(1);
    expect(metrics.totalInputTokens).toBe(400);
  });

  test("risky-recall uses the looser >= medium bar", async () => {
    // A malicious case the model rolls up to exactly medium: below its `high`
    // expected minimum (recall miss) but still flagged risky.
    const single = [record({ id: "mal-medium", verdict: "malicious", expectMinRisk: "high" })];
    const { metrics } = await evaluateModel({
      model: "mock",
      createLanguageModel: () => scriptedModel({ "mal-medium": "medium" }),
      cases: single,
    });
    expect(metrics.recall).toBe(0);
    expect(metrics.riskyRecall).toBe(1);
  });
});

describe("cost + rendering", () => {
  const metrics = summarize([
    {
      id: "a",
      group: "regression",
      threatClass: "test",
      verdict: "malicious",
      expectMinRisk: "high",
      status: "complete",
      risk: "high",
      flaggedRisky: true,
      caughtAtExpected: true,
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      totalTokens: 1_500_000,
      steps: 3,
      latencyMs: 1000,
    },
  ]);

  test("estimateCost multiplies token totals by the per-million price", () => {
    expect(estimateCost(metrics, { input: 2, output: 4 })).toBeCloseTo(2 * 1 + 4 * 0.5);
    expect(estimateCost(metrics, null)).toBeNull();
    expect(estimateCost(metrics, {})).toBeNull();
  });

  test("renderMarkdown and renderTsv include the model row", () => {
    const report = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      corpusSize: 1,
      malicious: 1,
      benign: 0,
      models: [{ model: "@cf/test/model", metrics, cost: 4 }],
    };
    const md = renderMarkdown(report);
    expect(md).toContain("@cf/test/model");
    expect(md).toContain("$4.0000");
    const tsv = renderTsv(report);
    expect(tsv.split("\n")[0]).toContain("recall");
    expect(tsv).toContain("@cf/test/model");
  });
});
