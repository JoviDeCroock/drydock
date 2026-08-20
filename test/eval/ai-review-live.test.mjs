// Paid, network-bound entry point for the live model comparison.
//
// Gated off by default so `pnpm test` and `pnpm run verify` stay offline and
// free. Enable with `pnpm run eval:ai:live`, which sets AI_REVIEW_LIVE_EVAL and
// requires Cloudflare credentials:
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm run eval:ai:live
//
// Optional: AI_REVIEW_LIVE_MODELS (comma-separated model ids to compare),
// AI_REVIEW_LIVE_LIMIT (cap fixtures per model while iterating),
// AI_REVIEW_LIVE_GATEWAY (AI Gateway id).
//
// This asserts nothing about which model wins — picking a model is a judgement
// call over detection quality, completion rate, and cost together. It fails
// only on the one condition that makes the whole report meaningless: no model
// produced a single completed review, which means the run was misconfigured
// rather than informative.

import { describe, expect, test } from "vitest";
import {
  DEFAULT_COMPARISON_MODELS,
  renderMarkdown,
  runAiReviewModelComparison,
  writeAiReviewModelComparisonReport,
} from "./ai-review-live-harness.mjs";

const enabled = process.env.AI_REVIEW_LIVE_EVAL === "1";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiKey = process.env.CLOUDFLARE_API_TOKEN;

const models = process.env.AI_REVIEW_LIVE_MODELS
  ? process.env.AI_REVIEW_LIVE_MODELS.split(",")
      .map((model) => model.trim())
      .filter(Boolean)
  : DEFAULT_COMPARISON_MODELS;
// An unparseable limit would slice the corpus to nothing and bill a run that
// compares zero fixtures, so reject it up front rather than reporting an empty
// comparison as a result.
function parseLimit(raw) {
  if (!raw) return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`AI_REVIEW_LIVE_LIMIT must be a positive integer, got ${JSON.stringify(raw)}.`);
  }
  return limit;
}

const limit = parseLimit(process.env.AI_REVIEW_LIVE_LIMIT);

describe.skipIf(!enabled)("AI reviewer live model comparison", () => {
  test(
    "compares candidate models over the npm security corpus",
    { timeout: 3_600_000 },
    async () => {
      if (!accountId || !apiKey) {
        throw new Error(
          "Live model comparison needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.",
        );
      }

      const result = await runAiReviewModelComparison({
        accountId,
        apiKey,
        gatewayId: process.env.AI_REVIEW_LIVE_GATEWAY || undefined,
        models,
        limit,
        onProgress: ({ model, run }) => {
          process.stdout.write(
            `  ${model} ${run.id}: ${run.status} risk=${run.risk} steps=${run.steps} ${run.passed ? "pass" : "MISS"}\n`,
          );
        },
      });

      writeAiReviewModelComparisonReport(result);
      process.stdout.write(`\n${renderMarkdown(result)}\n`);

      expect(result.byModel.some((entry) => entry.completionRate > 0)).toBe(true);
    },
  );
});
