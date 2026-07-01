import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "node",
    include: ["test/**/*.test.{ts,mjs}"],
    exclude: [
      "test/workers/**/*.test.{ts,mjs}",
      // On-demand, live-model eval only — never part of `pnpm test`/CI.
      // Run it with `pnpm run eval:ai` (vitest.ai-eval.config.ts).
      "test/eval/ai-review-eval.test.mjs",
      "node_modules/**",
    ],
    environment: "node",
    globals: false,
  },
});
