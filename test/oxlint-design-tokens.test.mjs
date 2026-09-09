import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

// Drive the design-local plugin through the real oxlint runtime against the
// fixture tree, as test/oxlint-stacked-section-rule.test.mjs does. JS plugins
// are alpha, so an end-to-end check is more trustworthy than a mocked context.

const fixtureDir = fileURLToPath(new URL("./fixtures/oxlint-design/", import.meta.url));
const oxlintBin = fileURLToPath(new URL("../node_modules/.bin/oxlint", import.meta.url));

function runRule(ruleCode) {
  let stdout;
  try {
    stdout = execFileSync(oxlintBin, ["-c", "oxlintrc.json", "--format=json", "src", "server"], {
      cwd: fixtureDir,
      encoding: "utf8",
    });
  } catch (err) {
    // oxlint exits non-zero when it reports errors; the JSON is on stdout.
    stdout = err.stdout?.toString() ?? "";
  }
  const report = JSON.parse(stdout);
  return (report.diagnostics ?? [])
    .filter((d) => d.code === ruleCode)
    .map((d) => ({
      filename: d.filename?.replaceAll("\\", "/"),
      line: d.labels?.[0]?.span?.line,
      message: d.help ?? d.message ?? "",
    }));
}

describe("design-local/no-off-system-color", () => {
  const flagged = runRule("design-local(no-off-system-color)");
  const inFixture = flagged.filter((d) => d.filename === "src/off-system-color.tsx");

  it("flags palette colors, raw colors, and saturated severity text", () => {
    const lines = inFixture.map((d) => d.line).sort((a, b) => a - b);
    // Palette text (6), two palette utilities behind variants (10, 10), an
    // arbitrary hex (14), an arbitrary rgba (18), a hex in a style prop (22),
    // an rgb() in a style prop (26), two colors embedded in longer style values
    // (30, 30), a gradient in a style map (34), text-warn (39), text-ok inside
    // a class map (43), text-info/80 inside cn() (48), and a palette color in a
    // template literal (52).
    assert.deepEqual(
      lines,
      [6, 10, 10, 14, 18, 22, 26, 30, 30, 34, 39, 43, 48, 52],
      `expected fourteen off-system colors, got:\n${JSON.stringify(flagged, null, 2)}`,
    );
  });

  it("names the token and points at the -text variant for saturated severity text", () => {
    const messageAt = (line) => inFixture.find((d) => d.line === line)?.message ?? "";
    assert.match(messageAt(6), /`text-red-600` is a Tailwind default-palette color/);
    assert.match(messageAt(14), /`bg-\[#fafafa\]` carries a raw color/);
    assert.match(messageAt(22), /Raw CSS color `#e4e4e7`/);
    assert.match(messageAt(30), /Raw CSS color `0 0 0 1px #e4e4e7`/);
    assert.match(messageAt(39), /Use `text-warn-text` for text/);
    assert.match(messageAt(48), /Use `text-info-text` for text/);
  });

  it("leaves tokens, shapes, var() values, white/black, prose, and non-src files alone", () => {
    const other = flagged.filter((d) => d.filename !== "src/off-system-color.tsx");
    assert.deepEqual(other, [], `unexpected violations:\n${JSON.stringify(other, null, 2)}`);
  });
});

describe("design-local/no-sub-floor-text", () => {
  const flagged = runRule("design-local(no-sub-floor-text)");

  it("flags arbitrary text sizes below 10px in px and rem, behind variants, and in maps", () => {
    const lines = flagged
      .filter((d) => d.filename === "src/sub-floor-text.tsx")
      .map((d) => d.line)
      .sort((a, b) => a - b);
    // px (5), rem (9), behind a variant (13), in a class map (17), with a
    // line-height shorthand (22), a length hint (26), and as an arbitrary
    // property (30).
    assert.deepEqual(
      lines,
      [5, 9, 13, 17, 22, 26, 30],
      `got:\n${JSON.stringify(flagged, null, 2)}`,
    );
    assert.match(flagged.find((d) => d.line === 9)?.message ?? "", /`text-\[0\.5rem\]`/);
  });

  it("allows 10px and up, including the named sizes, and ignores non-src files", () => {
    const other = flagged.filter((d) => d.filename !== "src/sub-floor-text.tsx");
    assert.deepEqual(other, [], `unexpected violations:\n${JSON.stringify(other, null, 2)}`);
  });
});
