#!/usr/bin/env node
// Seeds a running local e2e dev server (`pnpm run e2e:dev`) with realistic scan
// data — no credentials or network access beyond localhost. It drives the same
// HTTP surface the browser uses: sign up a throwaway account, connect the fake
// npm staging registry, and run one fixture stage through a full scan.
//
// Usage:
//   pnpm run e2e:dev            # in one terminal
//   pnpm run e2e:seed           # in another; prints login + scan URL
//   pnpm run e2e:dev:seed       # one command: server up + seeded scan
//
// Extra stage ids can be passed as arguments (see test/e2e-fixtures/scenarios/
// for the available fixtures): pnpm run e2e:seed -- stage-benign-diff-000001

const appPort = Number(process.env.E2E_APP_PORT || process.env.CONDUCTOR_PORT || 5173);
const appUrl = (process.env.E2E_APP_URL || `http://127.0.0.1:${appPort}`).replace(/\/+$/, "");
const registryPort = Number(process.env.E2E_REGISTRY_PORT || appPort + 1);
const registryUrl = process.env.E2E_NPM_REGISTRY || `http://127.0.0.1:${registryPort}`;
const defaultStageId = "stage-implicit-node-gyp-000001";
const stageIds = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
if (stageIds.length === 0) stageIds.push(defaultStageId);

const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const email = `seed-${unique}@example.test`;
const password = "correct horse battery staple";

await waitForApp();
const cookie = await signUp();
await connectRegistry(cookie);

const results = [];
for (const stageId of stageIds) {
  results.push(await runScan(cookie, stageId));
}

console.log("");
console.log("Seeded local Drydock data (fixtures only, no real credentials):");
console.log(`  app:      ${appUrl}`);
console.log(`  login:    ${email}`);
console.log(`  password: ${password}`);
for (const result of results) {
  console.log(
    `  scan:     ${appUrl}/dashboard/scans/${result.scanId} (${result.stageId} → ${result.status})`,
  );
}
console.log("");
console.log("Sign in at " + appUrl + "/login with the credentials above.");

const failed = results.filter((result) => result.status !== "complete");
if (failed.length > 0) {
  console.error(
    `seed: ${failed.length} scan(s) did not complete: ${failed.map((f) => f.stageId).join(", ")}`,
  );
  process.exit(1);
}

async function waitForApp(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(appUrl, { signal: AbortSignal.timeout(2_000) });
      if (response.status < 500) return;
    } catch {
      // keep polling
    }
    if (Date.now() > deadline) {
      throw new Error(
        `seed: no app responding at ${appUrl} — start it first with \`pnpm run e2e:dev\` (or use \`pnpm run e2e:dev:seed\`)`,
      );
    }
    await sleep(500);
  }
}

async function signUp() {
  const response = await fetch(`${appUrl}/api/auth/sign-up/email`, {
    method: "POST",
    // The Worker's CSRF middleware requires a matching Origin on state-changing
    // /api/* requests (see server/index.ts).
    headers: { "content-type": "application/json", origin: appUrl },
    body: JSON.stringify({ name: "Seeded Reviewer", email, password }),
  });
  if (!response.ok) {
    throw new Error(`seed: sign-up failed: ${response.status} ${await response.text()}`);
  }
  const cookie = cookieHeader(response);
  if (!cookie) throw new Error("seed: sign-up returned no session cookie");
  return cookie;
}

async function connectRegistry(cookie) {
  const save = await api(cookie, "POST", "/api/v1/npm-connection", {
    label: "Fake npm staging registry",
    registryUrl,
    token: "npm_e2e_token_0123456789",
  });
  if (!save.ok) {
    throw new Error(
      `seed: npm connection save failed (${save.status}) — is the fake registry up at ${registryUrl}? ${save.text}`,
    );
  }
  const validate = await api(cookie, "POST", "/api/v1/npm-connection/validate", {
    stageId: "stage-benign-diff-000001",
  });
  if (!validate.ok || !validate.body?.validation?.ok) {
    throw new Error(
      `seed: npm connection validation failed (${validate.status}): ${validate.text}`,
    );
  }
}

async function runScan(cookie, stageId) {
  const created = await api(cookie, "POST", "/api/v1/scans", { stageId });
  if (created.status !== 202 || !created.body?.scan?.id) {
    throw new Error(`seed: scan create for ${stageId} failed (${created.status}): ${created.text}`);
  }
  const scanId = String(created.body.scan.id);
  const deadline = Date.now() + 120_000;
  for (;;) {
    const detail = await api(cookie, "GET", `/api/v1/scans/${encodeURIComponent(scanId)}?poll=1`);
    const status = detail.body?.scan?.status;
    if (status === "complete" || status === "failed") return { stageId, scanId, status };
    if (Date.now() > deadline) return { stageId, scanId, status: status ?? "unknown" };
    await sleep(1_000);
  }
}

async function api(cookie, method, pathname, body) {
  const response = await fetch(`${appUrl}${pathname}`, {
    method,
    headers: {
      cookie,
      origin: appUrl,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // non-JSON response body; keep raw text for error reporting
  }
  return { ok: response.ok, status: response.status, body: parsed, text };
}

function cookieHeader(response) {
  const cookies = response.headers.getSetCookie?.() ?? [];
  return cookies.map((entry) => entry.split(";")[0]).join("; ");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
