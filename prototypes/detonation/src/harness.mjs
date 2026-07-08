import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { plantCanaries } from "./canaries.mjs";
import { buildReport } from "./report.mjs";
import { startSink } from "./sink.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD_PATH = path.join(HERE, "shims", "node-preload.cjs");
const LIFECYCLE_ORDER = ["preinstall", "install", "postinstall"];
const SCRIPT_TIMEOUT_MS = 20_000;

// CLI tools a payload shells out to for exfiltration. We shim them with inert
// loggers on PATH so a shell-based `curl http://evil ...` is observed and
// neutralized in local mode (the Node preload can't see non-Node subprocesses).
const SHIMMED_TOOLS = ["curl", "wget", "nc", "ncat"];

export function readPackageInfo(packageDir) {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const scripts = manifest.scripts || {};
  const lifecycle = LIFECYCLE_ORDER.filter((name) => typeof scripts[name] === "string");
  return {
    name: manifest.name || path.basename(packageDir),
    version: manifest.version || "0.0.0",
    lifecycleScripts: lifecycle.map((name) => ({ name, command: scripts[name] })),
  };
}

// Detonate a package's lifecycle scripts under best-effort local instrumentation.
// Isolation here is the Node preload + PATH shims + scrubbed env + loopback-only
// egress; it is a demo of the instrumentation, not a containment boundary (see
// README — use docker mode for untrusted input).
export async function detonateLocal({ packageDir }) {
  const packageInfo = readPackageInfo(packageDir);
  const root = await mkdtemp(path.join(os.tmpdir(), "detonation-"));
  const startedAt = Date.now();
  let sink = null;

  try {
    const workRoot = path.join(root, "work");
    const pkgDir = path.join(workRoot, "package");
    const homeDir = path.join(root, "home");
    const shimBin = path.join(root, "bin");
    const logPath = path.join(root, "events.jsonl");
    await mkdir(pkgDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await mkdir(shimBin, { recursive: true });
    await writeFile(logPath, "");
    await cp(packageDir, pkgDir, { recursive: true });

    const canaries = await plantCanaries(homeDir);
    // Start the sink knowing the canary tokens so it flags exfiltration bodies
    // it receives (the payload thinks it reached the internet; it reached us).
    sink = await startSink({ canaryTokens: canaries.tokens });
    await writeToolShims(shimBin, canaries.tokens, logPath);

    const env = buildEnv({
      shimBin,
      homeDir,
      workRoot,
      logPath,
      sinkOrigin: sink.origin,
      canaries,
    });

    for (const script of packageInfo.lifecycleScripts) {
      await runScript(script.command, pkgDir, env);
    }

    const events = await readEvents(logPath);
    return buildReport({
      packageInfo,
      mode: "local",
      durationMs: Date.now() - startedAt,
      events,
      sinkRequests: sink.requests,
    });
  } finally {
    if (sink) await sink.stop();
    await rm(root, { recursive: true, force: true });
  }
}

// Pure argv builder for the hardened container run, so the isolation flags are
// unit-testable without a Docker daemon present. The container needs no network
// (the sink runs on its loopback), a read-only rootfs, all caps dropped, and a
// non-root user — the real trust boundary this prototype points at.
export function buildDockerArgs({ packageDir, imageTag = "drydock-detonation", outDir }) {
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=256m",
    "--user",
    "1000:1000",
    "-v",
    `${path.resolve(packageDir)}:/pkg:ro`,
    "-v",
    `${path.resolve(outDir)}:/out:rw`,
    imageTag,
    "node",
    "bin/detonate.mjs",
    "--package",
    "/pkg",
    "--mode",
    "local",
    "--out",
    "/out/detonation-report.json",
  ];
}

export async function detonateDocker({ packageDir, outDir }) {
  await mkdir(outDir, { recursive: true });
  const args = buildDockerArgs({ packageDir, outDir });
  await new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.on("error", (err) =>
      reject(new Error(`docker mode requires a running Docker daemon: ${err.message}`)),
    );
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`docker run exited with code ${code}`)),
    );
  });
  return JSON.parse(await readFile(path.join(outDir, "detonation-report.json"), "utf8"));
}

function buildEnv({ shimBin, homeDir, workRoot, logPath, sinkOrigin, canaries }) {
  // Built from scratch (not spread from process.env) so the host's real
  // secrets are never handed to the detonated package.
  return {
    PATH: `${shimBin}:/usr/bin:/bin:/usr/local/bin`,
    HOME: homeDir,
    TMPDIR: os.tmpdir(),
    LANG: process.env.LANG || "en_US.UTF-8",
    NODE_OPTIONS: `--require ${PRELOAD_PATH}`,
    DETONATION_LOG: logPath,
    DETONATION_WORK_ROOT: workRoot,
    DETONATION_CANARY_PATHS: JSON.stringify(canaries.paths),
    DETONATION_CANARY_TOKENS: JSON.stringify(canaries.tokens),
    DETONATION_BLOCK_EGRESS: "1",
    // Steer proxy-aware and npm-aware clients at the sink.
    npm_config_registry: sinkOrigin,
    npm_config_userconfig: path.join(homeDir, ".npmrc"),
    http_proxy: sinkOrigin,
    https_proxy: sinkOrigin,
    HTTP_PROXY: sinkOrigin,
    HTTPS_PROXY: sinkOrigin,
  };
}

function runScript(command, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      env,
      timeout: SCRIPT_TIMEOUT_MS,
      stdio: "ignore",
    });
    // A failing or killed lifecycle script is expected (blocked egress makes
    // real payloads error); we still keep every observation recorded before it.
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

async function writeToolShims(shimBin, canaryTokens, logPath) {
  for (const tool of SHIMMED_TOOLS) {
    const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let tokens = [];
try { tokens = JSON.parse(process.env.DETONATION_CANARY_TOKENS || "[]"); } catch {}
const joined = args.join(" ");
const leaked = tokens.find((t) => t && joined.includes(t)) || null;
try {
  fs.appendFileSync(${JSON.stringify(logPath)},
    JSON.stringify({ type: "tool.invoked", tool: ${JSON.stringify(tool)}, args, leakedToken: leaked, pid: process.pid }) + "\\n");
} catch {}
process.exit(0);
`;
    const target = path.join(shimBin, tool);
    await writeFile(target, script, { mode: 0o755 });
  }
  void canaryTokens;
}

async function readEvents(logPath) {
  const raw = await readFile(logPath, "utf8");
  const events = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip a partial line from a killed process.
    }
  }
  return events;
}

// Resolve a bundled fixture directory by name.
export function fixtureDir(name) {
  return path.join(HERE, "..", "fixtures", name);
}

export async function listFixtures() {
  const dir = path.join(HERE, "..", "fixtures");
  return (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}
