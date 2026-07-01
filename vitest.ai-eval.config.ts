import { defineConfig } from "vitest/config";

// Dedicated config for the on-demand AI reviewer model comparison
// (`pnpm run eval:ai`). It is intentionally NOT part of `pnpm test`/CI — the
// eval makes live, paid, non-deterministic Workers AI calls — so it lives in
// its own config and the default node project excludes the file.
export default defineConfig({
  test: {
    name: "ai-eval",
    include: ["test/eval/ai-review-eval.test.mjs"],
    environment: "node",
    globals: false,
    // A full agentic run per case across several models is slow; give the whole
    // file room and never bail early on the first slow model.
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 60 * 1000,
  },
});
