import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const configSource = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const config = JSON.parse(configSource);

describe("Wrangler static asset routing", () => {
  test("runs the Worker before assets so legacy-domain redirects cover every path", () => {
    const assetsBlock = configSource.match(/"assets"\s*:\s*\{(?<body>[\s\S]*?)\n\t\}/)?.groups
      ?.body;

    expect(assetsBlock).toContain('"not_found_handling": "single-page-application"');
    expect(assetsBlock).toContain('"binding": "ASSETS"');
    expect(assetsBlock).toContain('"run_worker_first": true');
  });

  test("enables Workers Cache only for the public diff named entrypoint", () => {
    expect(config.cache).toBeUndefined();
    expect(config.exports).toEqual({
      PublicDiffReads: {
        type: "worker",
        cache: { enabled: true },
      },
    });
  });
});
