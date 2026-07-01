// AI-reviewer eval harness.
//
// The detection harness (test/eval/harness.mjs) scores the *deterministic*
// rules. This one scores the *AI reviewer* — the agentic Workers AI loop in
// server/lib/ai-review.ts — so we can compare models (e.g. a cheaper fallback)
// on the same labeled corpus before switching what production runs.
//
// It reuses the real production code path: every case is turned into the exact
// SelectiveAiReviewOptions the scan pipeline builds (deterministic findings +
// diff + manifest diff over the fixture's staged/previous files), then fed
// through analyzeWithAi with a per-model language model. Nothing here mocks the
// reviewer contract, so a passing eval reflects what a real scan would produce.
//
// Only npm cases are scored: the fixture payload maps 1:1 to the npm reviewer
// options (files/diff/packageJsonDiff). PyPI cases use a different artifact
// shape and are skipped. See docs/ai-review-eval.md.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPackageDiff,
  deterministicFindings,
  packageJsonDiffFindings,
  summarizePackageJsonDiff,
} from "../../server/lib/review.ts";
import { analyzeWithAi } from "../../server/lib/ai-review.ts";
import { loadCorpus } from "./harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 };
const riskRank = (level) => RISK_RANK[level] ?? 0;

// A review "flags" a release the way production surfaces it: a completed review
// whose own risk roll-up is medium or higher. invalid/unavailable are not a
// flag — they fail *open* here (counted as errors), because in production they
// escalate to manual review rather than asserting risk.
const FLAG_RISK = RISK_RANK.medium;

// Load the npm slice of the labeled corpus. Each record already carries the
// eval labels (verdict / expectMinRisk / threatClass) the detection harness
// derives; we just narrow to npm and tag the group.
export function loadNpmCorpus() {
  const { regression, frontier, benign } = loadCorpus();
  return [...regression, ...frontier, ...benign]
    .filter((record) => record.ecosystem === "npm")
    .map((record) => ({ ...record, group: record.kind }));
}

// Rebuild the exact reviewer input the scan pipeline feeds the model
// (server/lib/scan-pipeline.ts -> runSelectiveAiReview): deterministic findings
// plus the file/manifest diff over the fixture's staged and previous files.
export function buildReviewOptions(record) {
  const fx = record.fx;
  const previousFiles = fx.previousFiles ?? [];
  const stagedFiles = fx.stagedFiles ?? [];
  const diff = createPackageDiff(previousFiles, stagedFiles);
  const packageJsonDiff = summarizePackageJsonDiff(fx.previousPackageJson, fx.stagedPackageJson);
  const ruleFindings = [
    ...deterministicFindings(stagedFiles, diff, fx.stagedPackageJson),
    ...packageJsonDiffFindings(packageJsonDiff),
  ];
  return {
    scanId: `eval-${record.id}`,
    ecosystem: "npm",
    files: stagedFiles,
    previousFiles,
    diff,
    packageJsonDiff,
    ruleFindings,
    previousVersionAvailable: previousFiles.length > 0,
  };
}

function scoreCase(record, review, usage, latencyMs, error) {
  const status = error ? "error" : (review?.status ?? "error");
  const complete = status === "complete";
  const risk = complete ? review.risk : "low";
  // Model-agnostic flag: does the model's own roll-up land >= medium?
  const flaggedRisky = complete && riskRank(risk) >= FLAG_RISK;
  // Stricter: does it reach the label's expected minimum risk?
  const caughtAtExpected = complete && riskRank(risk) >= riskRank(record.expectMinRisk);
  return {
    id: record.id,
    group: record.group,
    threatClass: record.threatClass,
    verdict: record.verdict,
    expectMinRisk: record.expectMinRisk,
    status,
    error: error ?? null,
    risk: complete ? risk : null,
    releaseAssessment: complete ? review.releaseAssessment : (review?.releaseAssessment ?? null),
    summary: review?.summary ?? null,
    findingCount: review?.findings?.length ?? 0,
    flaggedRisky,
    caughtAtExpected,
    steps: usage?.steps ?? null,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
    latencyMs,
  };
}

function mean(values) {
  const nums = values.filter((value) => typeof value === "number");
  if (nums.length === 0) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function sum(values) {
  return values.reduce((total, value) => total + (typeof value === "number" ? value : 0), 0);
}

// Aggregate one model's per-case results into the comparison metrics. Kept pure
// (no model calls) so it can be unit-tested against mock reviewer output.
export function summarize(caseResults) {
  const malicious = caseResults.filter((result) => result.verdict === "malicious");
  const benign = caseResults.filter((result) => result.verdict === "benign");
  const completed = caseResults.filter((result) => result.status === "complete");
  const errored = caseResults.filter((result) => result.status !== "complete");

  const maliciousCaught = malicious.filter((result) => result.caughtAtExpected);
  const maliciousFlagged = malicious.filter((result) => result.flaggedRisky);
  const benignFalsePositives = benign.filter((result) => result.flaggedRisky);

  const rate = (part, whole) => (whole.length ? part.length / whole.length : null);

  const perThreatClass = {};
  for (const result of malicious) {
    const bucket = (perThreatClass[result.threatClass] ??= { total: 0, caught: 0 });
    bucket.total += 1;
    if (result.caughtAtExpected) bucket.caught += 1;
  }

  return {
    total: caseResults.length,
    malicious: malicious.length,
    benign: benign.length,
    completed: completed.length,
    errored: errored.length,
    errorRate: rate(errored, caseResults),
    // Recall at the labeled expected minimum risk.
    recall: rate(maliciousCaught, malicious),
    // Recall at any risky roll-up (>= medium) — a looser, model-agnostic bar.
    riskyRecall: rate(maliciousFlagged, malicious),
    benignFalsePositives: benignFalsePositives.length,
    benignFpRate: rate(benignFalsePositives, benign),
    misses:
      maliciousCaught.length < malicious.length
        ? malicious
            .filter((result) => !result.caughtAtExpected)
            .map((result) => ({
              id: result.id,
              threatClass: result.threatClass,
              status: result.status,
            }))
        : [],
    falsePositives: benignFalsePositives.map((result) => ({ id: result.id, risk: result.risk })),
    perThreatClass,
    avgSteps: mean(completed.map((result) => result.steps)),
    avgInputTokens: mean(completed.map((result) => result.inputTokens)),
    avgOutputTokens: mean(completed.map((result) => result.outputTokens)),
    avgTotalTokens: mean(completed.map((result) => result.totalTokens)),
    avgLatencyMs: mean(completed.map((result) => result.latencyMs)),
    totalInputTokens: sum(caseResults.map((result) => result.inputTokens)),
    totalOutputTokens: sum(caseResults.map((result) => result.outputTokens)),
    totalTokens: sum(caseResults.map((result) => result.totalTokens)),
  };
}

// Run every case through analyzeWithAi for a single model. `createLanguageModel`
// returns the AI SDK LanguageModel for a given model id — a live Workers AI
// model in the runner, or a mock in tests. Bounded concurrency keeps a slow
// model from serializing the whole run without hammering the gateway.
export async function evaluateModel({
  model,
  createLanguageModel,
  cases,
  concurrency = 4,
  onResult,
}) {
  const results = Array.from({ length: cases.length });
  let next = 0;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= cases.length) return;
      const record = cases[index];
      const options = buildReviewOptions(record);
      const startedAt = Date.now();
      let review = null;
      let usage = null;
      let error = null;
      try {
        const outcome = await analyzeWithAi({}, model, options, (modelId) =>
          createLanguageModel(modelId),
        );
        review = outcome.review;
        usage = outcome.usage;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      const scored = scoreCase(record, review, usage, Date.now() - startedAt, error);
      results[index] = scored;
      onResult?.(scored);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, cases.length)) }, worker);
  await Promise.all(workers);
  return { model, metrics: summarize(results), cases: results };
}

// price: optional { input, output } USD per 1M tokens. Returns null when no
// price is known so the report can honestly print "n/a" instead of guessing.
export function estimateCost(metrics, price) {
  if (!price || (price.input == null && price.output == null)) return null;
  const input = (metrics.totalInputTokens / 1_000_000) * (price.input ?? 0);
  const output = (metrics.totalOutputTokens / 1_000_000) * (price.output ?? 0);
  return input + output;
}

function pct(value) {
  return value == null ? "n/a" : `${(value * 100).toFixed(0)}%`;
}

function num(value, digits = 0) {
  return value == null ? "n/a" : value.toFixed(digits);
}

function usd(value) {
  return value == null ? "n/a" : `$${value.toFixed(4)}`;
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push("# AI reviewer eval report");
  lines.push("");
  lines.push(`- generated: ${report.generatedAt}`);
  lines.push(
    `- corpus: ${report.corpusSize} npm cases (${report.malicious} malicious, ${report.benign} benign)`,
  );
  lines.push("");
  lines.push("Recall is measured at each case's labeled expected minimum risk;");
  lines.push("benign FP rate is the share of benign controls the model rolls up to >= medium.");
  lines.push("");
  lines.push(
    "| model | recall | risky-recall | benign FP | errors | avg steps | avg in tok | avg out tok | avg latency | est. cost |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const entry of report.models) {
    const m = entry.metrics;
    lines.push(
      `| \`${entry.model}\` | ${pct(m.recall)} | ${pct(m.riskyRecall)} | ${pct(m.benignFpRate)} (${m.benignFalsePositives}/${m.benign}) | ${pct(m.errorRate)} | ${num(m.avgSteps, 1)} | ${num(m.avgInputTokens)} | ${num(m.avgOutputTokens)} | ${num(m.avgLatencyMs)}ms | ${usd(entry.cost)} |`,
    );
  }
  lines.push("");
  for (const entry of report.models) {
    lines.push(`## \`${entry.model}\``);
    lines.push("");
    const m = entry.metrics;
    if (m.misses.length) {
      lines.push("Missed malicious cases:");
      for (const miss of m.misses) {
        lines.push(`- \`${miss.id}\` (${miss.threatClass}) — status ${miss.status}`);
      }
      lines.push("");
    }
    if (m.falsePositives.length) {
      lines.push("Benign false positives:");
      for (const fp of m.falsePositives) {
        lines.push(`- \`${fp.id}\` — risk ${fp.risk}`);
      }
      lines.push("");
    }
    if (!m.misses.length && !m.falsePositives.length) {
      lines.push("No missed malicious cases or benign false positives.");
      lines.push("");
    }
  }
  return lines.join("\n");
}

export function renderTsv(report) {
  const rows = [
    [
      "model",
      "recall",
      "riskyRecall",
      "benignFpRate",
      "errorRate",
      "avgSteps",
      "avgInputTokens",
      "avgOutputTokens",
      "avgLatencyMs",
      "estCostUsd",
    ].join("\t"),
  ];
  for (const entry of report.models) {
    const m = entry.metrics;
    rows.push(
      [
        entry.model,
        pct(m.recall),
        pct(m.riskyRecall),
        pct(m.benignFpRate),
        pct(m.errorRate),
        num(m.avgSteps, 1),
        num(m.avgInputTokens),
        num(m.avgOutputTokens),
        num(m.avgLatencyMs),
        entry.cost == null ? "n/a" : entry.cost.toFixed(4),
      ].join("\t"),
    );
  }
  return rows.join("\n");
}

export function writeReport(report, outDir = join(__dirname, "..", "..", ".context", "eval")) {
  try {
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "ai-review-eval.json"), JSON.stringify(report, null, 2));
    writeFileSync(join(outDir, "ai-review-eval.md"), renderMarkdown(report));
    writeFileSync(join(outDir, "ai-review-eval.tsv"), renderTsv(report));
    return outDir;
  } catch {
    // Report writing is best-effort; never fail the eval over a filesystem issue.
    return null;
  }
}
