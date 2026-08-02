// Runs the verify gate (lint + format check + typecheck + tests) with the four
// checks in parallel instead of in series. The Cloudflare-worker test pool
// dominates wall time, so the cheap checks finish while it is still running.
// All checks always run to completion so a single pass surfaces every failure;
// output for each check is buffered and printed grouped, never interleaved.
import { spawn } from "node:child_process";

const checks = [
  { name: "lint", args: ["run", "lint"] },
  { name: "format:check", args: ["run", "format:check"] },
  { name: "typecheck", args: ["run", "typecheck"] },
  { name: "test", args: ["run", "test"] },
];

function runCheck(check) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn("pnpm", check.args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => {
      resolve({ name: check.name, code: code ?? 1, output, seconds: (Date.now() - start) / 1000 });
    });
  });
}

const pending = new Set(checks.map((c) => c.name));
process.stdout.write(
  `verify: running ${checks.length} checks in parallel (${[...pending].join(", ")})\n`,
);

const results = await Promise.all(
  checks.map(async (check) => {
    const result = await runCheck(check);
    pending.delete(check.name);
    const status = result.code === 0 ? "PASS" : "FAIL";
    const waiting = pending.size > 0 ? `  still running: ${[...pending].join(", ")}` : "";
    process.stdout.write(`  ${status} ${result.name} (${result.seconds.toFixed(1)}s)${waiting}\n`);
    return result;
  }),
);

const failures = results.filter((result) => result.code !== 0);
for (const failure of failures) {
  process.stdout.write(`\n──── ${failure.name} output ────\n${failure.output}\n`);
}

if (failures.length > 0) {
  process.stdout.write(`\nverify failed: ${failures.map((f) => f.name).join(", ")}\n`);
  // See scripts/test.mjs: process.exit() truncates buffered stdout on a pipe.
  process.exitCode = 1;
}
