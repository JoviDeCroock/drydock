import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "vitest";

// Drive the local oxlint plugin through the real oxlint runtime against a
// fixture tree, so the test exercises the same path production lint does. JS
// plugins are alpha, so an end-to-end check is more trustworthy than a mocked
// context — and this rule additionally depends on real filenames and a real
// filesystem (to tell a pages-root file from a page directory).

const fixtureDir = fileURLToPath(new URL("./fixtures/oxlint-boundaries/", import.meta.url));
const oxlintBin = fileURLToPath(new URL("../node_modules/.bin/oxlint", import.meta.url));

const RULE_CODE = "boundaries-local(no-cross-page-import)";

function runRule() {
  let stdout;
  try {
    stdout = execFileSync(oxlintBin, ["-c", "oxlintrc.json", "--format=json", "src"], {
      cwd: fixtureDir,
      encoding: "utf8",
    });
  } catch (err) {
    // oxlint exits non-zero when it reports errors; the JSON is on stdout.
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

describe("boundaries-local/no-cross-page-import", () => {
  const flagged = runRule();

  it("flags every import form that reaches into another page's directory", () => {
    // Five positive cases in Alpha/index.ts: static import, bare page-directory
    // import, named re-export, star re-export, and a literal dynamic import().
    const lines = flagged
      .filter((d) => d.filename === "src/pages/Alpha/index.ts")
      .map((d) => d.line)
      .sort((a, b) => a - b);
    assert.deepEqual(
      lines,
      [3, 4, 5, 6, 7],
      `expected the five Beta imports to be flagged, got:\n${JSON.stringify(flagged, null, 2)}`,
    );
  });

  it("leaves same-page, pages-root, feature, and router imports alone", () => {
    // Everything flagged must be the Alpha→Beta reach; the router importing
    // pages, Alpha importing its own files, ../SharedRoot (a pages-root file,
    // not a page directory), and ../../features/shared all stay clean.
    const other = flagged.filter((d) => d.filename !== "src/pages/Alpha/index.ts");
    assert.deepEqual(other, [], `unexpected violations:\n${JSON.stringify(other, null, 2)}`);
    assert.equal(flagged.length, 5);
  });
});
