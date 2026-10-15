// Paid, network-bound evaluation of the Clef prompt-injection screen. Gated off
// by default so `pnpm test` and `pnpm run verify` stay offline and free:
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm run eval:clef:live
//
// Optional: CLEF_LIVE_MODELS (clef,clef-flash), CLEF_LIVE_BATCH (spans per
// request, default 1; production sends up to 6), CLEF_LIVE_NEUTRAL_PATHS=1
// (hide span paths), CLEF_LIVE_LIMIT (cap spans while iterating),
// CLEF_LIVE_REPORT_STEM. It asserts nothing about quality; it fails only when
// no span was scored, which means the run was misconfigured.

import { describe, expect, test } from "vitest";
import {
  CLEF_MODELS,
  renderMarkdown,
  runClefEvaluation,
  writeClefReport,
} from "./clef-live-harness.mjs";

const enabled = process.env.CLEF_LIVE_EVAL === "1";

function positiveInteger(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}.`);
  }
  return value;
}

describe.skipIf(!enabled)("Clef injection screen live evaluation", () => {
  test(
    "scores the screen against labeled spans and the phrase rules",
    { timeout: 1_800_000 },
    async () => {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const apiKey = process.env.CLOUDFLARE_API_TOKEN;
      if (!accountId || !apiKey) {
        throw new Error("Clef evaluation needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");
      }
      const result = await runClefEvaluation({
        accountId,
        apiKey,
        models: process.env.CLEF_LIVE_MODELS
          ? process.env.CLEF_LIVE_MODELS.split(",")
              .map((model) => model.trim())
              .filter(Boolean)
          : CLEF_MODELS,
        batchSize: positiveInteger("CLEF_LIVE_BATCH"),
        neutralPaths: process.env.CLEF_LIVE_NEUTRAL_PATHS === "1",
        limit: positiveInteger("CLEF_LIVE_LIMIT"),
      });
      writeClefReport(result, process.env.CLEF_LIVE_REPORT_STEM || undefined);
      process.stdout.write(`\n${renderMarkdown(result)}`);

      expect(result.byModel.some((entry) => entry.summary.completed > 0)).toBe(true);
    },
  );
});
