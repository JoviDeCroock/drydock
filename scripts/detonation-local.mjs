// Local runner for the detonation container: builds the image, installs one
// tarball with network access, then cuts the container off the network and
// detonates it with fake canaries. Approximates the Worker flow, where the
// parent sinkholes egress during detonation.
//
// Usage: node scripts/detonation-local.mjs <path-to.tgz> [--cap-add-ptrace | --no-ptrace]
//
// `--no-ptrace` blocks ptrace with a seccomp profile to exercise the harness's
// runtime-hooks-only fallback.
//
// This runs the tarball's code inside Docker. Only point it at packages you are
// willing to execute in a container on this machine.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const image = "drydock-detonation:dev";
const args = process.argv.slice(2);
const capAddPtrace = args.includes("--cap-add-ptrace");
const noPtrace = args.includes("--no-ptrace");
const tarballPath = args.find((arg) => !arg.startsWith("--"));

if (!tarballPath) {
  process.stderr.write(
    "usage: node scripts/detonation-local.mjs <path-to.tgz> [--cap-add-ptrace | --no-ptrace]\n",
  );
  process.exit(2);
}

// Obviously fake values: they exist only so the report can show them being read.
const FAKE_NPM_TOKEN = "npm_DRYDOCKFAKECANARY0000000000000000000";
const FAKE_GITHUB_TOKEN = "ghp_DRYDOCKFAKECANARY000000000000000000000";
const detonateRequest = {
  version: 1,
  canaryEnv: {
    NPM_TOKEN: FAKE_NPM_TOKEN,
    GITHUB_TOKEN: FAKE_GITHUB_TOKEN,
    CI: "true",
    GITHUB_ACTIONS: "true",
  },
  canaryFiles: [
    {
      path: "/home/pkg/.npmrc",
      content: `//registry.npmjs.org/:_authToken=${FAKE_NPM_TOKEN}\n`,
      mode: 0o600,
    },
    {
      path: "/home/pkg/.aws/credentials",
      content:
        "[default]\naws_access_key_id = AKIADRYDOCKFAKECANARY\naws_secret_access_key = drydock-fake-canary-secret\n",
      mode: 0o600,
    },
  ],
  stepTimeoutMs: 30_000,
  totalTimeoutMs: 180_000,
};

function docker(...dockerArgs) {
  return execFileSync("docker", dockerArgs, { encoding: "utf8" }).trim();
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("harness did not become healthy within 30s");
}

async function main() {
  const tarball = readFileSync(tarballPath);
  const build = spawnSync(
    "docker",
    ["build", "-t", image, path.join(repoRoot, "containers/detonation")],
    {
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  if (build.status !== 0) throw new Error("docker build failed");

  const runArgs = ["run", "-d", "--network", "bridge", "-p", "127.0.0.1::8080"];
  if (capAddPtrace) runArgs.push("--cap-add", "SYS_PTRACE");
  if (noPtrace) {
    const profile = path.join(
      mkdtempSync(path.join(os.tmpdir(), "drydock-seccomp-")),
      "no-ptrace.json",
    );
    writeFileSync(
      profile,
      JSON.stringify({
        defaultAction: "SCMP_ACT_ALLOW",
        syscalls: [{ names: ["ptrace"], action: "SCMP_ACT_ERRNO" }],
      }),
    );
    runArgs.push("--security-opt", `seccomp=${profile}`);
  }
  const container = docker(...runArgs, image);
  try {
    const hostPort = docker("port", container, "8080/tcp").split("\n")[0].split(":").pop();
    const baseUrl = `http://127.0.0.1:${hostPort}`;
    await waitForHealth(baseUrl);

    const prepareResponse = await fetch(`${baseUrl}/prepare`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: tarball,
    });
    const prepared = await prepareResponse.json();
    process.stderr.write(`prepare: ${prepareResponse.status} ${JSON.stringify(prepared)}\n`);
    if (!prepareResponse.ok) throw new Error("prepare failed");

    // Disconnecting also unpublishes the port, so the harness is reached on the
    // container's address via `docker exec` instead of the host port.
    docker("network", "disconnect", "bridge", container);
    const detonate = spawnSync(
      "docker",
      [
        "exec",
        "-i",
        container,
        "node",
        "-e",
        `const body=require("fs").readFileSync(0);fetch("http://127.0.0.1:8080/detonate",{method:"POST",headers:{"content-type":"application/json"},body}).then(async r=>{process.stdout.write(await r.text());process.exitCode=r.ok?0:1}).catch(e=>{console.error(String(e));process.exitCode=1})`,
      ],
      { input: JSON.stringify(detonateRequest), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (detonate.status !== 0) {
      throw new Error(`detonate failed: ${detonate.stderr || detonate.stdout}`);
    }
    process.stdout.write(`${JSON.stringify(JSON.parse(detonate.stdout), null, 2)}\n`);
  } finally {
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
