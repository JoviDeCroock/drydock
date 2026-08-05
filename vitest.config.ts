import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

// Root config: runs the node and workers projects in a single Vitest process so
// the fast node suite overlaps with the slow Cloudflare-worker pool instead of
// running after it. Target a project directly with `vitest run --project node`
// or `--project workers`.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(rootDir, "drizzle"));

  return {
    test: {
      projects: [
        {
          test: {
            name: "node",
            include: ["test/**/*.test.{ts,mjs}"],
            exclude: ["test/workers/**/*.test.{ts,mjs}", "node_modules/**"],
            environment: "node",
            globals: false,
            // Worker threads skip the per-file process spawn that the default forks
            // pool pays. Isolation stays on: several files vi.mock the same modules.
            pool: "threads",
            // Distinct from the workers project: Vitest refuses to schedule projects
            // with different maxWorkers in the same group.
            sequence: { groupOrder: 1 },
          },
        },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./test/config/wrangler.jsonc" },
              miniflare: {
                bindings: {
                  TEST_MIGRATIONS: migrations,
                },
              },
            }),
          ],
          test: {
            name: "workers",
            include: ["test/workers/**/*.test.ts"],
            globals: false,
            setupFiles: ["./test/workers/setup.ts"],
            // Reusing pool workers across files pays the workerd/module import cost
            // once per worker instead of once per file.
            isolate: false,
            maxWorkers: 3,
            minWorkers: 1,
            sequence: { groupOrder: 2 },
          },
        },
      ],
    },
  };
});
