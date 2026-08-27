// Offline coverage for the live comparison harness. The live run itself is
// paid and network-bound (test/eval/ai-review-live.test.mjs); the pieces that
// decide what the report *says* — case construction, cost math, scoring, and
// truncation reporting — are pure and are covered here so a wrong verdict can
// never be blamed on the harness after the money is spent.

import { describe, expect, test } from "vitest";
import {
  buildLiveCases,
  DEFAULT_COMPARISON_MODELS,
  estimateCost,
  MODEL_PRICING,
  renderMarkdown,
  runAiReviewModelComparison,
  scoreRun,
  summarizeModel,
} from "./eval/ai-review-live-harness.mjs";
import { AI_MODEL_CANDIDATES, AI_REVIEWER_VERSION } from "../server/lib/ai-review/index.ts";

const KIMI = "@cf/moonshotai/kimi-k2.7-code";
const GLM = "@cf/zai-org/glm-5.3-flash";
const QWEN_NO_CACHE = "@cf/qwen/qwen3.8-27b";

function usage(overrides = {}) {
  return {
    inputTokens: 100_000,
    cachedInputTokens: 80_000,
    outputTokens: 3_000,
    totalTokens: 103_000,
    steps: 6,
    ...overrides,
  };
}

describe("model pricing table", () => {
  test("prices every model the reviewer can route to", () => {
    for (const model of DEFAULT_COMPARISON_MODELS) {
      expect(MODEL_PRICING[model]).toBeDefined();
    }
    expect(DEFAULT_COMPARISON_MODELS).toEqual(AI_MODEL_CANDIDATES);
  });
});

describe("estimateCost", () => {
  test("bills cached input at the cached rate", () => {
    // 20k fresh @ $0.95/M + 80k cached @ $0.19/M + 3k out @ $4.00/M
    expect(estimateCost(KIMI, usage())).toBeCloseTo(0.019 + 0.0152 + 0.012, 6);
  });

  test("bills the whole prefix at full rate when no cached tier is published", () => {
    // The trap this harness exists to catch: qwen3.8-27b's $0.45/M input looks
    // cheaper than kimi's $0.95/M, but with no cache tier the agent loop
    // re-bills every step at full rate and it ends up more expensive.
    const qwen = estimateCost(QWEN_NO_CACHE, usage());
    const kimi = estimateCost(KIMI, usage());
    expect(qwen).toBeCloseTo(100_000 * (0.45 / 1e6) + 3_000 * (3.2 / 1e6), 6);
    expect(qwen).toBeGreaterThan(kimi);
  });

  test("prices GLM 5.3 Flash below Kimi for an identical loop", () => {
    expect(estimateCost(GLM, usage())).toBeLessThan(estimateCost(KIMI, usage()));
  });

  test("never counts more cached tokens than billed input", () => {
    const cost = estimateCost(KIMI, usage({ inputTokens: 1_000, cachedInputTokens: 50_000 }));
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeCloseTo(1_000 * (0.19 / 1e6) + 3_000 * (4.0 / 1e6), 6);
  });

  test("returns null for an unpriced model or missing usage", () => {
    expect(estimateCost("@cf/unknown/model", usage())).toBeNull();
    expect(estimateCost(KIMI, null)).toBeNull();
  });
});

describe("buildLiveCases", () => {
  test("builds reviewer options from the staged security corpora", () => {
    const { cases } = buildLiveCases();
    expect(cases.length).toBeGreaterThan(0);
    for (const testCase of cases) {
      expect(["npm", "pypi", "vscode"]).toContain(testCase.options.ecosystem);
      expect(testCase.options.files.length).toBeGreaterThan(0);
      expect(Array.isArray(testCase.options.diff)).toBe(true);
      expect(Array.isArray(testCase.options.ruleFindings)).toBe(true);
      expect(testCase.options.packageJsonDiff).toBeDefined();
      expect(typeof testCase.options.previousVersionAvailable).toBe("boolean");
    }
  });

  test("gives each fixture a stable scan id so cache affinity is comparable across models", () => {
    const first = buildLiveCases().cases.map((testCase) => testCase.options.scanId);
    const second = buildLiveCases().cases.map((testCase) => testCase.options.scanId);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });

  test("reports unsupported fixtures as skipped instead of dropping them silently", () => {
    const { cases, skipped } = buildLiveCases();
    expect(skipped.length).toBeGreaterThan(0);
    for (const entry of skipped) expect(entry.reason).toBeTruthy();
    const ids = new Set(cases.map((testCase) => testCase.id));
    for (const entry of skipped) expect(ids.has(entry.id)).toBe(false);
  });

  test("builds every staged ecosystem and only skips unsupported atpm fixtures", () => {
    const { cases, skipped } = buildLiveCases();
    expect(new Set(cases.map((testCase) => testCase.options.ecosystem))).toEqual(
      new Set(["npm", "pypi", "vscode"]),
    );
    expect(new Set(skipped.map((entry) => entry.ecosystem))).toEqual(new Set(["atpm"]));
  });

  test("carries the deterministic risk alongside each case", () => {
    const { cases } = buildLiveCases();
    const malicious = cases.filter((testCase) => testCase.verdict === "malicious");
    expect(malicious.length).toBeGreaterThan(0);
    for (const testCase of cases) {
      expect(["low", "medium", "high", "critical"]).toContain(testCase.deterministicRisk);
    }
  });

  test("uses release-scoped findings and truth labels for baseline-backed PyPI cases", () => {
    const { cases } = buildLiveCases();
    const benign = cases.find(
      (testCase) => testCase.id === "pypi-benign-docs-metadata-and-test-fixtures",
    );
    const malicious = cases.find(
      (testCase) => testCase.id === "pypi-wheel-baseline-credential-added",
    );

    expect(benign).toMatchObject({ verdict: "benign", deterministicRisk: "medium" });
    expect(benign.options.ruleFindings).toEqual([]);
    expect(malicious.options.ruleFindings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining(["diff.credential-file-added", "file.secret-content"]),
    );
  });
});

function review(overrides = {}) {
  return {
    status: "complete",
    risk: "critical",
    releaseAssessment: "blocked",
    summary: "s",
    findings: [],
    requiresManualReview: true,
    model: KIMI,
    reviewerVersion: AI_REVIEWER_VERSION,
    ...overrides,
  };
}

const maliciousCase = {
  id: "m",
  kind: "regression",
  verdict: "malicious",
  threatClass: "t",
  deterministicRisk: "critical",
};
const benignCase = {
  id: "b",
  kind: "benign",
  verdict: "benign",
  threatClass: "t",
  deterministicRisk: "low",
};

describe("scoreRun", () => {
  test("passes a malicious fixture the model escalated", () => {
    const run = scoreRun(maliciousCase, { review: review(), usage: usage(), durationMs: 1_000 });
    expect(run.passed).toBe(true);
    expect(run.completed).toBe(true);
    expect(run.steps).toBe(6);
  });

  test("fails a malicious fixture the model cleared", () => {
    const cleared = review({
      risk: "low",
      releaseAssessment: "nothing_unusual",
      requiresManualReview: false,
    });
    expect(scoreRun(maliciousCase, { review: cleared, usage: usage() }).passed).toBe(false);
  });

  test("does not call a low production risk caught from assessment copy alone", () => {
    const inconsistent = review({
      risk: "low",
      releaseAssessment: "blocked",
      findings: [],
      requiresManualReview: false,
    });
    expect(scoreRun(maliciousCase, { review: inconsistent, usage: usage() }).passed).toBe(false);
  });

  test("fails a benign fixture the model escalated", () => {
    expect(scoreRun(benignCase, { review: review(), usage: usage() }).passed).toBe(false);
  });

  test("records an incomplete review as not completed and zero usage", () => {
    const run = scoreRun(maliciousCase, { review: review({ status: "invalid" }), usage: null });
    expect(run.completed).toBe(false);
    expect(run.status).toBe("invalid");
    expect(run.inputTokens).toBe(0);
    expect(run.steps).toBe(0);
  });
});

describe("summarizeModel", () => {
  const runs = [
    scoreRun(maliciousCase, { review: review(), usage: usage(), durationMs: 1_000 }),
    scoreRun(benignCase, {
      review: review({
        risk: "low",
        releaseAssessment: "nothing_unusual",
        requiresManualReview: false,
      }),
      usage: usage(),
      durationMs: 3_000,
    }),
    scoreRun(
      { ...maliciousCase, id: "m2" },
      { review: review({ status: "invalid" }), usage: null },
    ),
  ];

  test("reports completion, catch, and false-positive rates separately", () => {
    const summary = summarizeModel(KIMI, runs);
    expect(summary.completionRate).toBeCloseTo(2 / 3, 6);
    expect(summary.invalidRate).toBeCloseTo(1 / 3, 6);
    expect(summary.catchRate).toBeCloseTo(1 / 2, 6);
    expect(summary.falsePositiveRate).toBe(0);
  });

  test("reports cached input share over the whole run, not per case", () => {
    expect(summarizeModel(KIMI, runs).cachedInputShare).toBeCloseTo(160_000 / 200_000, 6);
  });

  test("leaves rates null rather than inventing a denominator", () => {
    const summary = summarizeModel(KIMI, [runs[0]]);
    expect(summary.falsePositiveRate).toBeNull();
    expect(summary.catchRate).toBe(1);
  });
});

describe("renderMarkdown", () => {
  const base = {
    generatedAt: "2026-08-19T00:00:00.000Z",
    reviewerVersion: AI_REVIEWER_VERSION,
    models: [KIMI],
    caseCount: 2,
    skipped: [{ id: "atpm-x", ecosystem: "atpm", reason: "no staged AI review" }],
    truncated: 0,
    byModel: [
      summarizeModel(KIMI, [scoreRun(maliciousCase, { review: review(), usage: usage() })]),
    ],
  };

  test("renders a comparison row per model", () => {
    const markdown = renderMarkdown(base);
    expect(markdown).toContain(KIMI);
    expect(markdown).toContain("Misses: none.");
    expect(markdown).toContain("skipped (no staged AI review): 1");
  });

  test("says so loudly when the run was truncated", () => {
    expect(renderMarkdown({ ...base, truncated: 30 })).toContain("**truncated**: 30");
    expect(renderMarkdown(base)).not.toContain("truncated");
  });

  test("lists misses with their fixture id", () => {
    const missed = summarizeModel(KIMI, [
      scoreRun(maliciousCase, {
        review: review({
          risk: "low",
          releaseAssessment: "nothing_unusual",
          requiresManualReview: false,
        }),
        usage: usage(),
      }),
    ]);
    expect(renderMarkdown({ ...base, byModel: [missed] })).toContain("`m` (malicious/t)");
  });
});

function npmRecord(id, verdict) {
  return {
    id,
    title: id,
    ecosystem: "npm",
    kind: "regression",
    verdict,
    threatClass: "test",
    source: "synthetic",
    expectMinRisk: verdict === "benign" ? "low" : "high",
    expectAnyRule: [],
    fx: {
      previousPackageJson: { name: id, version: "1.0.0" },
      stagedPackageJson: { name: id, version: "1.1.0" },
      previousFiles: [
        { path: "index.js", size: 10, sha256: `${id}-prev`, flags: [], textSample: "export {};\n" },
      ],
      stagedFiles: [
        {
          path: "index.js",
          size: 20,
          sha256: `${id}-next`,
          flags: [],
          textSample: "export const a = 1;\n",
        },
      ],
    },
  };
}

const twoCaseCorpus = {
  regression: [npmRecord("case-a", "malicious"), npmRecord("case-b", "benign")],
  frontier: [],
  benign: [],
};

describe("runAiReviewModelComparison", () => {
  const stubAnalyze =
    (byModel) =>
    async (_env, [model], options) => ({
      review: review({ ...byModel(model, options) }),
      usage: usage(),
    });

  test("runs every fixture against every model without failing over between them", async () => {
    const seen = [];
    const result = await runAiReviewModelComparison({
      accountId: "acct",
      apiKey: "key",
      models: [KIMI, GLM],
      corpus: twoCaseCorpus,
      analyze: stubAnalyze((model, options) => {
        seen.push([model, options.scanId]);
        return {};
      }),
    });

    expect(seen).toEqual([
      [KIMI, "ai-review-live-case-a"],
      [KIMI, "ai-review-live-case-b"],
      [GLM, "ai-review-live-case-a"],
      [GLM, "ai-review-live-case-b"],
    ]);
    expect(result.byModel.map((entry) => entry.model)).toEqual([KIMI, GLM]);
    expect(result.caseCount).toBe(2);
    expect(result.truncated).toBe(0);
  });

  test("scores each model independently and prices its own usage", async () => {
    const result = await runAiReviewModelComparison({
      accountId: "acct",
      apiKey: "key",
      models: [KIMI, GLM],
      corpus: twoCaseCorpus,
      // Both models escalate everything: right on the malicious case, a false
      // positive on the benign one.
      analyze: stubAnalyze(() => ({})),
    });

    const [kimi, glm] = result.byModel;
    expect(kimi.catchRate).toBe(1);
    expect(kimi.falsePositiveRate).toBe(1);
    expect(glm.catchRate).toBe(1);
    expect(glm.totalCostUsd).toBeLessThan(kimi.totalCostUsd);
  });

  test("reports how many fixtures a limit dropped", async () => {
    const calls = [];
    const result = await runAiReviewModelComparison({
      accountId: "acct",
      apiKey: "key",
      models: [KIMI],
      corpus: twoCaseCorpus,
      limit: 1,
      analyze: stubAnalyze(() => ({})),
      onProgress: (entry) => calls.push(entry.run.id),
    });

    expect(result.caseCount).toBe(1);
    expect(result.truncated).toBe(1);
    expect(calls).toEqual(["case-a"]);
    expect(renderMarkdown(result)).toContain("**truncated**: 1");
  });

  test("records a thrown fixture run and continues the paid comparison", async () => {
    const progress = [];
    const result = await runAiReviewModelComparison({
      accountId: "acct",
      apiKey: "key",
      models: [KIMI],
      corpus: twoCaseCorpus,
      analyze: async (_env, _models, options) => {
        if (options.scanId.endsWith("case-a")) throw new TypeError("provider payload");
        return { review: review(), usage: usage() };
      },
      onProgress: ({ run }) => progress.push([run.id, run.status]),
    });

    expect(progress).toEqual([
      ["case-a", "harness_error"],
      ["case-b", "complete"],
    ]);
    expect(result.byModel[0].harnessErrorRate).toBe(0.5);
    expect(result.byModel[0].costCoverage).toBe(0.5);
    expect(result.byModel[0].runs[0]).toMatchObject({
      passed: false,
      errorName: "TypeError",
    });
    expect(renderMarkdown(result)).toContain("harness errors: 50%");
  });

  test("rejects empty or duplicate model lists before making network calls", async () => {
    await expect(
      runAiReviewModelComparison({ corpus: twoCaseCorpus, models: [], analyze: async () => {} }),
    ).rejects.toThrow(/at least one model/);
    await expect(
      runAiReviewModelComparison({
        corpus: twoCaseCorpus,
        models: [KIMI, KIMI],
        analyze: async () => {},
      }),
    ).rejects.toThrow(/duplicate model/);
  });
});
