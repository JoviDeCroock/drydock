// Regenerate the no-signal-conditional-jsx baseline (suppressions.json) from the
// current tree. Runs oxlint with the rule's baseline bypassed (SIGNALS_NO_SUPPRESS=1)
// so it reports every infraction, then records each by repo-relative path →
// 1-based line. Run from the repo root:
//   node tooling/oxlint/signals-local/regenerate-suppressions.mjs
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RULE_CODE = "signals-local(no-signal-conditional-jsx)";
const oxlintBin = fileURLToPath(new URL("../../../node_modules/.bin/oxlint", import.meta.url));
const oxfmtBin = fileURLToPath(new URL("../../../node_modules/.bin/oxfmt", import.meta.url));
const outPath = fileURLToPath(new URL("./suppressions.json", import.meta.url));

let stdout;
try {
  stdout = execFileSync(oxlintBin, ["--format=json"], {
    encoding: "utf8",
    env: { ...process.env, SIGNALS_NO_SUPPRESS: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (err) {
  // oxlint exits non-zero whenever it reports errors; the JSON is still on stdout.
  stdout = err.stdout?.toString() ?? "";
}

const { diagnostics = [] } = JSON.parse(stdout);
const byFile = {};
for (const d of diagnostics) {
  if (d.code !== RULE_CODE) continue;
  const line = d.labels?.[0]?.span?.line;
  if (line == null) continue;
  (byFile[d.filename] ??= new Set()).add(line);
}

const baseline = {};
for (const file of Object.keys(byFile).sort()) {
  baseline[file] = [...byFile[file]].sort((a, b) => a - b);
}

writeFileSync(outPath, `${JSON.stringify(baseline, null, 2)}\n`);
// Match the repo's formatter so a regenerated baseline stays format-check clean.
execFileSync(oxfmtBin, [outPath], { stdio: "ignore" });
const total = Object.values(baseline).reduce((n, lines) => n + lines.length, 0);
console.log(
  `Wrote ${Object.keys(baseline).length} file(s) / ${total} infraction(s) to suppressions.json`,
);
