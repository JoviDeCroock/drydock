import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AI_REVIEWER_VERSION,
  parsePersistedAiReview,
} from "../../server/lib/ai-review/contract.ts";
import { computeScanRisk } from "../../server/lib/review/risk.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(__dirname, "..", "fixtures", "ai-review-eval", "cases.json");
const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

export function isMaliciousCaught(review) {
  return review.status === "complete" && RISK_RANK[computeScanRisk([], review)] >= RISK_RANK.high;
}

export function isBenignClean(review) {
  return (
    review.status === "complete" &&
    computeScanRisk([], review) === "low" &&
    review.releaseAssessment === "nothing_unusual" &&
    review.requiresManualReview === false &&
    review.findings.every(
      (finding) => finding.severity !== "high" && finding.severity !== "critical",
    )
  );
}

export function isUncertaintyEscalated(review) {
  return RISK_RANK[computeScanRisk([], review)] >= RISK_RANK.medium;
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`AI review eval ${field} must be a non-empty string`);
  }
}

function validateAiReviewCorpus(corpus) {
  if (!corpus || typeof corpus !== "object" || Array.isArray(corpus)) {
    throw new Error("AI review eval corpus must be an object");
  }
  if (!Number.isInteger(corpus.suiteVersion) || corpus.suiteVersion < 1) {
    throw new Error("AI review eval suiteVersion must be a positive integer");
  }
  if (!Array.isArray(corpus.cases)) {
    throw new Error("AI review eval cases must be an array");
  }
  const historicalCases = corpus.historicalCases ?? [];
  if (!Array.isArray(historicalCases)) {
    throw new Error("AI review eval historicalCases must be an array");
  }
  if (corpus.cases.length === 0 && historicalCases.length === 0) {
    throw new Error("AI review eval cases must contain at least one record");
  }

  const ids = new Set();
  for (const [index, record] of [...corpus.cases, ...historicalCases].entries()) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`AI review eval case ${index} must be an object`);
    }
    requireNonEmptyString(record.id, `case ${index} id`);
    if (ids.has(record.id)) throw new Error(`AI review eval duplicate case id ${record.id}`);
    ids.add(record.id);
    if (!new Set(["malicious", "benign", "uncertain"]).has(record.verdict)) {
      throw new Error(`AI review eval case ${record.id} has invalid verdict`);
    }
    requireNonEmptyString(record.threatClass, `case ${record.id} threatClass`);
    requireNonEmptyString(record.scenario, `case ${record.id} scenario`);
  }
  return corpus;
}

function evaluateCase(record, expectedReviewerVersion) {
  const review = parsePersistedAiReview(record.review);
  if (!review) return { ...record, passed: false, reason: "invalid persisted review shape" };
  if (expectedReviewerVersion && review.reviewerVersion !== expectedReviewerVersion) {
    return {
      ...record,
      review,
      passed: false,
      reason: `reviewer version ${review.reviewerVersion ?? "legacy"} is not current`,
    };
  }

  const passed =
    record.verdict === "malicious"
      ? isMaliciousCaught(review)
      : record.verdict === "benign"
        ? isBenignClean(review)
        : isUncertaintyEscalated(review);
  return {
    ...record,
    review,
    passed,
    reason: passed ? null : `${record.verdict} expectation missed`,
  };
}

function summaryMetrics(results) {
  const passed = results.filter((result) => result.passed).length;
  return { total: results.length, passed, rate: results.length ? passed / results.length : 0 };
}

function failures(results) {
  return results
    .filter((result) => !result.passed)
    .map(({ id, verdict, threatClass, scenario, reason }) => ({
      id,
      verdict,
      threatClass,
      scenario,
      reason,
    }));
}

function groupMetrics(results, key) {
  return Object.fromEntries(
    [...new Set(results.map((result) => result[key]))].sort().map((value) => {
      const group = results.filter((result) => result[key] === value);
      const passed = group.filter((result) => result.passed).length;
      return [value, { total: group.length, passed, rate: passed / group.length }];
    }),
  );
}

export function runAiReviewEval(corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8"))) {
  validateAiReviewCorpus(corpus);
  const results = corpus.cases.map((record) => evaluateCase(record, AI_REVIEWER_VERSION));
  const historicalResults = (corpus.historicalCases ?? []).map((record) => evaluateCase(record));
  const allResults = [...results, ...historicalResults];
  return {
    generatedAt: new Date().toISOString(),
    suiteVersion: corpus.suiteVersion,
    currentReviewerVersion: AI_REVIEWER_VERSION,
    recordedReviewerVersions: [
      ...new Set(allResults.map((result) => result.review?.reviewerVersion ?? "legacy")),
    ].sort(),
    summary: summaryMetrics(results),
    byVerdict: groupMetrics(results, "verdict"),
    byThreatClass: groupMetrics(results, "threatClass"),
    byScenario: groupMetrics(results, "scenario"),
    failures: failures(results),
    historicalSummary: summaryMetrics(historicalResults),
    historicalByScenario: groupMetrics(historicalResults, "scenario"),
    historicalFailures: failures(historicalResults),
  };
}

function percent(value) {
  return `${(value * 100).toFixed(0)}%`;
}

function renderGroups(title, groups) {
  return [
    `## ${title}`,
    "",
    "| group | passed | rate |",
    "| --- | --- | --- |",
    ...Object.entries(groups).map(
      ([name, value]) => `| ${name} | ${value.passed}/${value.total} | ${percent(value.rate)} |`,
    ),
    "",
  ];
}

function renderMarkdown(result) {
  const lines = [
    "# AI reviewer eval report",
    "",
    `- generated: ${result.generatedAt}`,
    `- suite version: ${result.suiteVersion}`,
    `- current reviewer version: ${result.currentReviewerVersion}`,
    `- recorded output versions: ${result.recordedReviewerVersions.join(", ")}`,
    `- gated result: ${result.summary.passed}/${result.summary.total} (${percent(result.summary.rate)})`,
    `- historical compatibility: ${result.historicalSummary.passed}/${result.historicalSummary.total} (${percent(result.historicalSummary.rate)}, version-agnostic)`,
    "",
    ...renderGroups("Verdicts", result.byVerdict),
    ...renderGroups("Threat classes", result.byThreatClass),
    ...renderGroups("Scenarios", result.byScenario),
    "## Failures",
    "",
  ];
  if (result.failures.length === 0) lines.push("None.");
  for (const failure of result.failures) {
    lines.push(`- ${failure.id}: ${failure.reason}`);
  }
  lines.push("", "## Historical compatibility failures", "");
  if (result.historicalFailures.length === 0) lines.push("None.");
  for (const failure of result.historicalFailures) {
    lines.push(`- ${failure.id}: ${failure.reason}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function writeAiReviewEvalReport(result) {
  const outDir = join(__dirname, "..", "..", ".context", "eval");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "ai-review-eval.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(outDir, "ai-review-eval.md"), renderMarkdown(result));
}
