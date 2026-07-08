import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "node",
    include: ["test/**/*.test.{ts,mjs}"],
    exclude: ["test/workers/**/*.test.{ts,mjs}", "node_modules/**"],
    environment: "node",
    globals: false,
    // Worker threads skip the per-file process spawn that the default forks
    // pool pays. Isolation stays on: several files vi.mock the same modules.
    pool: "threads",
    // Distinct from the workers project: vitest refuses to schedule projects
    // with different maxWorkers in the same group (matters when one `vitest
    // run` invocation selects files from both projects).
    sequence: { groupOrder: 1 },
  },
});
