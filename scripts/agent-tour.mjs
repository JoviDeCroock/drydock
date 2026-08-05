import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const tourDir = path.resolve(repoRoot, process.env.AGENT_TOUR_DIR || "agent-tour-output");
const args = process.argv.slice(2);
const passThrough = [];
let clean = true;

for (const arg of args) {
  if (arg === "--no-clean") {
    clean = false;
  } else {
    passThrough.push(arg);
  }
}

if (clean) {
  await rm(tourDir, { recursive: true, force: true });
}
await mkdir(tourDir, { recursive: true });

const command = "pnpm";
const commandArgs = [
  "exec",
  "playwright",
  "test",
  "--config",
  "test/agent-tour/playwright.config.ts",
  ...passThrough,
];
const childEnv = {
  ...process.env,
  AGENT_TOUR_DIR: tourDir,
  E2E_ARTIFACTS_DIR: process.env.E2E_ARTIFACTS_DIR || path.join(tourDir, "e2e-artifacts"),
  E2E_CONFIG_DIR: process.env.E2E_CONFIG_DIR || path.join(tourDir, "e2e-config"),
  E2E_REGISTRY_STATE_DIR:
    process.env.E2E_REGISTRY_STATE_DIR || path.join(tourDir, "registry-state"),
};
const relativeTourDir = path.relative(repoRoot, tourDir) || ".";

console.log(`Running Drydock agent tour: ${command} ${commandArgs.join(" ")}`);
console.log(`Output directory: ${relativeTourDir}`);

const child = spawn(command, commandArgs, {
  cwd: repoRoot,
  env: childEnv,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  console.log("");
  console.log("Agent tour artifacts:");
  console.log(`  report: ${path.join(relativeTourDir, "report.md")}`);
  console.log(`  screenshots: ${path.join(relativeTourDir, "screenshots")}/`);
  console.log(`  Playwright report: ${path.join(relativeTourDir, "playwright-report")}/`);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
