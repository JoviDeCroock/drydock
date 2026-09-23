import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "vitest";

// Same end-to-end shape as oxlint-cross-page-import.test.mjs: run the real
// oxlint runtime over a fixture tree so the check covers the plugin wiring,
// not a mocked rule context.

const fixtureDir = fileURLToPath(new URL("./fixtures/oxlint-boundaries/", import.meta.url));
const oxlintBin = fileURLToPath(new URL("../node_modules/.bin/oxlint", import.meta.url));

const RULE_CODE = "boundaries-local(no-platform-domain-import)";

function runRule() {
  let stdout;
  try {
    stdout = execFileSync(oxlintBin, ["-c", "oxlintrc.json", "--format=json", "server"], {
      cwd: fixtureDir,
      encoding: "utf8",
    });
  } catch (err) {
    stdout = err.stdout?.toString() ?? "";
  }
  const report = JSON.parse(stdout);
  return (report.diagnostics ?? [])
    .filter((d) => d.code === RULE_CODE)
    .map((d) => ({
      filename: d.filename?.replaceAll("\\", "/"),
      line: d.labels?.[0]?.span?.line,
    }));
}

describe("boundaries-local/no-platform-domain-import", () => {
  const flagged = runRule();

  it("flags every import form that leaves server/lib/platform/, including type-only", () => {
    // leaky.ts: value import, type import, named re-export, star re-export,
    // literal dynamic import. The ./shape import on line 1 stays clean.
    const lines = flagged
      .filter((d) => d.filename === "server/lib/platform/leaky.ts")
      .map((d) => d.line)
      .sort((a, b) => a - b);
    assert.deepEqual(lines, [2, 3, 4, 5, 6], JSON.stringify(flagged, null, 2));
  });

  it("does not constrain domain modules importing platform or db", () => {
    const other = flagged.filter((d) => d.filename !== "server/lib/platform/leaky.ts");
    assert.deepEqual(other, [], JSON.stringify(other, null, 2));
  });
});
