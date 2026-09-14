import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("Wrangler static asset routing", () => {
  // Tabs in wrangler.jsonc, spaces in the self-host template an operator copies.
  test.each([
    ["../wrangler.jsonc", /"assets"\s*:\s*\{(?<body>[\s\S]*?)\n\t\}/],
    ["../docs/examples/wrangler.self-host.jsonc", /"assets"\s*:\s*\{(?<body>[\s\S]*?)\n\t\}/],
  ])("%s runs the Worker before assets so legacy-domain redirects cover every path", (path, re) => {
    const config = readFileSync(new URL(path, import.meta.url), "utf8");
    const assetsBlock = config.match(re)?.groups?.body;

    expect(assetsBlock).toContain('"not_found_handling": "single-page-application"');
    expect(assetsBlock).toContain('"binding": "ASSETS"');
    // The deployed Worker owns every path; test/e2e/dev-server.mjs only names
    // the Worker-owned prefixes, and only because local development cannot put
    // the Worker in front of Vite's documents (see test/e2e/worker-routes.mjs).
    expect(assetsBlock).toContain('"run_worker_first": true');
  });

  test("routes both canonical host spellings to the Worker", () => {
    const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

    expect(config).toContain('"pattern": "drydock.org"');
    expect(config).toContain('"pattern": "www.drydock.org"');
  });
});

describe("Wrangler public egress routing", () => {
  test.each(["../wrangler.jsonc", "../docs/examples/wrangler.self-host.jsonc"])(
    "%s routes global fetch through the public Internet",
    (path) => {
      const config = readFileSync(new URL(path, import.meta.url), "utf8");
      const flagsBlock = config.match(/"compatibility_flags"\s*:\s*\[(?<body>[\s\S]*?)\]/)?.groups
        ?.body;

      expect(flagsBlock).toContain('"global_fetch_strictly_public"');
    },
  );
});

describe("Wrangler artifact bucket binding", () => {
  test.each([
    "../wrangler.jsonc",
    "../docs/examples/wrangler.self-host.jsonc",
    "../test/config/wrangler.jsonc",
    "../test/e2e/dev-server.mjs",
  ])("%s binds ARTIFACTS", (path) => {
    const config = readFileSync(new URL(path, import.meta.url), "utf8");

    expect(config).toMatch(/"ARTIFACTS"/);
  });
});
