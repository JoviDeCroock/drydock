// AI reviewer model comparison. This is NOT part of `pnpm test`/CI: it makes
// live, paid Workers AI calls and is non-deterministic. Run it on demand with
//
//   pnpm run eval:ai
//
// It is deliberately excluded from the default node project (vitest.node.config.ts)
// and only picked up by vitest.ai-eval.config.ts. Without Workers AI credentials
// it skips cleanly so an accidental invocation never fails.
//
// Configuration (all via env):
//   CLOUDFLARE_ACCOUNT_ID   Cloudflare account id (required)
//   CLOUDFLARE_API_TOKEN    Workers AI API token   (required; WORKERS_AI_API_TOKEN also accepted)
//   AI_EVAL_MODELS          comma-separated model ids to compare (default: the shipped candidates + cheaper ones)
//   AI_EVAL_GATEWAY_ID      AI Gateway id to route through (default: drydock-gateway; set AI_EVAL_NO_GATEWAY=1 to bypass)
//   AI_EVAL_PRICES          JSON map { "<model>": { "input": usdPer1MInput, "output": usdPer1MOutput } } for cost estimates
//   AI_EVAL_CONCURRENCY     per-model case concurrency (default: 4)
//   AI_EVAL_LIMIT           cap the number of cases (smoke runs)
//
// See docs/ai-review-eval.md.

import { describe, expect, test } from "vitest";
import { createWorkersAI } from "workers-ai-provider";
import { evaluateModel, estimateCost, loadNpmCorpus, writeReport } from "./ai-review-harness.mjs";

// The shipped reviewer order (see server/lib/ai-review.ts) plus a few cheaper /
// alternative Workers AI models to compare against. Override with AI_EVAL_MODELS.
const DEFAULT_MODELS = [
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/openai/gpt-oss-120b",
];

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiKey = process.env.CLOUDFLARE_API_TOKEN ?? process.env.WORKERS_AI_API_TOKEN;
const hasCredentials = Boolean(accountId && apiKey);

const models = (process.env.AI_EVAL_MODELS ?? DEFAULT_MODELS.join(","))
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);

const gatewayId = process.env.AI_EVAL_NO_GATEWAY
  ? undefined
  : (process.env.AI_EVAL_GATEWAY_ID ?? "drydock-gateway");

const concurrency = Number(process.env.AI_EVAL_CONCURRENCY ?? 4);

function parsePrices() {
  if (!process.env.AI_EVAL_PRICES) return {};
  try {
    return JSON.parse(process.env.AI_EVAL_PRICES);
  } catch (err) {
    throw new Error(
      `AI_EVAL_PRICES is not valid JSON: ${err instanceof Error ? err.message : err}`,
    );
  }
}

describe("AI reviewer model comparison", () => {
  test.skipIf(!hasCredentials || models.length === 0)(
    "scores every configured model on the npm corpus",
    async () => {
      const prices = parsePrices();
      const provider = createWorkersAI({ accountId, apiKey });
      const createLanguageModel = (model) =>
        provider(model, gatewayId ? { gateway: { id: gatewayId } } : {});

      const allCases = loadNpmCorpus();
      const limit = process.env.AI_EVAL_LIMIT ? Number(process.env.AI_EVAL_LIMIT) : allCases.length;
      const cases = allCases.slice(0, limit);
      expect(cases.length).toBeGreaterThan(0);

      const malicious = cases.filter((record) => record.verdict === "malicious").length;
      const evaluated = [];
      for (const model of models) {
        process.stdout.write(`\neval:ai — ${model} (${cases.length} cases)…\n`);
        let done = 0;
        const outcome = await evaluateModel({
          model,
          createLanguageModel,
          cases,
          concurrency,
          onResult: () => {
            done += 1;
            process.stdout.write(`  ${done}/${cases.length}\r`);
          },
        });
        evaluated.push({
          model,
          metrics: outcome.metrics,
          cost: estimateCost(outcome.metrics, prices[model]),
          cases: outcome.cases,
        });
      }

      const report = {
        generatedAt: new Date().toISOString(),
        corpusSize: cases.length,
        malicious,
        benign: cases.length - malicious,
        gatewayId: gatewayId ?? null,
        models: evaluated,
      };

      const outDir = writeReport(report);
      process.stdout.write("\n\nmodel comparison:\n");
      for (const entry of report.models) {
        const m = entry.metrics;
        const fmt = (value) => (value == null ? "n/a" : `${(value * 100).toFixed(0)}%`);
        process.stdout.write(
          `  ${entry.model}: recall ${fmt(m.recall)}, benign FP ${fmt(m.benignFpRate)}, errors ${fmt(m.errorRate)}, avg ${m.avgTotalTokens == null ? "n/a" : m.avgTotalTokens.toFixed(0)} tok\n`,
        );
      }
      if (outDir)
        process.stdout.write(`\nreport written to ${outDir}/ai-review-eval.{md,json,tsv}\n`);

      // The eval reports quality; it does not gate. Assert only that every model
      // produced a scored result so a broken harness/credentials fails loudly.
      for (const entry of report.models) {
        expect(entry.metrics.total).toBe(cases.length);
      }
    },
    // Live agentic runs across the corpus for several models are slow.
    30 * 60 * 1000,
  );
});
