import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "vitest";

// Drive the local oxlint plugin through the real oxlint runtime against a
// fixture, so the test exercises the same path production lint does. JS plugins
// are alpha, so an end-to-end check is more trustworthy than a mocked context.

const fixtureDir = fileURLToPath(new URL("./fixtures/oxlint-signals/", import.meta.url));
const fixtureFile = "conditional-jsx.tsx";
const oxlintBin = fileURLToPath(new URL("../node_modules/.bin/oxlint", import.meta.url));

const RULE_CODE = "signals-local(no-signal-conditional-jsx)";

function runRule() {
  let stdout;
  try {
    stdout = execFileSync(oxlintBin, ["-c", "oxlintrc.json", "--format=json", fixtureFile], {
      cwd: fixtureDir,
      encoding: "utf8",
    });
  } catch (err) {
    // oxlint exits non-zero when it reports errors; the JSON is on stdout.
    stdout = err.stdout?.toString() ?? "";
  }
  const report = JSON.parse(stdout);
  // oxlint span offsets/lengths are UTF-8 byte offsets, so slice the raw bytes
  // (not a JS UTF-16 string) — otherwise multibyte chars like "…" misalign.
  const source = readFileSync(join(fixtureDir, fixtureFile));
  return (report.diagnostics ?? [])
    .filter((d) => d.code === RULE_CODE)
    .map((d) => {
      const span = d.labels?.[0]?.span;
      return span ? source.subarray(span.offset, span.offset + span.length).toString("utf8") : "";
    });
}

describe("signals-local/no-signal-conditional-jsx", () => {
  const flagged = runRule();

  it("flags exactly the signal-driven conditional-render cases", () => {
    // Eight positive cases: ternary→null, ternary→both-JSX, logical &&, derived
    // negation, derived comparison, computed-driven, a destructured `Signal<T>`
    // prop, and a conditional *text* ternary.
    assert.equal(
      flagged.length,
      8,
      `expected 8 violations, got ${flagged.length}:\n${flagged.join("\n")}`,
    );
  });

  it("flags direct and derived signal conditions, element and text branches", () => {
    const joined = flagged.join("\n");
    for (const needle of [
      "error.value ?",
      "authed.value ?",
      "open.value &&",
      "!loading.value ?",
      "items.value.length > 0 &&",
      "hasItems.value ?",
      "flag.value ?",
      'loading.value ? "Saving', // conditional text
    ]) {
      assert.ok(joined.includes(needle), `expected a violation containing \`${needle}\``);
    }
  });

  it("does not flag non-signal tests, value selection, or attribute positions", () => {
    const joined = flagged.join("\n");
    // Plain boolean condition, a non-reactive test that merely selects a signal
    // value, an attribute-position ternary, and a directly-rendered signal must
    // all stay clean.
    assert.ok(!joined.includes("folder ?"), "plain boolean condition should not be flagged");
    assert.ok(!joined.includes("useError ?"), "non-reactive test should not be flagged");
    assert.ok(!joined.includes("disabled="), "attribute-position ternary should not be flagged");
  });
});
