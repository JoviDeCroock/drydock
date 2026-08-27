// Live AI reviewer model comparison.
//
// This is NOT `ai-review-harness.mjs`. That one grades *recorded* reviews and
// gates the scoring contract offline; a green run there says nothing about
// which hosted model to route to. This harness calls real Workers AI models
// through the real `analyzeWithAi` agent loop and reports, per model, the three
// numbers that actually decide routing:
//
//   - detection quality  — catch rate on malicious fixtures, false-positive
//                          rate on benign hard-negatives
//   - completion rate    — how often the model lands a valid `submit_review`
//                          before the step budget ends. A model that returns
//                          `invalid` looks healthy in logs but floors the scan
//                          at medium and escalates every release to a human, so
//                          this is a routing blocker, not a quality nit.
//   - cost               — measured tokens priced per model, with cached input
//                          billed separately. The agent loop re-sends a growing
//                          prefix up to MAX_AGENT_STEPS times, so cached-input
//                          share dominates the bill and a model with no cache
//                          tier can cost more than one with a higher list price.
//
// It costs real money and needs real credentials, so it never runs as part of
// `pnpm test` or `pnpm run verify`. See docs/ai-review-eval.md.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkersAI } from "workers-ai-provider";
import {
  computeRisk,
  createPackageDiff,
  deterministicFindings,
  packageJsonDiffFindings,
  summarizePackageJsonDiff,
} from "../../server/lib/review";
import { AI_REVIEWER_VERSION } from "../../server/lib/ai-review/contract.ts";
import {
  AI_MODEL_CANDIDATES,
  aiReviewRequestHeaders,
  analyzeWithAi,
} from "../../server/lib/ai-review/index.ts";
import { isBenignClean, isMaliciousCaught, isUncertaintyEscalated } from "./ai-review-harness.mjs";
import { loadCorpus } from "./harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Workers AI list prices, USD per million tokens, from
// https://developers.cloudflare.com/workers-ai/platform/pricing/ (checked
// 2026-08-27). `cachedInput: null` means the model has no cached-input tier
// published — every step of the agent loop re-bills the whole prefix at the
// full input rate, which is why a low `input` price is not a low cost.
// Refresh these alongside any routing change; a stale table silently reorders
// the comparison.
export const MODEL_PRICING = {
  "@cf/zai-org/glm-5.3-flash": { input: 0.15, output: 0.5, cachedInput: 0.03 },
  "@cf/moonshotai/kimi-k2.7-code": { input: 0.95, output: 4.0, cachedInput: 0.19 },
  "@cf/deepseek-ai/deepseek-v4-flash-0731": { input: 0.44, output: 1.32, cachedInput: 0.014 },
  "@cf/deepseek-ai/deepseek-v4-pro-0813": { input: 1.32, output: 3.96, cachedInput: 0.044 },
  "@cf/zai-org/glm-5.2": { input: 1.4, output: 4.4, cachedInput: 0.26 },
  "@cf/qwen/qwen3.8-27b": { input: 0.45, output: 3.2, cachedInput: null },
  "@cf/qwen/qwen3-30b-a3b-fp8": { input: 0.051, output: 0.335, cachedInput: null },
};

export const DEFAULT_COMPARISON_MODELS = [...AI_MODEL_CANDIDATES];

const PER_MILLION = 1_000_000;

// `usage.inputTokens` is the full billed input; `cachedInputTokens` is the
// subset of it that was a cache read. Splitting them is the whole point of the
// exercise, so an unpriced cache tier bills the entire input at the full rate
// rather than quietly discounting it.
export function estimateCost(model, usage) {
  const pricing = MODEL_PRICING[model];
  if (!pricing || !usage) return null;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cached = pricing.cachedInput === null ? 0 : Math.min(usage.cachedInputTokens ?? 0, input);
  const fresh = input - cached;
  return (
    (fresh * pricing.input + cached * (pricing.cachedInput ?? 0) + output * pricing.output) /
    PER_MILLION
  );
}

// The reviewer's npm evidence contract, built from the same detection code the
// product runs so the comparison can never drift from what ships. PyPI fixtures
// carry adapter-shaped inputs instead of `stagedFiles` and are reported as
// skipped rather than silently dropped. VS Code fixtures never reach here at
// all: `loadCorpus` does not read `cases-vscode`, so extending this to VSIX
// means extending the detection corpus loader first.
export function buildLiveCases(corpus = loadCorpus()) {
  const records = [...corpus.regression, ...corpus.frontier, ...corpus.benign];
  const cases = [];
  const skipped = [];

  for (const record of records) {
    if (record.ecosystem !== "npm" || !record.fx.stagedFiles) {
      skipped.push({ id: record.id, ecosystem: record.ecosystem, reason: "non-npm fixture shape" });
      continue;
    }

    const previousFiles = record.fx.previousFiles ?? [];
    const stagedFiles = record.fx.stagedFiles;
    const diff = createPackageDiff(previousFiles, stagedFiles);
    const packageJsonDiff = summarizePackageJsonDiff(
      record.fx.previousPackageJson,
      record.fx.stagedPackageJson,
    );
    const ruleFindings = [
      ...deterministicFindings(stagedFiles, diff, record.fx.stagedPackageJson, {
        entrypointResolution: "npm",
      }),
      ...packageJsonDiffFindings(packageJsonDiff),
    ];

    cases.push({
      id: record.id,
      title: record.title,
      kind: record.kind,
      verdict: record.verdict,
      threatClass: record.threatClass,
      deterministicRisk: computeRisk(ruleFindings),
      options: {
        // A stable per-fixture scan id keeps cache affinity consistent across
        // models, so the cached-token share reflects the loop's own prefix
        // reuse rather than which fixture happened to run first.
        scanId: `ai-review-live-${record.id}`,
        organizationId: "ai-review-live-eval",
        ecosystem: "npm",
        files: stagedFiles,
        previousFiles,
        diff,
        packageJsonDiff,
        ruleFindings,
        previousVersionAvailable: previousFiles.length > 0,
      },
    });
  }

  return { cases, skipped };
}

// A fixture's live outcome, scored on the same predicates the recorded eval
// uses so the two reports mean the same thing.
export function scoreRun(testCase, result) {
  const review = result.review;
  const completed = review.status === "complete";
  const passed =
    testCase.verdict === "malicious"
      ? isMaliciousCaught(review)
      : testCase.verdict === "benign"
        ? isBenignClean(review)
        : isUncertaintyEscalated(review);

  return {
    id: testCase.id,
    kind: testCase.kind,
    verdict: testCase.verdict,
    threatClass: testCase.threatClass,
    deterministicRisk: testCase.deterministicRisk,
    status: review.status,
    completed,
    passed,
    risk: review.risk,
    releaseAssessment: review.releaseAssessment,
    findingCount: review.findings.length,
    requiresManualReview: review.requiresManualReview,
    summary: review.summary,
    steps: result.usage?.steps ?? 0,
    inputTokens: result.usage?.inputTokens ?? 0,
    cachedInputTokens: result.usage?.cachedInputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    durationMs: result.durationMs ?? 0,
  };
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function rate(passed, total) {
  return total ? passed / total : null;
}

export function summarizeModel(model, runs) {
  const malicious = runs.filter((run) => run.verdict === "malicious");
  const benign = runs.filter((run) => run.verdict === "benign");
  const completed = runs.filter((run) => run.completed);
  const costs = runs.map((run) => estimateCost(model, run)).filter((cost) => cost !== null);
  const totalInput = runs.reduce((total, run) => total + run.inputTokens, 0);
  const totalCached = runs.reduce((total, run) => total + run.cachedInputTokens, 0);

  return {
    model,
    total: runs.length,
    // Completion rate is listed first deliberately: a model that scores well on
    // the cases it finishes but rarely finishes is worse for the product than a
    // duller model that always lands a submission.
    completionRate: rate(completed.length, runs.length),
    invalidRate: rate(runs.filter((run) => run.status === "invalid").length, runs.length),
    unavailableRate: rate(runs.filter((run) => run.status === "unavailable").length, runs.length),
    catchRate: rate(malicious.filter((run) => run.passed).length, malicious.length),
    falsePositiveRate: rate(benign.filter((run) => !run.passed).length, benign.length),
    manualReviewRate: rate(runs.filter((run) => run.requiresManualReview).length, runs.length),
    avgSteps: mean(runs.map((run) => run.steps)),
    avgDurationMs: mean(runs.map((run) => run.durationMs)),
    avgInputTokens: mean(runs.map((run) => run.inputTokens)),
    avgOutputTokens: mean(runs.map((run) => run.outputTokens)),
    cachedInputShare: totalInput ? totalCached / totalInput : 0,
    avgCostUsd: costs.length ? mean(costs) : null,
    totalCostUsd: costs.length ? costs.reduce((total, cost) => total + cost, 0) : null,
    runs,
  };
}

function liveLanguageModelFactory({ accountId, apiKey, gatewayId }, options) {
  const provider = createWorkersAI({ accountId, apiKey, gateway: { id: gatewayId } });
  return (model) =>
    provider(model, {
      // Mirror production's headers exactly. Measuring cached-token share under
      // different affinity headers than the Worker sends would compare a
      // request shape that never ships. `attempt` is always 1 here: the
      // harness measures a first attempt, not retry behavior.
      extraHeaders: aiReviewRequestHeaders({ AI_CACHE_AFFINITY: "" }, options, model, 1),
    });
}

export async function runAiReviewModelComparison({
  accountId,
  apiKey,
  gatewayId = "drydock-gateway",
  models = DEFAULT_COMPARISON_MODELS,
  corpus,
  limit,
  onProgress,
  // Test seam, mirroring `analyzeWithAi`'s own `languageModelOverride`: lets the
  // offline suite exercise per-model isolation, progress reporting, and
  // truncation bookkeeping without spending money on the network.
  analyze = analyzeWithAi,
} = {}) {
  const { cases: allCases, skipped } = buildLiveCases(corpus);
  const cases = typeof limit === "number" ? allCases.slice(0, limit) : allCases;
  const models_ = [...models];
  const byModel = [];

  for (const model of models_) {
    const runs = [];
    for (const testCase of cases) {
      const startedAt = Date.now();
      // One model at a time: `analyzeWithAi` takes a candidate list and fails
      // over, which is exactly what a per-model comparison must not do.
      const result = await analyze(
        {},
        [model],
        testCase.options,
        liveLanguageModelFactory({ accountId, apiKey, gatewayId }, testCase.options),
      );
      const run = scoreRun(testCase, { ...result, durationMs: Date.now() - startedAt });
      runs.push(run);
      onProgress?.({ model, run });
    }
    byModel.push(summarizeModel(model, runs));
  }

  return {
    generatedAt: new Date().toISOString(),
    reviewerVersion: AI_REVIEWER_VERSION,
    models: models_,
    caseCount: cases.length,
    // Never let a bounded run read as full coverage.
    skipped,
    truncated: cases.length < allCases.length ? allCases.length - cases.length : 0,
    byModel,
  };
}

function percent(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(0)}%`;
}

function usd(value) {
  return value === null ? "n/a" : `$${value.toFixed(4)}`;
}

export function renderMarkdown(result) {
  const lines = [
    "# AI reviewer live model comparison",
    "",
    `- generated: ${result.generatedAt}`,
    `- reviewer version: ${result.reviewerVersion}`,
    `- fixtures per model: ${result.caseCount}`,
  ];
  if (result.truncated) {
    lines.push(`- **truncated**: ${result.truncated} npm fixtures not run (\`--limit\`)`);
  }
  if (result.skipped.length) {
    lines.push(`- skipped (non-npm fixture shape): ${result.skipped.length}`);
  }
  lines.push(
    "",
    "| model | completion | catch | false pos | cached in | avg steps | avg cost | total cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...result.byModel.map((entry) =>
      [
        entry.model,
        percent(entry.completionRate),
        percent(entry.catchRate),
        percent(entry.falsePositiveRate),
        percent(entry.cachedInputShare),
        entry.avgSteps.toFixed(1),
        usd(entry.avgCostUsd),
        usd(entry.totalCostUsd),
      ].join(" | "),
    ),
    "",
    "Completion rate is the routing blocker: an incomplete review floors the scan",
    "at medium risk and escalates the release to a human, whatever the model scored",
    "on the cases it did finish.",
    "",
  );

  for (const entry of result.byModel) {
    const misses = entry.runs.filter((run) => !run.passed);
    lines.push(`## ${entry.model}`, "");
    lines.push(
      `- invalid: ${percent(entry.invalidRate)} · unavailable: ${percent(entry.unavailableRate)}`,
      `- avg latency: ${(entry.avgDurationMs / 1000).toFixed(1)}s · avg tokens in/out: ${entry.avgInputTokens.toFixed(0)}/${entry.avgOutputTokens.toFixed(0)}`,
      "",
      misses.length ? "Misses:" : "Misses: none.",
      "",
    );
    for (const miss of misses) {
      lines.push(
        `- \`${miss.id}\` (${miss.verdict}/${miss.threatClass}) → ${miss.status}/${miss.risk}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function writeAiReviewModelComparisonReport(result) {
  try {
    const outDir = join(__dirname, "..", "..", ".context", "eval");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "ai-review-model-compare.json"), JSON.stringify(result, null, 2));
    writeFileSync(join(outDir, "ai-review-model-compare.md"), renderMarkdown(result));
  } catch {
    // Report writing is best-effort; never fail a paid live run over a
    // filesystem issue.
  }
}
