#!/usr/bin/env node
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detonateDocker, detonateLocal, fixtureDir, listFixtures } from "../src/harness.mjs";

// CLI wrapper around the detonation harness. See README for the isolation
// model. This runs untrusted lifecycle scripts — only point it at a real
// package inside docker mode.
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();

  let packageDir = options.package;
  if (options.fixture) {
    const available = await listFixtures();
    if (!available.includes(options.fixture)) {
      fail(`unknown fixture "${options.fixture}". Available: ${available.join(", ")}`);
    }
    packageDir = fixtureDir(options.fixture);
  }
  if (!packageDir) fail("provide --package <dir> or --fixture <name> (try --help)");

  const report =
    options.mode === "docker"
      ? await detonateDocker({
          packageDir,
          outDir: options.outDir || (await mkdtemp(path.join(os.tmpdir(), "detonation-out-"))),
        })
      : await detonateLocal({ packageDir });

  const outPath = options.out || "detonation-report.json";
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  printSummary(report, outPath);
  // Non-zero exit for a bad verdict makes the harness usable as a CI gate.
  process.exit(report.verdict === "critical" || report.verdict === "high" ? 2 : 0);
}

function parseArgs(argv) {
  const options = { mode: "local" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--package":
        options.package = argv[++i];
        break;
      case "--fixture":
        options.fixture = argv[++i];
        break;
      case "--mode":
        options.mode = argv[++i];
        break;
      case "--out":
        options.out = argv[++i];
        break;
      case "--out-dir":
        options.outDir = argv[++i];
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const RISK_GLYPH = { critical: "✕", high: "✕", medium: "!", low: "·", clean: "✓" };

function printSummary(report, outPath) {
  const glyph = RISK_GLYPH[report.verdict] || "·";
  process.stdout.write(
    `\n${glyph} ${report.package.name}@${report.package.version} — verdict: ${report.verdict.toUpperCase()} ` +
      `(${report.behaviorCount} behavior${report.behaviorCount === 1 ? "" : "s"}, mode ${report.mode}, ${report.durationMs}ms)\n`,
  );
  for (const behavior of report.behaviors) {
    process.stdout.write(
      `  [${behavior.severity}] ${behavior.ruleId} — ${behavior.evidence}\n            ${behavior.reason}\n`,
    );
  }
  if (report.behaviors.length === 0) {
    process.stdout.write("  no runtime behaviors observed\n");
  }
  process.stdout.write(`\nreport written to ${outPath}\n`);
}

function printHelp() {
  process.stdout.write(
    `detonate — dynamic-analysis prototype for Drydock proposal #7\n\n` +
      `Usage:\n` +
      `  detonate --fixture <benign-suspicious|clean>\n` +
      `  detonate --package <dir> [--mode local|docker] [--out report.json]\n\n` +
      `Options:\n` +
      `  --package <dir>   extracted package directory (contains package.json)\n` +
      `  --fixture <name>  run a bundled fixture instead of --package\n` +
      `  --mode <mode>     local (default, best-effort) or docker (hardened container)\n` +
      `  --out <file>      report output path (default detonation-report.json)\n` +
      `  --out-dir <dir>   docker mode: host dir the container writes the report to\n\n` +
      `Local mode is a demo of the instrumentation, not a containment boundary.\n` +
      `Use docker mode for untrusted input. See README.md.\n`,
  );
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`detonation failed: ${err.stack || err.message}\n`);
  process.exit(1);
});
