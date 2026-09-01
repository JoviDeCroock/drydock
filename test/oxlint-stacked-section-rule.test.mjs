import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "vitest";

// Drive the local oxlint plugin through the real oxlint runtime against a
// fixture tree, so the test exercises the same path production lint does — the
// same approach as test/oxlint-cross-page-import.test.mjs. JS plugins are
// alpha, so an end-to-end check is more trustworthy than a mocked context.

const fixtureDir = fileURLToPath(new URL("./fixtures/oxlint-design/", import.meta.url));
const oxlintBin = fileURLToPath(new URL("../node_modules/.bin/oxlint", import.meta.url));

const RULE_CODE = "design-local(no-stacked-section-rule)";

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
      message: d.help ?? d.message ?? "",
    }));
}

describe("design-local/no-stacked-section-rule", () => {
  const flagged = runRule();

  it("flags every boundary that stacks a rule on a SectionLabel", () => {
    const lines = flagged
      .filter((d) => d.filename === "src/stacked.tsx")
      .map((d) => d.line)
      .sort((a, b) => a - b);
    // The label's own class (8), the same via cn() (16), border-y (24), an
    // arbitrary width (32), the wrapper's border-b (40), a trailing <hr> (50),
    // a trailing border-t sibling (59), a leading border-b sibling (67), the
    // same <hr> across a JSX comment (78), a leading wrapper's border-t (85),
    // a trailing wrapper's border-b (94), a border-t after a trailing wrapper
    // (107), a border-b before a leading wrapper (115), a conditional trailing
    // border-t (127), a conditional preceding rule (135), a rule after an
    // optional child (146), the nullable equivalent (156), and a wrapper rule
    // that touches the label whenever its optional leading child is absent
    // (163).
    assert.deepEqual(
      lines,
      [8, 16, 24, 32, 40, 50, 59, 67, 78, 85, 94, 107, 115, 127, 135, 146, 156, 163],
      `expected the eighteen stacked rules to be flagged, got:\n${JSON.stringify(flagged, null, 2)}`,
    );
  });

  it("separates a border-b stacked on the label's own rule from a border-t boxing it", () => {
    const messageAt = (line) => flagged.find((d) => d.line === line)?.message ?? "";

    // Line 8 is `border-b` — the same edge the label's trailing rule draws on.
    assert.match(messageAt(8), /stacks a second hairline/);
    // Line 16 is `border-t` only, which lands on the leading edge instead. The
    // rule still forbids it, but must not claim the hairlines are stacked.
    assert.match(messageAt(16), /leading edge and boxes it/);
    assert.doesNotMatch(messageAt(16), /stacks a second hairline/);
    // Line 24 is `border-y`, so the stacked edge wins.
    assert.match(messageAt(24), /stacks a second hairline/);
  });

  it("leaves boxes, spacing, distant rules, and mid-stack labels alone", () => {
    const other = flagged.filter((d) => d.filename !== "src/stacked.tsx");
    assert.deepEqual(other, [], `unexpected violations:\n${JSON.stringify(other, null, 2)}`);
    assert.equal(flagged.length, 18);
  });
});
