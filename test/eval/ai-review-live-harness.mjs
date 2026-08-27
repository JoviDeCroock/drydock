// Live AI reviewer model comparison.
//
// This is NOT `ai-review-harness.mjs`. That one grades *recorded* reviews and
// gates the scoring contract offline; a green run there says nothing about
// which hosted model to route to. This harness calls real Workers AI models
// through the real `analyzeWithAi` agent loop and reports, per model, the three
// numbers that actually decide routing:
//
//   - detection quality  — product-policy coverage, frontier AI catch, and
//                          false-positive rate on benign hard-negatives
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
  annotateFindingsWithDiffStatus,
  combineRisk,
  computeRisk,
  createPackageDiff,
  deterministicFindings,
  packageJsonDiffFindings,
  projectReleaseRuleFindings,
  redactFileRecords,
  redactFindings,
  summarizePackageJsonDiff,
} from "../../server/lib/review";
import { computeScanRisk } from "../../server/lib/review/risk.ts";
import {
  acquireStagedPyPi,
  baselineFromPreviousArtifacts,
  stagedSampleRetention,
} from "../../server/lib/ecosystems/pypi/acquire";
import { pypiAdapter, createPyPiReleaseCandidateReview } from "../../server/lib/ecosystems/pypi";
import {
  buildVscodeReleaseManifest,
  createVscodeExtensionReview,
  normalizeVsixFiles,
} from "../../server/lib/ecosystems/vscode";
import {
  packageJsonSummaryForVscode,
  parseVscodeExtensionManifest,
} from "../../server/lib/ecosystems/vscode/manifest";
import { AI_REVIEWER_VERSION } from "../../server/lib/ai-review/contract.ts";
import {
  AI_MODEL_CANDIDATES,
  aiReviewReasoningEffort,
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
  "@cf/deepseek-ai/deepseek-v4-pro-0813": { input: 1.32, output: 3.96, cachedInput: 0.044 },
  "@cf/zai-org/glm-5.2": { input: 1.4, output: 4.4, cachedInput: 0.26 },
  "@cf/qwen/qwen3.8-27b": { input: 0.45, output: 3.2, cachedInput: null },
  "@cf/qwen/qwen3-30b-a3b-fp8": { input: 0.051, output: 0.335, cachedInput: null },
};

export const DEFAULT_COMPARISON_MODELS = [...AI_MODEL_CANDIDATES];

const PER_MILLION = 1_000_000;
const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

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

function liveCase(record, deterministicRisk, options) {
  return {
    id: record.id,
    title: record.title,
    kind: record.kind,
    verdict: record.verdict,
    threatClass: record.threatClass,
    expectMinRisk: record.expectMinRisk,
    deterministicRisk,
    releaseDeterministicRisk: computeRisk(options.ruleFindings),
    options: {
      scanId: `ai-review-live-${record.id}`,
      organizationId: "ai-review-live-eval",
      ...options,
    },
  };
}

function releaseRuleFindings(ruleFindings, diff, files, previousFiles, codePatternSet) {
  return projectReleaseRuleFindings(
    annotateFindingsWithDiffStatus(ruleFindings, diff, {
      stagedFiles: files,
      previousFiles,
      codePatternSet,
    }),
  );
}

function buildNpmLiveCase(record) {
  const previousFiles = record.fx.previousFiles ?? [];
  const stagedFiles = record.fx.stagedFiles;
  const diff = createPackageDiff(previousFiles, stagedFiles);
  const packageJsonDiff = summarizePackageJsonDiff(
    record.fx.previousPackageJson,
    record.fx.stagedPackageJson,
  );
  const allRuleFindings = redactFindings([
    ...deterministicFindings(stagedFiles, diff, record.fx.stagedPackageJson, {
      entrypointResolution: "npm",
      previousFiles,
    }),
    ...packageJsonDiffFindings(packageJsonDiff),
  ]);
  const files = redactFileRecords(stagedFiles);
  const previous = redactFileRecords(previousFiles);
  const ruleFindings = releaseRuleFindings(allRuleFindings, diff, files, previous, "javascript");
  return liveCase(record, computeRisk(allRuleFindings), {
    ecosystem: "npm",
    files,
    previousFiles: previous,
    diff,
    packageJsonDiff,
    ruleFindings,
    previousVersionAvailable: previousFiles.length > 0,
  });
}

function buildPyPiLiveCase(record) {
  const input = pypiAdapter.parseInput({
    manifest: record.fx.manifest,
    artifacts: record.fx.artifacts,
    previousArtifacts: record.fx.previousArtifacts,
  });
  const staged = acquireStagedPyPi(input);
  const baseline = baselineFromPreviousArtifacts(input, stagedSampleRetention(staged.details));
  const review = createPyPiReleaseCandidateReview(input);
  const files = redactFileRecords(staged.artifact.files);
  const previousFiles = redactFileRecords(baseline.artifact?.files ?? []);
  return liveCase(record, review.risk, {
    ecosystem: "pypi",
    files,
    previousFiles,
    diff: review.diff,
    packageJsonDiff: summarizePackageJsonDiff(
      baseline.artifact?.manifest,
      staged.artifact.manifest,
    ),
    ruleFindings: releaseRuleFindings(
      review.ruleFindings,
      review.diff,
      files,
      previousFiles,
      "python",
    ),
    previousVersionAvailable: baseline.artifact !== null,
  });
}

function buildVscodeLiveCase(record) {
  const fx = record.fx;
  const path = fx.artifactPath ?? `dist/${fx.extensionId}-${fx.version}.vsix`;
  const manifest = buildVscodeReleaseManifest(fx.extensionId, fx.version, [
    { path, sha256: fx.sha256 },
  ]);
  const review = createVscodeExtensionReview({
    manifest,
    artifact: { path, sha256: fx.sha256, files: fx.stagedFiles },
    ...(fx.previousFiles
      ? {
          previousArtifact: { path, sha256: fx.previousSha256, files: fx.previousFiles },
        }
      : {}),
  });
  const files = normalizeVsixFiles(fx.stagedFiles);
  const previousFiles = normalizeVsixFiles(fx.previousFiles ?? []);
  const redactedFiles = redactFileRecords(files);
  const redactedPreviousFiles = redactFileRecords(previousFiles);
  const stagedManifest = packageJsonSummaryForVscode(parseVscodeExtensionManifest(files).manifest);
  const previousManifest = previousFiles.length
    ? packageJsonSummaryForVscode(parseVscodeExtensionManifest(previousFiles).manifest)
    : null;
  return liveCase(record, review.risk, {
    ecosystem: "vscode",
    files: redactedFiles,
    previousFiles: redactedPreviousFiles,
    diff: review.diff,
    packageJsonDiff: summarizePackageJsonDiff(previousManifest, stagedManifest),
    ruleFindings: releaseRuleFindings(
      review.ruleFindings,
      review.diff,
      redactedFiles,
      redactedPreviousFiles,
      "javascript",
    ),
    previousVersionAvailable: previousFiles.length > 0,
  });
}

// Build every staged ecosystem through its production acquisition/review
// helpers. atpm is public-diff-only, so it remains an explicit skip.
export function buildLiveCases(corpus = loadCorpus()) {
  const records = [...corpus.regression, ...corpus.frontier, ...corpus.benign];
  const cases = [];
  const skipped = [];

  for (const record of records) {
    if (record.ecosystem === "npm") cases.push(buildNpmLiveCase(record));
    else if (record.ecosystem === "pypi") cases.push(buildPyPiLiveCase(record));
    else if (record.ecosystem === "vscode") cases.push(buildVscodeLiveCase(record));
    else {
      skipped.push({
        id: record.id,
        ecosystem: record.ecosystem,
        reason: "ecosystem does not run staged AI review",
      });
    }
  }

  return { cases, skipped };
}

// A fixture's live outcome, scored on the same predicates the recorded eval
// uses so the two reports mean the same thing.
export function scoreRun(testCase, result) {
  const review = result.review;
  const usage = result.usage ?? null;
  const usageAvailable =
    typeof usage?.inputTokens === "number" && typeof usage.outputTokens === "number";
  const completed = review.status === "complete";
  const productRisk = combineRisk(testCase.deterministicRisk, computeScanRisk([], review));
  const expectedRiskPassed =
    completed && RISK_RANK[productRisk] >= RISK_RANK[testCase.expectMinRisk];
  const aiCaught = testCase.verdict === "malicious" ? isMaliciousCaught(review) : null;
  const passed =
    testCase.verdict === "malicious"
      ? expectedRiskPassed
      : testCase.verdict === "benign"
        ? isBenignClean(review)
        : expectedRiskPassed || isUncertaintyEscalated(review);

  return {
    id: testCase.id,
    kind: testCase.kind,
    verdict: testCase.verdict,
    threatClass: testCase.threatClass,
    expectMinRisk: testCase.expectMinRisk,
    deterministicRisk: testCase.deterministicRisk,
    releaseDeterministicRisk: testCase.releaseDeterministicRisk,
    status: review.status,
    completed,
    passed,
    aiCaught,
    productRisk,
    risk: review.risk,
    releaseAssessment: review.releaseAssessment,
    findingCount: review.findings.length,
    requiresManualReview: review.requiresManualReview,
    summary: review.summary,
    usageAvailable,
    steps: usage?.steps ?? 0,
    inputTokens: usage?.inputTokens ?? 0,
    cachedInputTokens: usage?.cachedInputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    durationMs: result.durationMs ?? 0,
  };
}

function scoreHarnessError(testCase, error, durationMs) {
  return {
    id: testCase.id,
    kind: testCase.kind,
    verdict: testCase.verdict,
    threatClass: testCase.threatClass,
    expectMinRisk: testCase.expectMinRisk,
    deterministicRisk: testCase.deterministicRisk,
    releaseDeterministicRisk: testCase.releaseDeterministicRisk,
    status: "harness_error",
    completed: false,
    passed: false,
    aiCaught: false,
    productRisk: "unknown",
    risk: "unknown",
    releaseAssessment: "not_assessed",
    findingCount: 0,
    requiresManualReview: true,
    summary: "The live eval run failed before producing a review.",
    usageAvailable: false,
    steps: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    durationMs,
    errorName: error instanceof Error ? error.name : "UnknownError",
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
  const frontier = malicious.filter((run) => run.kind === "frontier");
  const benign = runs.filter((run) => run.verdict === "benign");
  const completed = runs.filter((run) => run.completed);
  const usageRuns = runs.filter((run) => run.usageAvailable);
  const costs = usageRuns.map((run) => estimateCost(model, run)).filter((cost) => cost !== null);
  const totalInput = usageRuns.reduce((total, run) => total + run.inputTokens, 0);
  const totalCached = usageRuns.reduce((total, run) => total + run.cachedInputTokens, 0);

  return {
    model,
    total: runs.length,
    // Completion rate is listed first deliberately: a model that scores well on
    // the cases it finishes but rarely finishes is worse for the product than a
    // duller model that always lands a submission.
    completionRate: rate(completed.length, runs.length),
    invalidRate: rate(runs.filter((run) => run.status === "invalid").length, runs.length),
    unavailableRate: rate(runs.filter((run) => run.status === "unavailable").length, runs.length),
    harnessErrorRate: rate(
      runs.filter((run) => run.status === "harness_error").length,
      runs.length,
    ),
    costCoverage: rate(costs.length, runs.length),
    productCoverageRate: rate(malicious.filter((run) => run.passed).length, malicious.length),
    aiCatchRate: rate(malicious.filter((run) => run.aiCaught).length, malicious.length),
    frontierCatchRate: rate(frontier.filter((run) => run.aiCaught).length, frontier.length),
    falsePositiveRate: rate(benign.filter((run) => !run.passed).length, benign.length),
    manualReviewRate: rate(runs.filter((run) => run.requiresManualReview).length, runs.length),
    avgSteps: mean(usageRuns.map((run) => run.steps)),
    avgDurationMs: mean(runs.map((run) => run.durationMs)),
    avgInputTokens: mean(usageRuns.map((run) => run.inputTokens)),
    avgOutputTokens: mean(usageRuns.map((run) => run.outputTokens)),
    cachedInputShare: totalInput ? totalCached / totalInput : 0,
    avgCostUsd: costs.length ? mean(costs) : null,
    totalCostUsd: costs.length ? costs.reduce((total, cost) => total + cost, 0) : null,
    runs,
  };
}

function liveLanguageModelFactory({ accountId, apiKey, gatewayId, direct }, options) {
  const provider = createWorkersAI({
    accountId,
    apiKey,
    ...(direct ? {} : { gateway: { id: gatewayId } }),
  });
  return (model) => {
    const reasoningEffort = aiReviewReasoningEffort(model);
    return provider(model, {
      // Mirror production's headers exactly. Measuring cached-token share under
      // different affinity headers than the Worker sends would compare a
      // request shape that never ships. `attempt` is always 1 here: the
      // harness measures a first attempt, not retry behavior.
      extraHeaders: aiReviewRequestHeaders({ AI_CACHE_AFFINITY: "" }, options, model, 1),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    });
  };
}

export async function runAiReviewModelComparison({
  accountId,
  apiKey,
  gatewayId = "drydock-gateway",
  models = DEFAULT_COMPARISON_MODELS,
  corpus,
  limit,
  offset = 0,
  caseIds,
  direct = false,
  onProgress,
  // Test seam, mirroring `analyzeWithAi`'s own `languageModelOverride`: lets the
  // offline suite exercise per-model isolation, progress reporting, and
  // truncation bookkeeping without spending money on the network.
  analyze = analyzeWithAi,
} = {}) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error("Live AI comparison needs at least one model");
  }
  const models_ = models.map((model) => String(model).trim());
  if (models_.some((model) => !model)) {
    throw new Error("Live AI comparison model ids must be non-empty strings");
  }
  if (new Set(models_).size !== models_.length) {
    throw new Error("Live AI comparison received a duplicate model id");
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("Live AI comparison limit must be a positive integer");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("Live AI comparison offset must be a non-negative integer");
  }
  const caseIds_ = caseIds?.map((id) => String(id).trim());
  if (caseIds_ && (caseIds_.some((id) => !id) || new Set(caseIds_).size !== caseIds_.length)) {
    throw new Error("Live AI comparison case ids must be unique non-empty strings");
  }

  const { cases: allCases, skipped } = buildLiveCases(corpus);
  if (allCases.length === 0) throw new Error("Live AI comparison has no supported fixtures");
  const availableIds = new Set(allCases.map((testCase) => testCase.id));
  const unknownCaseIds = caseIds_?.filter((id) => !availableIds.has(id)) ?? [];
  if (unknownCaseIds.length) {
    throw new Error(`Live AI comparison received unknown case ids: ${unknownCaseIds.join(", ")}`);
  }
  const selectedCases = caseIds_
    ? caseIds_.map((id) => allCases.find((testCase) => testCase.id === id))
    : allCases;
  if (selectedCases.length === 0) throw new Error("Live AI comparison selected no fixtures");
  const remainingCases = selectedCases.slice(offset);
  if (remainingCases.length === 0) {
    throw new Error("Live AI comparison offset selected no fixtures");
  }
  const cases = typeof limit === "number" ? remainingCases.slice(0, limit) : remainingCases;
  const byModel = [];

  for (const model of models_) {
    const runs = [];
    for (const testCase of cases) {
      const startedAt = Date.now();
      let run;
      try {
        // One model at a time: `analyzeWithAi` takes a candidate list and fails
        // over, which is exactly what a per-model comparison must not do.
        const result = await analyze(
          {},
          [model],
          testCase.options,
          liveLanguageModelFactory({ accountId, apiKey, gatewayId, direct }, testCase.options),
        );
        run = scoreRun(testCase, { ...result, durationMs: Date.now() - startedAt });
      } catch (error) {
        run = scoreHarnessError(testCase, error, Date.now() - startedAt);
      }
      runs.push(run);
      onProgress?.({ model, run });
    }
    byModel.push(summarizeModel(model, runs));
  }

  return {
    generatedAt: new Date().toISOString(),
    reviewerVersion: AI_REVIEWER_VERSION,
    models: models_,
    transport: direct ? "direct" : "gateway",
    selectedCaseIds: caseIds_ ?? null,
    offset,
    caseCount: cases.length,
    // Never let a bounded run read as full coverage.
    skipped,
    truncated: remainingCases.length - cases.length,
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
    `- transport: ${result.transport ?? "gateway"}`,
    `- fixtures per model: ${result.caseCount}`,
  ];
  if (result.offset) {
    lines.push(`- resumed after fixtures: ${result.offset}`);
  }
  if (result.selectedCaseIds) {
    lines.push(`- selected fixtures: ${result.selectedCaseIds.length}`);
  }
  if (result.truncated) {
    lines.push(`- **truncated**: ${result.truncated} staged fixtures not run (\`--limit\`)`);
  }
  if (result.skipped.length) {
    lines.push(`- skipped (no staged AI review): ${result.skipped.length}`);
  }
  lines.push(
    "",
    "| model | completion | product coverage | frontier AI catch | false pos | cached in | avg steps | avg cost | total cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...result.byModel.map((entry) =>
      [
        entry.model,
        percent(entry.completionRate),
        percent(entry.productCoverageRate),
        percent(entry.frontierCatchRate),
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
      `- invalid: ${percent(entry.invalidRate)} · unavailable: ${percent(entry.unavailableRate)} · harness errors: ${percent(entry.harnessErrorRate)}`,
      `- cost coverage: ${percent(entry.costCoverage)} (unpriced or errored runs excluded)`,
      `- avg latency: ${(entry.avgDurationMs / 1000).toFixed(1)}s · avg tokens in/out: ${entry.avgInputTokens.toFixed(0)}/${entry.avgOutputTokens.toFixed(0)}`,
      "",
      `- AI-only catch: ${percent(entry.aiCatchRate)} · product-policy coverage: ${percent(entry.productCoverageRate)}`,
      misses.length ? "Expectation misses:" : "Expectation misses: none.",
      "",
    );
    for (const miss of misses) {
      lines.push(
        `- \`${miss.id}\` (${miss.verdict}/${miss.threatClass}) → ${miss.status}/AI ${miss.risk}/product ${miss.productRisk}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function writeAiReviewModelComparisonReport(result, stem = "ai-review-model-compare") {
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(stem)) {
    throw new Error("AI reviewer report stem must be a simple filename");
  }
  const outDir = join(__dirname, "..", "..", ".context", "eval");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${stem}.json`), JSON.stringify(result, null, 2));
  writeFileSync(join(outDir, `${stem}.md`), renderMarkdown(result));
}
