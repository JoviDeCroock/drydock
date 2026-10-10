// Live evaluation of the Clef prompt-injection screen.
//
// Runs the production question battery and thresholds
// (`server/lib/ai-review/injection-screen.ts`) over the labeled spans in
// `test/fixtures/clef-eval/injection-spans.json`, and scores the screen alone,
// the phrase rules (`file.prompt-injection`/`file.review-manipulation`) alone,
// the screen on what the rules miss, and rules-or-screen. It reports; nothing
// here can move a score. It costs money and needs credentials, so it never
// runs in `pnpm test` or `pnpm run verify`. See docs/ai-review-eval.md.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INJECTION_SCREEN_VERSION,
  injectionScreenDecision,
  injectionScreenQuestions,
} from "../../server/lib/ai-review/injection-screen.ts";
import { createPackageDiff, deterministicFindings } from "../../server/lib/review";
import { DETERMINISTIC_RULE_IDS } from "../../server/lib/review/rules/rule-ids.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const CLEF_MODELS = ["clef", "clef-flash"];

// Workers AI list price, USD per million input tokens (checked 2026-10-05 on
// the model page). Clef generates nothing; the API reports output_tokens: 0.
const INPUT_PRICE_PER_MILLION = 0.24;

const PHRASE_RULE_IDS = new Set([
  DETERMINISTIC_RULE_IDS.filePromptInjection,
  DETERMINISTIC_RULE_IDS.fileReviewManipulation,
]);
// ---------------------------------------------------------------------------
// Transport

export function clefClient({ accountId, apiKey, fetchImpl = fetch, retries = 3 }) {
  return async function askClef(model, state, questions) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/${model}`;
    const body = JSON.stringify({ model, state, questions });
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const started = Date.now();
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body,
      });
      const durationMs = Date.now() - started;
      if (response.ok) {
        // A parse error quotes the body, which can echo the request's package text.
        const payload = await response.json().catch(() => {
          throw new Error(`Clef ${model} returned an unreadable body`);
        });
        if (!payload?.success || !payload.result?.answers) {
          throw new Error(`Clef ${model} returned no answers`);
        }
        return { ...payload.result, durationMs };
      }
      // Never surface the response body: a provider error can echo the request.
      lastError = new Error(`Clef ${model} HTTP ${response.status}`);
      if (response.status !== 429 && response.status < 500) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
    throw lastError;
  };
}

async function mapPool(items, concurrency, fn) {
  const results = Array.from({ length: items.length });
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Metrics

// Mann–Whitney AUROC; ties count half. Null when a class is empty.
export function auroc(scored) {
  const positives = scored.filter((entry) => entry.label).map((entry) => entry.score);
  const negatives = scored.filter((entry) => !entry.label).map((entry) => entry.score);
  if (!positives.length || !negatives.length) return null;
  let wins = 0;
  for (const p of positives) {
    for (const n of negatives) wins += p > n ? 1 : p === n ? 0.5 : 0;
  }
  return wins / (positives.length * negatives.length);
}

function confusion(entries) {
  const tp = entries.filter((e) => e.label && e.predicted).length;
  const fp = entries.filter((e) => !e.label && e.predicted).length;
  const fn = entries.filter((e) => e.label && !e.predicted).length;
  const tn = entries.filter((e) => !e.label && !e.predicted).length;
  return {
    tp,
    fp,
    fn,
    tn,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    falsePositiveRate: fp + tn ? fp / (fp + tn) : null,
  };
}

function sweep(scored, thresholds) {
  return thresholds.map((threshold) => ({
    threshold,
    ...confusion(scored.map((e) => ({ label: e.label, predicted: e.score >= threshold }))),
  }));
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// ---------------------------------------------------------------------------
// Injection lane

function loadInjectionSpans(path = join(__dirname, "../fixtures/clef-eval/injection-spans.json")) {
  const corpus = JSON.parse(readFileSync(path, "utf8"));
  const ids = new Set();
  for (const span of corpus.spans) {
    if (ids.has(span.id)) throw new Error(`Duplicate injection span id ${span.id}`);
    ids.add(span.id);
    if (!["manipulation", "agent-instruction", "benign"].includes(span.label)) {
      throw new Error(`Injection span ${span.id} has invalid label`);
    }
  }
  return corpus.spans;
}

// The phrase rules see a span the way they would see an added file at that path.
function phraseRuleHits(span) {
  const file = { path: span.path, size: span.text.length, sha256: "0".repeat(64), flags: [] };
  file.textSample = span.text;
  const findings = deterministicFindings([file], createPackageDiff([], [file]), null, {});
  return [...new Set(findings.filter((f) => PHRASE_RULE_IDS.has(f.ruleId)).map((f) => f.ruleId))];
}

function scoreSpan(span, ruleHits, response, index) {
  const scores = {
    manipulation: response.answers[`manipulation.${index}`]?.noul ?? null,
    instruction: response.answers[`instruction.${index}`]?.noul ?? null,
    severity: response.answers[`severity.${index}`]?.score ?? null,
  };
  return {
    id: span.id,
    label: span.label,
    hardNegative: Boolean(span.hardNegative),
    origin: span.origin,
    ruleHits,
    ruleFires: ruleHits.length > 0,
    scores,
    screenFires:
      Object.values(scores).every((v) => v !== null) && injectionScreenDecision(scores).fires,
    inputTokens: response.usage?.input_tokens ?? null,
    durationMs: response.durationMs,
  };
}

// The screen's combined score: what a single threshold would cut on.
function hazardScore(run) {
  return Math.max(run.scores.manipulation ?? 0, run.scores.instruction ?? 0);
}

export function summarizeInjection(runs) {
  const completed = runs.filter((run) => !run.error);
  const isPositive = (run) => run.label !== "benign";
  const hazard = completed.map((run) => ({ label: isPositive(run), score: hazardScore(run) }));
  const ruleMissed = completed.filter((run) => !run.ruleFires);
  const hardNegatives = completed.filter((run) => run.hardNegative);
  const tokens = completed.map((run) => run.inputTokens).filter((t) => typeof t === "number");
  const misses = completed.filter((run) => isPositive(run) && !run.screenFires);
  const falseAlarms = completed.filter((run) => !isPositive(run) && run.screenFires);

  return {
    total: runs.length,
    completed: completed.length,
    errors: runs.filter((run) => run.error).map((run) => ({ id: run.id, error: run.error })),
    positives: completed.filter(isPositive).length,
    negatives: completed.filter((run) => !isPositive(run)).length,
    hardNegatives: hardNegatives.length,
    hazardAuroc: auroc(hazard),
    manipulationAuroc: auroc(
      completed.map((run) => ({
        label: run.label === "manipulation",
        score: run.scores.manipulation ?? 0,
      })),
    ),
    instructionAuroc: auroc(
      completed.map((run) => ({
        label: run.label === "agent-instruction",
        score: run.scores.instruction ?? 0,
      })),
    ),
    phraseRules: confusion(
      completed.map((run) => ({ label: isPositive(run), predicted: run.ruleFires })),
    ),
    screen: confusion(
      completed.map((run) => ({ label: isPositive(run), predicted: run.screenFires })),
    ),
    rulesOrScreen: confusion(
      completed.map((run) => ({
        label: isPositive(run),
        predicted: run.ruleFires || run.screenFires,
      })),
    ),
    // The screen's actual job: positives the phrase rules missed, and what it
    // costs on text they correctly left alone.
    screenOnRuleMisses: confusion(
      ruleMissed.map((run) => ({ label: isPositive(run), predicted: run.screenFires })),
    ),
    hardNegativeScreenFires: hardNegatives.filter((run) => run.screenFires).map((run) => run.id),
    hazardSweep: sweep(hazard, [0.5, 0.7, 0.8, 0.85, 0.9, 0.95]),
    misses: misses.map((run) => ({ id: run.id, label: run.label, scores: run.scores })),
    falseAlarms: falseAlarms.map((run) => ({ id: run.id, scores: run.scores })),
    avgInputTokens: mean(tokens),
    totalCostUsd: (tokens.reduce((a, b) => a + b, 0) * INPUT_PRICE_PER_MILLION) / 1_000_000,
    p50DurationMs: percentile(
      completed.map((run) => run.durationMs),
      50,
    ),
  };
}

// ---------------------------------------------------------------------------
// Runner

function stableKey(id) {
  return createHash("sha256").update(id).digest("hex");
}

export async function runClefEvaluation({
  accountId,
  apiKey,
  models = CLEF_MODELS,
  concurrency = 6,
  // Production asks about up to six spans per request.
  batchSize = 1,
  // Ablation: hide span paths, which a label-aware author may have chosen to fit.
  neutralPaths = false,
  limit,
  spans,
  ask = clefClient({ accountId, apiKey }),
  onProgress,
} = {}) {
  const allSpans = spans ?? loadInjectionSpans();
  const selected = limit ? allSpans.slice(0, limit) : allSpans;
  const ruleHitsById = new Map(selected.map((span) => [span.id, phraseRuleHits(span)]));
  // The fixture file is grouped by label; a stable hash order mixes attacks
  // and benign text into the same request, as real packages do.
  const ordered = [...selected].sort((a, b) => stableKey(a.id).localeCompare(stableKey(b.id)));
  const batches = [];
  for (let start = 0; start < ordered.length; start += batchSize) {
    batches.push(ordered.slice(start, start + batchSize));
  }

  const result = {
    generatedAt: new Date().toISOString(),
    screenVersion: INJECTION_SCREEN_VERSION,
    batchSize,
    neutralPaths,
    byModel: [],
  };
  for (const model of models) {
    const batchRuns = await mapPool(batches, concurrency, async (batch) => {
      const state = {
        ecosystem: "npm",
        spans: batch.map((span, index) => ({
          index,
          path: neutralPaths ? "file.txt" : span.path,
          text: span.text,
        })),
      };
      const questions = Object.assign(
        {},
        ...batch.map((_span, index) => injectionScreenQuestions(index)),
      );
      try {
        const response = await ask(model, state, questions);
        return batch.map((span, index) => {
          const run = scoreSpan(span, ruleHitsById.get(span.id), response, index);
          run.inputTokens = run.inputTokens === null ? null : run.inputTokens / batch.length;
          onProgress?.({ model, run });
          return run;
        });
      } catch (error) {
        return batch.map((span) => ({ id: span.id, label: span.label, error: error.message }));
      }
    });
    const runs = batchRuns.flat();
    result.byModel.push({ model, summary: summarizeInjection(runs), runs });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Report

const pct = (v) => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`);
const num = (v, d = 3) => (v === null || v === undefined ? "n/a" : v.toFixed(d));

export function renderMarkdown(result) {
  const first = result.byModel[0]?.summary;
  if (!first) return "# Clef injection screen\n\nNo models run.";
  const lines = [
    "# Clef injection screen",
    "",
    `Generated ${result.generatedAt}; screen ${result.screenVersion}, ${result.batchSize} span(s) per request${result.neutralPaths ? ", paths hidden" : ""}.`,
    `${first.completed} spans (${first.positives} injection, ${first.negatives} benign, ${first.hardNegatives} hard negatives).`,
    `Phrase rules alone: precision ${pct(first.phraseRules.precision)}, recall ${pct(first.phraseRules.recall)}.`,
    "",
    "| model | hazard AUROC | screen precision | screen recall | recall on rule misses | hard-negative fires | rules∪screen precision | rules∪screen recall | errors | cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const { model, summary: s } of result.byModel) {
    lines.push(
      `| ${model} | ${num(s.hazardAuroc)} | ${pct(s.screen.precision)} | ${pct(s.screen.recall)} | ${pct(s.screenOnRuleMisses.recall)} (${s.screenOnRuleMisses.tp}/${s.screenOnRuleMisses.tp + s.screenOnRuleMisses.fn}) | ${s.hardNegativeScreenFires.length}/${s.hardNegatives} | ${pct(s.rulesOrScreen.precision)} | ${pct(s.rulesOrScreen.recall)} | ${s.errors.length} | $${s.totalCostUsd.toFixed(4)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function writeClefReport(result, stem = "clef-injection-screen") {
  const dir = join(__dirname, "../../.context/eval");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stem}.json`), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(dir, `${stem}.md`), renderMarkdown(result));
}
