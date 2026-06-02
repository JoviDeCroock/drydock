import { defineConfig } from "vitest/config";

// Root config: runs the node and workers projects in a single Vitest process so
// the fast node suite overlaps with the slow Cloudflare-worker pool instead of
// running after it. Target a project directly with `vitest run --project node`
// or `--project workers`.
export default defineConfig({
  test: {
    projects: ["./vitest.node.config.ts", "./vitest.workers.config.ts"],
  },
});
