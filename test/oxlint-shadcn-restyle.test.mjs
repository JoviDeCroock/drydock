import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

// Drive @shadcn/lint through the real oxlint runtime, as the design-local and
// signals-local fixture tests do. This suite exists for two reasons: to pin the
// component-recognition patterns (a page-relative import and a sibling import
// both have to resolve), and because oxlint exits 0 when a JS plugin fails to
// load — a missing or renamed plugin would otherwise turn `pnpm run lint` into a
// silent pass with every design-system rule switched off.

const fixtureDir = fileURLToPath(new URL("./fixtures/oxlint-shadcn/", import.meta.url));
const oxlintBin = fileURLToPath(new URL("../node_modules/.bin/oxlint", import.meta.url));
const repoConfig = fileURLToPath(new URL("../.oxlintrc.json", import.meta.url));

function run(cwd, args) {
  try {
    return execFileSync(oxlintBin, args, { cwd, encoding: "utf8" });
  } catch (err) {
    // oxlint exits non-zero when it reports errors; the JSON is on stdout.
    return err.stdout?.toString() ?? "";
  }
}

function diagnostics() {
  const output = run(fixtureDir, ["-c", "oxlintrc.json", "--format=json", "src"]);
  let report;
  try {
    report = JSON.parse(output);
  } catch {
    // oxlint writes the plugin-load failure to stderr and still exits 0, so a
    // non-JSON stdout here means the rules never ran.
    assert.fail(`oxlint produced no JSON report; @shadcn/lint likely failed to load:\n${output}`);
  }
  return (report.diagnostics ?? [])
    .filter((d) => d.code === "shadcn(no-restyle)")
    .map((d) => ({
      filename: d.filename?.replaceAll("\\", "/"),
      line: d.labels?.[0]?.span?.line,
      message: d.help ?? d.message ?? "",
    }));
}

describe("shadcn/no-restyle", () => {
  it("reports a caller-side padding collision through a page-relative import", () => {
    const flagged = diagnostics();
    const hit = flagged.find((d) => d.filename === "src/page.tsx" && d.line === 6);
    assert.ok(hit, `expected a finding on src/page.tsx:6, got ${JSON.stringify(flagged)}`);
    assert.match(hit.message, /p-5/);
  });

  it("reports the same collision through a sibling import inside components/", () => {
    const flagged = diagnostics();
    const hit = flagged.find((d) => d.filename === "src/components/Wrapper.tsx");
    assert.ok(
      hit,
      `expected a finding on src/components/Wrapper.tsx, got ${JSON.stringify(flagged)}`,
    );
    assert.match(hit.message, /p-5/);
  });

  it("leaves placement and the contract's gap allowance alone", () => {
    const flagged = diagnostics();
    assert.equal(flagged.filter((d) => d.filename === "src/page.tsx" && d.line === 7).length, 0);
  });
});

describe("the repository oxlint config", () => {
  it("loads its JS plugins, which oxlint would otherwise skip with exit 0", () => {
    const output = run(fixtureDir, ["-c", repoConfig, "--format=json", "src"]);
    assert.doesNotMatch(
      output,
      /Failed to (parse oxlint configuration|load JS plugin)/,
      "the repo config did not load its JS plugins; `pnpm run lint` is passing vacuously",
    );
  });
});
