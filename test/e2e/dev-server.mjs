import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const appPort = Number(process.env.E2E_APP_PORT || process.env.CONDUCTOR_PORT || 5173);
const registryPort = Number(process.env.E2E_REGISTRY_PORT || appPort + 1);
const appUrl = `http://127.0.0.1:${appPort}`;
const registryUrl = `http://127.0.0.1:${registryPort}`;
const stateDir = path.join(repoRoot, ".context/e2e-registry");
const artifactsDir = path.join(repoRoot, ".context/e2e-artifacts");
const configDir = path.join(repoRoot, ".context/e2e");
const outputStateDir = resolveOptionalRepoPath(process.env.E2E_REGISTRY_STATE_DIR) ?? stateDir;
const outputArtifactsDir = resolveOptionalRepoPath(process.env.E2E_ARTIFACTS_DIR) ?? artifactsDir;
const outputConfigDir = resolveOptionalRepoPath(process.env.E2E_CONFIG_DIR) ?? configDir;
const persistRoot = path.join(outputConfigDir, "state");
const wranglerConfigPath = path.join(outputConfigDir, "wrangler.jsonc");
const seedAfterStart = process.argv.includes("--seed") || process.env.E2E_SEED === "1";
let shuttingDown = false;

await mkdir(outputConfigDir, { recursive: true });
await mkdir(outputArtifactsDir, { recursive: true });
await rm(persistRoot, { recursive: true, force: true });
await mkdir(persistRoot, { recursive: true });
await writeWranglerConfig();
run("node", ["test/e2e/build-fixtures.mjs"]);
run("pnpm", [
  "exec",
  "wrangler",
  "d1",
  "migrations",
  "apply",
  "staged-publish-review-e2e",
  "--local",
  "--persist-to",
  persistRoot,
  "--config",
  wranglerConfigPath,
]);

const children = [];
const registry = start("node", ["test/e2e/fake-registry.mjs", "--port", String(registryPort)], {
  E2E_REGISTRY_STATE_DIR: outputStateDir,
});
children.push(registry);
await waitForUrl(`${registryUrl}/__health`);

const app = start(
  "pnpm",
  ["exec", "vite", "--host", "127.0.0.1", "--port", String(appPort), "--strictPort"],
  {
    ALLOW_INSECURE_LOCAL_REGISTRY: "true",
    CLOUDFLARE_VITE_PERSIST_STATE_PATH: persistRoot,
    CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: wranglerConfigPath,
    E2E_NPM_REGISTRY: registryUrl,
  },
);
children.push(app);
await waitForUrl(appUrl);

if (seedAfterStart) {
  // Seed one scanned fixture release through the same HTTP surface the browser
  // uses, so `pnpm run e2e:dev:seed` boots straight into realistic scan data.
  // Async (not spawnSync): the registry/app children pipe through this process,
  // so blocking the event loop while they log could deadlock on a full pipe.
  try {
    await runAsync("node", ["scripts/e2e-seed.mjs"], {
      E2E_APP_URL: appUrl,
      E2E_NPM_REGISTRY: registryUrl,
    });
  } catch (err) {
    // Don't orphan the registry/app children (and their ports) on seed failure.
    shuttingDown = true;
    for (const child of children.slice().reverse()) {
      if (!child.killed) child.kill("SIGTERM");
    }
    throw err;
  }
}

console.log(`E2E app: ${appUrl}`);
console.log(`Fake npm registry: ${registryUrl}`);
console.log(
  `Registry journal: ${path.relative(repoRoot, path.join(outputStateDir, "requests.jsonl"))}`,
);
console.log(`Artifacts: ${path.relative(repoRoot, outputArtifactsDir)}`);
console.log(`Worker state: ${path.relative(repoRoot, persistRoot)}`);

await new Promise((resolve, reject) => {
  for (const child of children) {
    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      reject(new Error(`${child.spawnargs.join(" ")} exited with ${code ?? signal}`));
    });
  }
  process.on("SIGTERM", () => shutdown(resolve));
  process.on("SIGINT", () => shutdown(resolve));
});

function shutdown(resolve) {
  shuttingDown = true;
  for (const child of children.slice().reverse()) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(resolve, 250);
}

function resolveOptionalRepoPath(value) {
  if (!value) return null;
  return path.resolve(repoRoot, value);
}

function configRelativePath(...segments) {
  return path.relative(outputConfigDir, path.join(repoRoot, ...segments));
}

async function writeWranglerConfig() {
  const config = {
    $schema: configRelativePath("node_modules/wrangler/config-schema.json"),
    name: "staged-publish-review-e2e",
    main: configRelativePath("server/index.ts"),
    compatibility_date: "2026-05-20",
    compatibility_flags: ["nodejs_compat"],
    assets: {
      not_found_handling: "single-page-application",
      run_worker_first: ["/api", "/api/*", "/webhooks/*"],
    },
    worker_loaders: [{ binding: "LOADER" }],
    d1_databases: [
      {
        binding: "DB",
        database_name: "staged-publish-review-e2e",
        database_id: "00000000-0000-0000-0000-0000000000e2",
        migrations_dir: configRelativePath("drizzle"),
      },
    ],
    kv_namespaces: [
      {
        binding: "COMPARE_CACHE",
        id: "000000000000000000000000000000e2",
      },
      {
        binding: "AUTH_SESSIONS",
        id: "000000000000000000000000000000e3",
      },
    ],
    // Mirrors the `ratelimits` tiers in wrangler.jsonc so the browser flows run
    // against the native limiter rather than the D1 fallback. Keep in sync with
    // NATIVE_TIERS in server/lib/platform/rate-limit.ts.
    ratelimits: [
      { name: "RATE_LIMIT_10_PER_MINUTE", namespace_id: "1001", simple: { limit: 10, period: 60 } },
      { name: "RATE_LIMIT_20_PER_MINUTE", namespace_id: "1002", simple: { limit: 20, period: 60 } },
      { name: "RATE_LIMIT_30_PER_MINUTE", namespace_id: "1003", simple: { limit: 30, period: 60 } },
      { name: "RATE_LIMIT_60_PER_MINUTE", namespace_id: "1004", simple: { limit: 60, period: 60 } },
      {
        name: "RATE_LIMIT_120_PER_MINUTE",
        namespace_id: "1005",
        simple: { limit: 120, period: 60 },
      },
      {
        name: "RATE_LIMIT_240_PER_MINUTE",
        namespace_id: "1006",
        simple: { limit: 240, period: 60 },
      },
    ],
    vars: {
      BETTER_AUTH_SECRET: "e2e-better-auth-secret-that-is-long-enough",
      BETTER_AUTH_URL: appUrl,
      NPM_CONNECTIONS_ENCRYPTION_KEY:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      NPM_REGISTRY: registryUrl,
      ALLOW_INSECURE_LOCAL_REGISTRY: "true",
      AI_CACHE_AFFINITY: "staged-publish-review-e2e",
    },
  };
  await writeFile(wranglerConfigPath, `${JSON.stringify(config, null, 2)}\n`);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, CI: process.env.CI ?? "true" },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

function runAsync(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`${command} ${args.join(" ")} failed with status ${code}`));
    });
  });
}

function start(command, args, env) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const label = path.basename(command);
  child.stdout.on("data", (chunk) => process.stdout.write(prefixLines(label, chunk)));
  child.stderr.on("data", (chunk) => process.stderr.write(prefixLines(label, chunk)));
  return child;
}

function prefixLines(label, chunk) {
  return chunk
    .toString()
    .split(/(?<=\n)/)
    .map((line) => (line ? `[${label}] ${line}` : ""))
    .join("");
}

async function waitForUrl(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function canConnect(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode && response.statusCode < 500);
    });
    request.on("error", () => resolve(false));
    request.setTimeout(1000, () => {
      request.destroy();
      resolve(false);
    });
  });
}
