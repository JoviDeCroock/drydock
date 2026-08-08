#!/usr/bin/env node
/**
 * Drydock release review action.
 *
 * Deliberately dependency-free. This file is the code that runs — there is no
 * bundle step and no `dist/` to diff against source, so anyone auditing what a
 * security tool does inside their release pipeline can read it here. Keep it
 * that way: no npm dependencies, no transpilation.
 *
 * What it does, in one sentence: mint a short-lived GitHub OIDC token, push the
 * release candidate bytes to Drydock during the build, and (in `verify` mode)
 * refuse to publish anything whose digest drifted from what was reviewed.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const STATE_FILE = ".drydock-release.json";

async function main() {
  const inputs = readInputs();
  const api = new DrydockClient(inputs.apiUrl, () => mintOidcToken(inputs.audience));

  if (inputs.mode === "verify") {
    await runVerify(api, inputs);
    return;
  }
  if (inputs.mode !== "publish") {
    throw new UserError(`unknown mode "${inputs.mode}" (expected "publish" or "verify")`);
  }
  await runPublish(api, inputs);
}

// ── publish ──────────────────────────────────────────────────────────────────

async function runPublish(api, inputs) {
  const files = resolveFiles(inputs.paths);
  if (files.length === 0) {
    throw new UserError(`no files matched ${inputs.paths.join(", ")}`);
  }

  const opened = await api.post("/api/ci/v1/releases", {
    releaseKey: inputs.releaseKey || undefined,
    ecosystem: inputs.ecosystem || undefined,
  });
  const releaseSetId = opened.releaseSet.id;
  writeState({ releaseSetId });
  log(`release set ${releaseSetId} (${files.length} artifact(s))`);

  const uploaded = [];
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    const digest = sha256(bytes);
    const name = path.basename(file);
    await api.put(
      `/api/ci/v1/releases/${encodeURIComponent(releaseSetId)}/artifacts/${encodeURIComponent(name)}`,
      bytes,
      { "x-drydock-sha256": digest },
    );
    uploaded.push({ path: name, sha256: digest, sizeBytes: bytes.length });
    log(`  uploaded ${name} (${formatBytes(bytes.length)}, sha256 ${digest.slice(0, 12)}…)`);
  }

  let state = opened.releaseSet;
  if (inputs.seal) {
    const sealed = await api.post(
      `/api/ci/v1/releases/${encodeURIComponent(releaseSetId)}/seal`,
      {},
    );
    state = sealed.releaseSet ?? state;
    log(`sealed — Drydock is reviewing ${state.artifactCount} artifact(s)`);
  } else {
    log("not sealed (seal: false) — a later step in this run must seal the release");
  }

  if (inputs.waitFor !== "none" && inputs.seal) {
    state = await waitForReleaseSet(api, releaseSetId, inputs);
  }

  setOutput("release-set-id", releaseSetId);
  setOutput("review-url", state.reviewUrl ?? "");
  setOutput("status", state.status ?? "open");
  setOutput("packages", JSON.stringify(state.packages ?? []));
  writeSummary(uploaded, state, inputs);

  if (inputs.waitFor === "decision") {
    const blocked = (state.packages ?? []).filter((pkg) => pkg.decision === "no_publish");
    if (blocked.length > 0) {
      throw new UserError(
        `Drydock blocked ${blocked.length} package(s): ${blocked
          .map((pkg) => pkg.name ?? pkg.scanId)
          .join(", ")}`,
      );
    }
  }
}

/**
 * Poll until the review (or the decision) is in.
 *
 * Backs off from 5s to 30s: a small release is reviewed in seconds, but waiting
 * on a human can take much longer and hammering the API buys nothing.
 */
async function waitForReleaseSet(api, releaseSetId, inputs) {
  const deadline = Date.now() + inputs.waitTimeoutSeconds * 1000;
  let delayMs = 5000;
  let last = null;

  for (;;) {
    const body = await api.get(`/api/ci/v1/releases/${encodeURIComponent(releaseSetId)}`);
    last = body.releaseSet;

    if (last.status === "errored") {
      throw new UserError(
        `Drydock could not review this release: ${last.failureReason ?? "unknown error"}`,
      );
    }
    if (last.status === "reviewed") {
      const packages = last.packages ?? [];
      if (inputs.waitFor === "review") return last;
      const undecided = packages.filter((pkg) => !pkg.decision);
      if (undecided.length === 0) return last;
      log(`waiting on a decision for ${undecided.length} package(s)…`);
    }

    if (Date.now() >= deadline) {
      log(`::warning::timed out after ${inputs.waitTimeoutSeconds}s waiting for ${inputs.waitFor}`);
      return last;
    }
    await sleep(Math.min(delayMs, Math.max(0, deadline - Date.now())));
    delayMs = Math.min(delayMs * 1.5, 30000);
  }
}

// ── verify ───────────────────────────────────────────────────────────────────

/**
 * Publish-time byte-continuity check.
 *
 * The point is not that CI hashes its own files — a workflow can already do
 * that with `sha256sum --check`. The point is that the comparison happens
 * against the digests *Drydock recomputed from the bytes it reviewed*, so a
 * rebuild between review and publish is caught even if the rebuild also
 * regenerated the checksum file.
 */
async function runVerify(api, inputs) {
  const releaseSetId = inputs.releaseSetId || readState()?.releaseSetId;
  if (!releaseSetId) {
    throw new UserError(
      "no release set to verify against; pass release-set-id or run the publish step first",
    );
  }
  const files = resolveFiles(inputs.paths);
  if (files.length === 0) {
    throw new UserError(`no files matched ${inputs.paths.join(", ")}`);
  }

  const artifacts = files.map((file) => ({
    path: path.basename(file),
    sha256: sha256(fs.readFileSync(file)),
  }));

  const result = await api.post(
    `/api/ci/v1/releases/${encodeURIComponent(releaseSetId)}/verify`,
    { artifacts },
    { allowStatus: [409] },
  );

  setOutput("release-set-id", releaseSetId);
  if (result.ok) {
    log(`verified ${artifacts.length} artifact(s) against the reviewed release`);
    appendSummary(
      `### Drydock verify\n\nAll ${artifacts.length} artifact(s) match the reviewed digests.\n`,
    );
    return;
  }

  const lines = (result.mismatches ?? []).map((entry) => {
    if (!entry.reviewed) return `- \`${entry.path}\` — not part of the reviewed release`;
    if (!entry.publishing) return `- \`${entry.path}\` — reviewed but missing at publish time`;
    return `- \`${entry.path}\` — reviewed ${entry.reviewed.slice(0, 12)}…, publishing ${entry.publishing.slice(0, 12)}…`;
  });
  appendSummary(`### Drydock verify failed\n\n${lines.join("\n")}\n`);
  throw new UserError(`publish-time bytes differ from the reviewed release:\n${lines.join("\n")}`);
}

// ── GitHub plumbing ──────────────────────────────────────────────────────────

/**
 * Exchange the runner's request token for an OIDC ID token bound to this job.
 *
 * Requires `permissions: id-token: write`. The absence of the request variables
 * is by far the most common setup mistake, so it gets a specific message rather
 * than a generic failure.
 */
async function mintOidcToken(audience) {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new UserError(
      "no OIDC token available — add `permissions: { id-token: write }` to this job",
    );
  }
  const url = `${requestUrl}&audience=${encodeURIComponent(audience)}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${requestToken}`, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new UserError(`could not mint an OIDC token (${response.status})`);
  }
  const body = await response.json();
  if (!body.value) throw new UserError("OIDC token response had no value");
  return body.value;
}

class DrydockClient {
  constructor(baseUrl, mintToken) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.mintToken = mintToken;
    this.token = null;
  }

  async authorization() {
    // One token per job run: GitHub's are short-lived but comfortably outlive a
    // single step, and re-minting per request would multiply the calls for no
    // benefit.
    if (!this.token) this.token = await this.mintToken();
    return `Bearer ${this.token}`;
  }

  get(pathname) {
    return this.request("GET", pathname, null, {});
  }

  post(pathname, body, options = {}) {
    return this.request("POST", pathname, JSON.stringify(body ?? {}), {
      "content-type": "application/json",
      ...options,
    });
  }

  put(pathname, bytes, headers) {
    return this.request("PUT", pathname, bytes, {
      "content-type": "application/octet-stream",
      ...headers,
    });
  }

  async request(method, pathname, body, options) {
    const { allowStatus = [], ...headers } = options;
    const url = `${this.baseUrl}${pathname}`;
    // Retry only what a retry can fix. A 4xx is a real answer — retrying a
    // rejected token or a bad digest just delays the failure.
    const maxAttempts = 4;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response;
      try {
        response = await fetch(url, {
          method,
          headers: { ...headers, Authorization: await this.authorization() },
          // Omitted rather than passed as null: fetch rejects a body on GET.
          ...(body === null || body === undefined ? {} : { body }),
        });
      } catch (err) {
        lastError = err;
        if (attempt === maxAttempts) break;
        await sleep(attempt * 1000);
        continue;
      }

      if (response.ok || allowStatus.includes(response.status)) {
        return await readJson(response);
      }
      if (response.status >= 500 || response.status === 429) {
        lastError = new Error(`${method} ${pathname} failed (${response.status})`);
        if (attempt === maxAttempts) break;
        await sleep(retryAfterMs(response) ?? attempt * 2000);
        continue;
      }
      const detail = await readJson(response).catch(() => null);
      throw new UserError(
        `${method} ${pathname} failed (${response.status})${detail?.error ? `: ${detail.error}` : ""}`,
      );
    }
    throw new UserError(`${method} ${pathname} failed: ${lastError?.message ?? "unknown error"}`);
  }
}

function retryAfterMs(response) {
  const header = response.headers.get("retry-after");
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// ── inputs, outputs, summary ─────────────────────────────────────────────────

function readInputs() {
  const waitFor = input("wait-for") || "none";
  if (!["none", "review", "decision"].includes(waitFor)) {
    throw new UserError(`wait-for must be none, review or decision (got "${waitFor}")`);
  }
  return {
    mode: (input("mode") || "publish").toLowerCase(),
    paths: splitPaths(input("path")),
    apiUrl: input("api-url") || "https://drydock.org",
    ecosystem: input("ecosystem"),
    releaseKey: input("release-key"),
    seal: (input("seal") || "true").toLowerCase() !== "false",
    waitFor,
    waitTimeoutSeconds: Number(input("wait-timeout-seconds") || "1800"),
    releaseSetId: input("release-set-id"),
    audience: input("audience") || "drydock",
  };
}

function input(name) {
  const value = process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return value === undefined ? "" : value.trim();
}

function splitPaths(raw) {
  return raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `drydock_${crypto.randomUUID()}`;
  fs.appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function appendSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  fs.appendFileSync(file, markdown);
}

function writeSummary(uploaded, state, inputs) {
  const rows = uploaded.map(
    (artifact) =>
      `| \`${artifact.path}\` | ${formatBytes(artifact.sizeBytes)} | \`${artifact.sha256.slice(0, 16)}…\` |`,
  );
  const parts = [
    "### Drydock release review",
    "",
    state.reviewUrl ? `[Open the review](${state.reviewUrl})` : "Review pending.",
    "",
    "| Artifact | Size | SHA-256 |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ];

  const packages = state.packages ?? [];
  if (packages.length > 0) {
    parts.push("| Package | Version | Risk | Decision |", "| --- | --- | --- | --- |");
    for (const pkg of packages) {
      parts.push(
        `| ${pkg.name ?? "—"} | ${pkg.version ?? "—"} | ${pkg.risk ?? "—"} | ${pkg.decision ?? "undecided"} |`,
      );
    }
    parts.push("");
  } else if (inputs.seal) {
    parts.push("_Review is still running; results will appear in the Drydock dashboard._", "");
  } else {
    parts.push("_Not sealed: a later step in this run must complete the release._", "");
  }

  appendSummary(`${parts.join("\n")}\n`);
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {
    // A read-only workspace just means `verify` needs release-set-id passed
    // explicitly; it is not worth failing the upload over.
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

// ── files ────────────────────────────────────────────────────────────────────

/**
 * Expand the configured globs against the workspace.
 *
 * A deliberately small matcher: `*` within a segment and `**` across segments,
 * which covers every release layout we have seen without pulling in a
 * dependency. Results are de-duplicated and sorted so the uploaded set (and the
 * job summary) is stable across runs.
 */
function resolveFiles(patterns) {
  const found = new Set();
  for (const pattern of patterns) {
    for (const file of expandGlob(pattern)) {
      if (fs.statSync(file).isFile()) found.add(path.resolve(file));
    }
  }
  const files = [...found].sort();
  const names = new Map();
  for (const file of files) {
    const name = path.basename(file);
    // Artifacts are stored by filename, so two different files with the same
    // basename would silently overwrite each other server-side. Fail loudly.
    if (names.has(name)) {
      throw new UserError(
        `two matched files share the filename "${name}": ${names.get(name)} and ${file}`,
      );
    }
    names.set(name, file);
  }
  return files;
}

function expandGlob(pattern) {
  if (!pattern.includes("*")) {
    return fs.existsSync(pattern) ? [pattern] : [];
  }
  const segments = pattern.split("/");
  let candidates = [segments[0] === "" ? "/" : "."];
  let start = 0;
  if (segments[0] !== "" && !segments[0].includes("*")) {
    candidates = [segments[0]];
    start = 1;
  }

  for (let index = start; index < segments.length; index += 1) {
    const segment = segments[index];
    const next = [];
    for (const base of candidates) {
      if (segment === "**") {
        next.push(base, ...walkDirectories(base));
        continue;
      }
      for (const entry of readDirSafe(base)) {
        if (matchSegment(segment, entry)) next.push(path.join(base, entry));
      }
    }
    candidates = [...new Set(next)];
  }
  return candidates.filter((candidate) => fs.existsSync(candidate));
}

function walkDirectories(base) {
  const out = [];
  for (const entry of readDirSafe(base)) {
    const full = path.join(base, entry);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) out.push(full, ...walkDirectories(full));
  }
  return out;
}

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function matchSegment(pattern, name) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(name);
}

// ── misc ─────────────────────────────────────────────────────────────────────

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function formatBytes(count) {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

class UserError extends Error {}

main().catch((err) => {
  const message = err instanceof UserError ? err.message : `unexpected failure: ${err.message}`;
  process.stdout.write(`::error::${message}\n`);
  process.exitCode = 1;
});
