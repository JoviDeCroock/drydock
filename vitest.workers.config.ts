import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(rootDir, "drizzle"));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.test.jsonc" },
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
      // Each pool worker boots its own workerd + imports the full server module
      // graph through the module-fallback socket (~5s each), so more workers
      // means more redundant importing. Reusing workers across files
      // (isolate: false) pays that import once per worker instead of once per
      // file; 3 workers balances import overhead against test parallelism.
      isolate: false,
      maxWorkers: 3,
      minWorkers: 1,
      // See the node project config: distinct groupOrder lets a single `vitest
      // run` invocation mix files from both projects despite the different
      // maxWorkers.
      sequence: { groupOrder: 2 },
    },
  };
});
