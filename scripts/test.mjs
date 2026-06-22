import { spawn } from "node:child_process";

const forwardedArgs = process.argv.slice(2);
const extraArgs = forwardedArgs[0] === "--" ? forwardedArgs.slice(1) : forwardedArgs;
const workerShards = 4;
const checks =
  extraArgs.length > 0
    ? [{ name: "vitest", args: ["exec", "vitest", "run", ...extraArgs] }]
    : [
        { name: "node", args: ["exec", "vitest", "run", "--project", "node"] },
        ...Array.from({ length: workerShards }, (_, index) => ({
          name: `workers ${index + 1}/${workerShards}`,
          args: [
            "exec",
            "vitest",
            "run",
            "--project",
            "workers",
            `--shard=${index + 1}/${workerShards}`,
          ],
        })),
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

function vitestSummary(output) {
  return output
    .split("\n")
    .filter((line) => /^\s*(Test Files|Tests|Duration)\b/.test(line))
    .join("\n");
}

const pending = new Set(checks.map((check) => check.name));
process.stdout.write(
  `test: running ${checks.length} Vitest jobs in parallel (${[...pending].join(", ")})\n`,
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

for (const result of results) {
  const summary = vitestSummary(result.output);
  if (summary) {
    process.stdout.write(`\n──── ${result.name} summary ────\n${summary}\n`);
  }
}

const failures = results.filter((result) => result.code !== 0);
for (const failure of failures) {
  process.stdout.write(`\n──── ${failure.name} output ────\n${failure.output}\n`);
}

if (failures.length > 0) {
  process.stdout.write(`\ntest failed: ${failures.map((failure) => failure.name).join(", ")}\n`);
  process.exit(1);
}
