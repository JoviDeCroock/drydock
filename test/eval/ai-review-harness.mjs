import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AI_REVIEWER_VERSION,
  parsePersistedAiReview,
} from "../../server/lib/ai-review/contract.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(__dirname, "..", "fixtures", "ai-review-eval", "cases.json");
const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

export function isMaliciousCaught(review) {
  return (
    review.status === "complete" &&
    (RISK_RANK[review.risk] >= RISK_RANK.high ||
      review.releaseAssessment === "suspicious" ||
      review.releaseAssessment === "blocked" ||
      review.findings.some(
        (finding) => finding.severity === "high" || finding.severity === "critical",
      ))
  );
}

export function isBenignClean(review) {
  return (
    review.status === "complete" &&
    review.risk === "low" &&
    review.releaseAssessment === "nothing_unusual" &&
    review.requiresManualReview === false &&
    review.findings.every(
      (finding) => finding.severity !== "high" && finding.severity !== "critical",
    )
  );
}

export function isUncertaintyEscalated(review) {
  return (
    review.status !== "complete" ||
    review.requiresManualReview ||
    review.releaseAssessment !== "nothing_unusual" ||
    RISK_RANK[review.risk] >= RISK_RANK.medium
  );
}

function evaluateCase(record) {
  const review = parsePersistedAiReview(record.review);
  if (!review) return { ...record, passed: false, reason: "invalid persisted review shape" };
  if (review.reviewerVersion !== AI_REVIEWER_VERSION) {
    return {
      ...record,
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

function groupMetrics(results, key) {
  return Object.fromEntries(
    [...new Set(results.map((result) => result[key]))].sort().map((value) => {
      const group = results.filter((result) => result[key] === value);
      const passed = group.filter((result) => result.passed).length;
      return [value, { total: group.length, passed, rate: passed / group.length }];
    }),
  );
}

export function runAiReviewEval() {
  const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
  const results = corpus.cases.map(evaluateCase);
  const passed = results.filter((result) => result.passed).length;
  return {
    generatedAt: new Date().toISOString(),
    suiteVersion: corpus.suiteVersion,
    reviewerVersion: AI_REVIEWER_VERSION,
    summary: { total: results.length, passed, rate: passed / results.length },
    byVerdict: groupMetrics(results, "verdict"),
    byThreatClass: groupMetrics(results, "threatClass"),
    byScenario: groupMetrics(results, "scenario"),
    failures: results
      .filter((result) => !result.passed)
      .map(({ id, verdict, threatClass, scenario, reason }) => ({
        id,
        verdict,
        threatClass,
        scenario,
        reason,
      })),
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
    `- reviewer version: ${result.reviewerVersion}`,
    `- gated result: ${result.summary.passed}/${result.summary.total} (${percent(result.summary.rate)})`,
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
  lines.push("");
  return lines.join("\n");
}

export function writeAiReviewEvalReport(result) {
  try {
    const outDir = join(__dirname, "..", "..", ".context", "eval");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "ai-review-eval.json"), JSON.stringify(result, null, 2));
    writeFileSync(join(outDir, "ai-review-eval.md"), renderMarkdown(result));
  } catch {
    // Report writing is best-effort; never fail the eval over a filesystem issue.
  }
}
