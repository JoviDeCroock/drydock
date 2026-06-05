import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("Wrangler static asset routing", () => {
  test("runs the Worker before the SPA fallback for server-owned paths", () => {
    const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const assetsBlock = config.match(/"assets"\s*:\s*\{(?<body>[\s\S]*?)\n\t\}/)?.groups?.body;

    expect(assetsBlock).toContain('"not_found_handling": "single-page-application"');
    expect(assetsBlock).toContain('"run_worker_first"');
    for (const route of ["/api", "/api/*", "/webhooks/*"]) {
      expect(assetsBlock).toContain(`"${route}"`);
    }
  });
});
