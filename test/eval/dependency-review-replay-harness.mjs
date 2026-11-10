// Replays real Dependabot/Renovate pull requests through the dependency review
// stages to measure how often the check would hold, and what a cold diff costs.
//
// Collect mirrors `server/lib/dependency-review/collect.ts` over the public
// GitHub API (the PR list, one compare per PR for its files and merge base,
// lockfiles read at the merge base and head) and runs the production lockfile
// parsers, `diffLockfileSnapshots`, and the `.npmrc` / `.yarnrc.yml` private
// name rule. Review runs `loadPublicPackageDiff` itself, with the Worker
// bindings replaced by local stand-ins: no KV, no colo cache, and a LOADER that
// runs the same rendered sandbox module `npm-fp-sweep-harness.mjs` uses. Decide
// calls the production policy functions through `verdictFor`.
//
// Package bytes are hostile evidence: they are only parsed by Drydock's own
// sandbox module as data, never extracted, installed, imported, or executed.
// Private-source names never leave for a public registry. Every HTTP response
// is cached compressed under .context/, so reruns are offline.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname as pathDirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { dependencyChangeKey } from "../../server/db/dependency-reviews";
import {
  diffLockfileSnapshots,
  lockfileKindForPath,
  parseLockfile,
  unpinnedRequirementsChanged,
} from "../../server/lib/dependency-review/lockfiles";
import {
  concludeDependencyReview,
  decideBump,
  extractBumpEvidence,
} from "../../server/lib/dependency-review/policy";
import {
  collectCustomRegistries,
  emptyCustomRegistries,
  isPublicNpmName,
} from "../../server/lib/dependency-review/registry-config";
import { hasUnreadContent } from "../../server/lib/dependency-review/evidence";
import * as render from "../../server/lib/dependency-review/render";
import * as reviewStage from "../../server/lib/dependency-review/review-bumps";
import { DEFAULT_DEPENDENCY_REVIEW_POLICY } from "../../server/lib/dependency-review/types";
import { getPublicDiffAdapter } from "../../server/lib/ecosystems";
import { loadPublicPackageDiff, PublicDiffError } from "../../server/lib/public-diff";
import { evaluateNpmStageGatewayRequest } from "../../server/lib/sandbox";

const __dirname = pathDirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
export const REPLAY_DIR = join(ROOT, ".context", "dependency-review-replay");
const HTTP_CACHE = join(REPLAY_DIR, "http");
const DIFF_CACHE = join(REPLAY_DIR, "diffs");
// Shared with the npm sweep, in its format (raw .tgz named by URL path).
const SWEEP_TARBALLS =
  process.env.NPM_FP_SWEEP_CACHE ?? join(ROOT, ".context", "npm-fp-sweep", "tarballs");
const NPM_REGISTRY = "https://registry.npmjs.org";
const USER_AGENT = "dependency-review-replay";
const BOTS = new Set(["dependabot[bot]", "renovate[bot]"]);
// Everything else is refused: the replay has no reason to reach another host.
const ALLOWED_HOSTS = new Set([
  "api.github.com",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
]);
const MAX_CACHED_BODY_BYTES = 256 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
// Production's per-invocation numbers this calibrates against.
const CPU_FLAG_MS = 750;
const SANDBOX_CPU_LIMIT_MS = 2_000;

// Module-private in collect.ts / github.ts / policy.ts; copied so the replay
// applies the same caps and file rules.
const MAX_LOCKFILES = 20;
const MAX_LOCKFILE_BYTES = 8 * 1024 * 1024;
// Namespace reads so a renamed constant falls back instead of failing the import.
const MAX_DIFFED_BUMPS = render.MAX_STORED_BUMPS ?? 500;
const COLD_DIFFS_PER_PASS = reviewStage.MAX_COLD_DIFFS_PER_PASS ?? 40;
const UNPARSED_LOCKFILE =
  /(?:^|\/)(?:bun\.lockb?|poetry\.lock|Pipfile\.lock|pdm\.lock|pylock(?:\.[^/]+)?\.toml)$/;
const OTHER_REQUIREMENTS = /\.txt$/;
const NPM_MANIFEST = /(?:^|\/)package\.json$/;
const PYPI_MANIFEST = /(?:^|\/)(?:pyproject\.toml|setup\.cfg|setup\.py|Pipfile|[^/]+\.in)$/;
const NATIVE_FILE = /\.(?:node|dll|so|dylib|exe|wasm)$/i;
const KIND_ECOSYSTEM = { npm: "npm", pnpm: "npm", yarn: "npm", uv: "pypi", requirements: "pypi" };
// GitHub's compare lists at most 300 files.
const COMPARE_FILE_LIMIT = 300;

export function loadReplayRepositories() {
  return JSON.parse(readFileSync(join(__dirname, "dependency-review-replay-repos.json"), "utf8"));
}

// ---------------------------------------------------------------------------
// HTTP: one cached fetch for GitHub, the registries, and the sandbox gateway.

class RateLimitedError extends Error {}

const http = {
  token: null,
  // Hosts that answered with a rate limit. Cache hits still serve and misses
  // fail fast, so the rest of the run continues on what earlier runs cached.
  // The API and raw content are limited separately.
  blockedHosts: new Set(),
  githubRemaining: null,
  networkFetches: 0,
};
const realFetch = globalThis.fetch;

function sweepTarballPath(url) {
  if (url.origin !== NPM_REGISTRY || !url.pathname.includes("/-/")) return null;
  const key = url.href
    .slice(NPM_REGISTRY.length + 1)
    .replace(/[^a-zA-Z0-9._@-]+/g, "_")
    .slice(-200);
  return join(SWEEP_TARBALLS, key);
}

function httpCachePath(url, accept) {
  const key = createHash("sha256").update(`${accept}\n${url}`).digest("hex");
  return join(HTTP_CACHE, key.slice(0, 2), `${key}.gz`);
}

function readHttpCache(file) {
  if (!existsSync(file)) return null;
  const raw = gunzipSync(readFileSync(file));
  const headerLength = raw.readUInt32BE(0);
  const meta = JSON.parse(raw.subarray(4, 4 + headerLength).toString("utf8"));
  return { ...meta, body: raw.subarray(4 + headerLength) };
}

function writeHttpCache(file, meta, body) {
  const header = Buffer.from(JSON.stringify(meta), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  mkdirSync(pathDirname(file), { recursive: true });
  writeFileSync(file, gzipSync(Buffer.concat([length, header, body]), { level: 6 }));
}

function cachedResponse(status, contentType, body) {
  const headers = new Headers({ "content-length": String(body.byteLength) });
  if (contentType) headers.set("content-type", contentType);
  return new Response(status === 204 || status === 304 ? null : body, { status, headers });
}

async function cachedFetch(input, init) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(`replay: refused egress to ${url.hostname}`);
  }
  if (request.method !== "GET") throw new Error(`replay: refused ${request.method}`);
  const accept = request.headers.get("accept") ?? "";
  const github = url.hostname === "api.github.com" || url.hostname === "raw.githubusercontent.com";
  const tarballFile = sweepTarballPath(url);
  const cacheFile = tarballFile ? null : httpCachePath(url.href, accept);
  if (tarballFile && existsSync(tarballFile)) {
    return cachedResponse(200, "application/octet-stream", readFileSync(tarballFile));
  }
  const hit = cacheFile ? readHttpCache(cacheFile) : null;
  if (hit) return cachedResponse(hit.status, hit.contentType, hit.body);
  if (http.blockedHosts.has(url.hostname)) {
    throw new RateLimitedError(`${url.hostname} rate limit (cache miss)`);
  }

  const headers = new Headers({ "user-agent": USER_AGENT });
  if (accept) headers.set("accept", accept);
  if (url.hostname === "api.github.com") {
    headers.set("x-github-api-version", "2022-11-28");
    if (http.token) headers.set("authorization", `Bearer ${http.token}`);
  }
  http.networkFetches += 1;
  const response = await realFetch(url, {
    headers,
    redirect: request.redirect === "manual" ? "manual" : "follow",
    signal: request.signal ?? AbortSignal.timeout(120_000),
  });
  if (github) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (url.hostname === "api.github.com" && remaining !== null) {
      http.githubRemaining = Number(remaining);
    }
    if (response.status === 429 || (response.status === 403 && remaining === "0")) {
      await response.body?.cancel();
      http.blockedHosts.add(url.hostname);
      throw new RateLimitedError(`${url.hostname} rate limit (${response.status})`);
    }
  }
  const cacheable = response.status === 200 || response.status === 404;
  const length = Number(response.headers.get("content-length") || "0");
  if (!cacheable || length > MAX_CACHED_BODY_BYTES) return response;
  const body = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type");
  if (tarballFile && response.status === 200) {
    mkdirSync(SWEEP_TARBALLS, { recursive: true });
    writeFileSync(tarballFile, body);
  } else if (cacheFile) {
    writeHttpCache(cacheFile, { status: response.status, contentType }, body);
  }
  return cachedResponse(response.status, contentType, body);
}

// ---------------------------------------------------------------------------
// Worker bindings, replaced for a Node process.

const sandboxFactories = new Map();
const sandboxStats = { parses: [] };
let sandboxQueue = Promise.resolve();

// The sandbox module's only egress is a free `fetch`; it is bound to the
// gateway policy production gives it (`NpmStageGateway`), minus credentials.
function gatewayFetcher(props) {
  return {
    fetch(input, init) {
      const request = new Request(input, init);
      const policy = evaluateNpmStageGatewayRequest(
        request.url,
        request.method,
        props.npmRegistry || NPM_REGISTRY,
        props.publicArtifactUrls,
      );
      if (!policy.allowed) return new Response("blocked by stage gateway", { status: 403 });
      return cachedFetch(request);
    },
  };
}

// Parses run one at a time so `process.cpuUsage` can attribute them: in
// Workers each runs in its own isolate under its own `cpuMs` limit, apart from
// the parent's.
function serializedParse(run) {
  const turn = sandboxQueue.then(async () => {
    const start = process.cpuUsage();
    const wallStart = performance.now();
    try {
      const response = await run();
      const body = await response.text();
      return new Response(body, { status: response.status, headers: response.headers });
    } finally {
      sandboxStats.parses.push({
        cpuMs: cpuMsSince(start),
        wallMs: performance.now() - wallStart,
      });
    }
  });
  sandboxQueue = turn.catch(() => undefined);
  return turn;
}

const loader = {
  load(spec) {
    const source = spec.modules[spec.mainModule];
    let factory = sandboxFactories.get(source);
    if (!factory) {
      factory = new Function("fetch", source.replace("export default", "return"));
      sandboxFactories.set(source, factory);
    }
    const outbound = spec.globalOutbound;
    const module = factory((input, init) => outbound.fetch(input, init));
    return {
      getEntrypoint: () => ({
        fetch: (request) => serializedParse(() => module.fetch(request, spec.env)),
      }),
    };
  },
};

const noColoCache = {
  match: async () => undefined,
  put: async () => undefined,
  delete: async () => false,
};

function replayContext(pending) {
  return {
    waitUntil: (promise) => pending.push(promise),
    passThroughOnException: () => undefined,
    exports: { NpmStageGateway: ({ props }) => gatewayFetcher(props ?? {}) },
  };
}

async function withReplayGlobals(run) {
  const previousCaches = globalThis.caches;
  globalThis.fetch = cachedFetch;
  globalThis.caches = { default: noColoCache };
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
    if (previousCaches === undefined) delete globalThis.caches;
    else globalThis.caches = previousCaches;
  }
}

function cpuMsSince(start) {
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

// ---------------------------------------------------------------------------
// Collect: GitHub PRs to bumps.

async function githubJson(path) {
  const response = await cachedFetch(`https://api.github.com${path}`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub ${response.status} for ${path.split("?")[0]}`);
  return response.json();
}

async function readRepositoryFile(repo, ref, path) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const response = await cachedFetch(
    `https://raw.githubusercontent.com/${repo}/${ref}/${encoded}`,
    {
      headers: { accept: "*/*" },
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`raw ${response.status} for ${path}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_LOCKFILE_BYTES) return "too-large";
  return new TextDecoder().decode(bytes);
}

async function listBotPulls(repo, limit) {
  const pulls = [];
  for (let page = 1; page <= 3 && pulls.length < limit; page += 1) {
    const batch = await githubJson(
      `/repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const pr of batch) {
      if (BOTS.has(pr.user?.login) && pr.user?.type === "Bot") pulls.push(pr);
    }
    if (batch.length < 100) break;
  }
  return pulls.slice(0, limit).map((pr) => ({
    repo,
    number: pr.number,
    title: pr.title,
    author: pr.user.login,
    createdAt: pr.created_at,
    mergedAt: pr.merged_at ?? null,
    closedAt: pr.closed_at ?? null,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
  }));
}

function dirname(path) {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
}

async function readLockfileText(repo, kind, path, ref) {
  const text = await readRepositoryFile(repo, ref, path);
  if (text === null || text === "too-large") return text;
  if (kind !== "yarn") return { text, manifest: null };
  const manifest = await readRepositoryFile(repo, ref, `${dirname(path)}package.json`);
  return { text, manifest: typeof manifest === "string" ? manifest : null };
}

async function readCustomRegistries(repo, dir, headSha) {
  const found = emptyCustomRegistries();
  for (const base of new Set([dir, ""])) {
    const [npmrc, yarnrc] = await Promise.all([
      readRepositoryFile(repo, headSha, `${base}.npmrc`),
      readRepositoryFile(repo, headSha, `${base}.yarnrc.yml`),
    ]);
    if (npmrc === "too-large" || yarnrc === "too-large") return { all: true, scopes: new Set() };
    collectCustomRegistries(found, { npmrc, yarnrc });
  }
  return found;
}

// collect.ts `collectBumps`, with the compare API standing in for the PR file
// listing plus merge-base call (one request instead of two or more).
async function collectPull(pr) {
  const compare = await githubJson(`/repos/${pr.repo}/compare/${pr.baseSha}...${pr.headSha}`);
  if (!compare?.merge_base_commit?.sha) throw new Error("compare unavailable");
  const mergeBase = compare.merge_base_commit.sha;
  const headSha = pr.headSha;
  const files = (compare.files ?? []).map((file) => ({
    filename: file.filename,
    status: file.status,
    previousFilename: file.previous_filename ?? null,
  }));
  const commits = compare.commits ?? [];
  const headCommittedAt = commits.at(-1)?.commit?.committer?.date ?? null;
  const listingComplete = files.length < COMPARE_FILE_LIMIT;
  const changed = files.filter((file) => file.status !== "removed");
  const lockfiles = [];
  for (const file of changed) {
    if (UNPARSED_LOCKFILE.test(file.filename)) continue;
    const kind =
      lockfileKindForPath(file.filename) ??
      (OTHER_REQUIREMENTS.test(file.filename) ? "requirements" : null);
    if (kind) lockfiles.push({ file, kind });
  }
  // Why each lockfile went unread, so a parser that stops finishing shows up
  // in the report instead of reading as a quiet sample.
  const unread = [];
  for (const file of changed) {
    if (UNPARSED_LOCKFILE.test(file.filename)) unread.push([file.filename, "unparsed-format"]);
  }
  for (const { file } of lockfiles.slice(MAX_LOCKFILES)) unread.push([file.filename, "over-cap"]);
  for (const file of files) {
    if (
      file.status === "removed" &&
      (lockfileKindForPath(file.filename) || UNPARSED_LOCKFILE.test(file.filename))
    ) {
      unread.push([file.filename, "deleted"]);
    }
  }
  const registries = new Map();
  const byChange = new Map();
  for (const { file, kind } of lockfiles.slice(0, MAX_LOCKFILES)) {
    const beforePath = file.status === "added" ? null : (file.previousFilename ?? file.filename);
    const [before, after] = await Promise.all([
      beforePath ? readLockfileText(pr.repo, kind, beforePath, mergeBase) : null,
      readLockfileText(pr.repo, kind, file.filename, headSha),
    ]);
    if (before === "too-large" || after === "too-large" || after === null) {
      unread.push([file.filename, after === null ? "missing-at-head" : "too-large"]);
      continue;
    }
    const baseSnapshot = before
      ? parseLockfile(kind, before.text, { manifestText: before.manifest })
      : null;
    const headSnapshot = parseLockfile(kind, after.text, { manifestText: after.manifest });
    if (!headSnapshot.complete || (baseSnapshot && !baseSnapshot.complete)) {
      unread.push([file.filename, "parse-incomplete"]);
      continue;
    }
    if (unpinnedRequirementsChanged(baseSnapshot, headSnapshot)) {
      unread.push([file.filename, "unpinned-requirements"]);
    }
    let custom = null;
    if (KIND_ECOSYSTEM[kind] === "npm") {
      const dir = dirname(file.filename);
      if (!registries.has(dir)) registries.set(dir, readCustomRegistries(pr.repo, dir, headSha));
      custom = await registries.get(dir);
    }
    for (const found of diffLockfileSnapshots(baseSnapshot, headSnapshot, file.filename)) {
      const bump =
        custom && !isPublicNpmName(custom, found.name) ? { ...found, privateSource: true } : found;
      const key = dependencyChangeKey(bump);
      const existing = byChange.get(key);
      if (existing) existing.direct ||= bump.direct;
      else byChange.set(key, { ...bump });
    }
  }
  const bumps = [...byChange.values()].sort(
    (a, b) => Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name),
  );
  return {
    ...pr,
    mergeBase,
    headCommittedAt,
    changedFiles: files.length,
    listingComplete,
    lockfiles: lockfiles.map(({ file }) => file.filename),
    unreadLockfiles: unread.map(([path]) => path),
    unreadReasons: unread.map(([path, reason]) => ({ path, reason })),
    // Manifest coverage (collect.ts `unreadManifests`) is not replayed; these
    // are the changed manifests it would have looked at.
    changedManifests: changed
      .map((file) => file.filename)
      .filter((path) => NPM_MANIFEST.test(path) || PYPI_MANIFEST.test(path)),
    bumps: bumps.map((bump) => ({
      ecosystem: bump.ecosystem,
      name: bump.name,
      fromVersion: bump.fromVersion,
      toVersion: bump.toVersion,
      direct: bump.direct,
      lockfilePath: bump.lockfilePath,
      ...(bump.privateSource ? { privateSource: true } : {}),
      ...(bump.remoteSource ? { remoteSource: true } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Review: one cold public diff per unique pair.

function pairKey(bump, adapter) {
  const name = adapter ? adapter.normalizePackageName(bump.name) : bump.name;
  return `${bump.ecosystem}|${name}|${bump.fromVersion}|${bump.toVersion}`;
}

// Versioned like the production KV key, so a rules or payload bump re-diffs.
function diffCachePath(key, adapter) {
  const version = adapter ? `${adapter.payloadVersion}|${adapter.rulesVersionSegment}` : "";
  const hash = createHash("sha256").update(`${version}|${key}`).digest("hex");
  return join(DIFF_CACHE, `${hash}.json.gz`);
}

function readJsonGz(file) {
  return existsSync(file) ? JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) : null;
}

function writeJsonGz(file, value) {
  mkdirSync(pathDirname(file), { recursive: true });
  writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(value), "utf8")));
}

function isNativeEntry(entry) {
  return entry.flags.some((flag) => flag.startsWith("native-")) || NATIVE_FILE.test(entry.path);
}

// review-bumps.ts `diffInput` + `diffFailure` (module-private), timed: the
// same validation and error mapping around the production
// `loadPublicPackageDiff`, plus the evidence extraction.
async function coldDiff(bump) {
  const adapter = getPublicDiffAdapter(bump.ecosystem);
  if (
    !adapter ||
    !adapter.isValidPackageName(bump.name) ||
    !adapter.isValidVersion(bump.fromVersion) ||
    !adapter.isValidVersion(bump.toVersion) ||
    bump.fromVersion.includes(":") ||
    bump.toVersion.includes(":")
  ) {
    return { status: "unsupported" };
  }
  const pending = [];
  const env = { LOADER: loader };
  const ctx = replayContext(pending);
  const parsesBefore = sandboxStats.parses.length;
  const networkBefore = http.networkFetches;
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  let result;
  try {
    const diff = await loadPublicPackageDiff(env, ctx, {
      ecosystem: adapter.ecosystem,
      packageName: adapter.normalizePackageName(bump.name),
      fromVersion: bump.fromVersion,
      toVersion: bump.toVersion,
      registryUrl: adapter.registryUrl,
    });
    const evidence = extractBumpEvidence(diff);
    await Promise.allSettled(pending);
    const nativeBinariesChanged = diff.diff.filter(
      (entry) => entry.status === "modified" && isNativeEntry(entry),
    ).length;
    result = {
      status: "served",
      evidence,
      // The evidence field once production computes it; until then, the same
      // count from the diff entries.
      nativeBinariesChanged: evidence.nativeBinariesChanged ?? nativeBinariesChanged,
      files: diff.toFiles.length,
    };
  } catch (err) {
    await Promise.allSettled(pending);
    if (err instanceof PublicDiffError && err.status === 404) result = { status: "not-found" };
    else if (err instanceof PublicDiffError && (err.status === 400 || err.status === 413)) {
      result = { status: "unsupported", error: err.message };
    } else {
      result = { status: "failed", error: String(err?.message ?? err).slice(0, 200) };
    }
  }
  const parses = sandboxStats.parses.slice(parsesBefore);
  result.cost = {
    cpuMs: cpuMsSince(cpuStart),
    wallMs: performance.now() - wallStart,
    sandboxCpuMs: parses.reduce((sum, parse) => sum + parse.cpuMs, 0),
    maxParseCpuMs: Math.max(0, ...parses.map((parse) => parse.cpuMs)),
    parses: parses.length,
    network: http.networkFetches > networkBefore,
    measuredAt: new Date().toISOString(),
  };
  return result;
}

async function diffFor(bump, deadline) {
  const adapter = getPublicDiffAdapter(bump.ecosystem);
  const file = diffCachePath(pairKey(bump, adapter), adapter);
  const cached = readJsonGz(file);
  if (cached) return cached;
  if (Date.now() > deadline) return { status: "not-replayed" };
  const result = await coldDiff(bump);
  // A failure may be transient; a rerun tries it again.
  if (result.status !== "failed") writeJsonGz(file, result);
  return result;
}

// ---------------------------------------------------------------------------
// Registry publish time of the target version, read as review-bumps.ts
// `publishedAtOf` does: the adapter's version listing (npm `time[version]`,
// PyPI's newest non-yanked upload), matched by the ecosystem's equivalence.

const listings = new Map();
const publishTimes = new Map();

async function lookupPublishTime(bump) {
  const adapter = getPublicDiffAdapter(bump.ecosystem);
  if (!adapter) return null;
  const name = adapter.normalizePackageName(bump.name);
  const key = `${bump.ecosystem}|${name}`;
  if (!listings.has(key)) {
    listings.set(
      key,
      adapter.listVersions({}, replayContext([]), name, adapter.registryUrl).catch((err) => {
        if (err instanceof PublicDiffError && err.status === 404) return null;
        throw err;
      }),
    );
  }
  const listing = await listings.get(key);
  if (!listing) return null;
  const same = adapter.versionsEquivalent ?? ((a, b) => a === b);
  return listing.versions.find((entry) => same(entry.version, bump.toVersion))?.publishedAt ?? null;
}

async function publishTimeFor(bump) {
  // Private names never go to a public registry; a remote source has no
  // registry publish time at all.
  if (bump.privateSource) return { publishedAt: null, lookup: "private" };
  const key = `${bump.ecosystem}|${bump.name}|${bump.toVersion}`;
  if (!publishTimes.has(key)) {
    publishTimes.set(
      key,
      lookupPublishTime(bump).then(
        (publishedAt) => ({ publishedAt, lookup: publishedAt ? "found" : "missing" }),
        () => ({ publishedAt: null, lookup: "failed" }),
      ),
    );
  }
  return publishTimes.get(key);
}

async function mapLimit(items, limit, fn) {
  const results = Array.from({ length: items.length });
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Run.

export async function runReplay({ repositories, prsPerRepo, budgetMs, token, log = () => {} }) {
  http.token = token || null;
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  const stops = [];
  const prs = [];
  const skipped = [];
  const listed = [];

  await withReplayGlobals(async () => {
    for (const { repo } of repositories) {
      let pulls;
      try {
        pulls = await listBotPulls(repo, prsPerRepo);
      } catch (err) {
        skipped.push({ repo, reason: String(err.message) });
        if (err instanceof RateLimitedError) stops.push(`listing ${repo}: ${err.message}`);
        continue;
      }
      listed.push({ repo, botPulls: pulls.length });
      for (const pr of pulls) {
        try {
          prs.push(await collectPull(pr));
        } catch (err) {
          skipped.push({ repo, number: pr.number, reason: String(err.message) });
        }
      }
      log(
        `collected ${repo}: ${pulls.length} bot PRs (GitHub remaining ${http.githubRemaining ?? "?"})`,
      );
    }
    for (const host of http.blockedHosts) {
      stops.push(`${host} rate limit reached; later cache misses there skipped`);
    }

    // Review plan as review-bumps.ts: diffable bumps in collect order (direct
    // first) up to the per-review cap.
    const unique = new Map();
    for (const pr of prs) {
      let diffable = 0;
      for (const bump of pr.bumps) {
        if (bump.privateSource)
          bump.diff = { status: bump.remoteSource ? "remote-source" : "private-source" };
        else if (bump.fromVersion === null) bump.diff = { status: "new-package" };
        else if (++diffable > MAX_DIFFED_BUMPS) bump.diff = { status: "over-cap" };
        else {
          const key = pairKey(bump, getPublicDiffAdapter(bump.ecosystem));
          if (!unique.has(key)) unique.set(key, bump);
        }
      }
    }
    const pairs = [...unique.entries()];
    log(`diffing ${pairs.length} unique pairs (sequential, for CPU attribution)`);
    const results = new Map();
    let done = 0;
    for (const [key, bump] of pairs) {
      results.set(key, await diffFor(bump, deadline));
      done += 1;
      if (done % 25 === 0 || done === pairs.length) log(`diffs ${done}/${pairs.length}`);
    }
    if (Date.now() > deadline) stops.push("time budget reached during diffs; rerun to resume");
    for (const pr of prs) {
      for (const bump of pr.bumps) {
        if (bump.diff) continue;
        const result = results.get(pairKey(bump, getPublicDiffAdapter(bump.ecosystem)));
        bump.diff = { status: result.status, ...(result.error ? { error: result.error } : {}) };
        if (result.status === "served") {
          bump.evidence = {
            ...result.evidence,
            nativeBinariesChanged: result.nativeBinariesChanged,
          };
        }
        if (result.cost) bump.cost = result.cost;
      }
    }

    const allBumps = prs.flatMap((pr) => pr.bumps);
    log(`publish times for ${allBumps.length} bumps`);
    await mapLimit(allBumps, 8, async (bump) => {
      if (Date.now() > deadline && !bump.privateSource) {
        const key = `${bump.ecosystem}|${bump.name}|${bump.toVersion}`;
        if (!publishTimes.has(key)) {
          bump.publish = { publishedAt: null, lookup: "not-replayed" };
          return;
        }
      }
      bump.publish = await publishTimeFor(bump);
    });
  });

  return {
    generatedAt: new Date().toISOString(),
    authenticated: Boolean(token),
    prsPerRepo,
    durationMs: Date.now() - startedAt,
    repositories: repositories.map(({ repo }) => repo),
    listed,
    stops,
    skipped,
    prs,
  };
}

// ---------------------------------------------------------------------------
// Decide.

/**
 * The one place a recorded bump becomes a verdict under a policy: the
 * production `decideBump` over the outcome the review stage would have built.
 *
 * Clock seam: `nowMs` is the evaluation time, the PR's creation time (or its
 * head commit time for `proposed@head`), never today, or every version reads
 * as old. The target's registry publish time is `bump.publish.publishedAt`
 * (ISO, or null when unknown, private, or remote).
 */
function verdictFor(bump, policy, nowMs) {
  const publishedAt = bump.publish?.publishedAt ?? null;
  const status = bump.diff.status;
  const outcome =
    status === "served"
      ? { kind: "diffed", evidence: bump.evidence, publishedAt }
      : status === "new-package"
        ? { kind: "new-package", publishedAt }
        : { kind: "unreviewed", reason: status, publishedAt };
  return decideBump(outcome, policy, nowMs);
}

// job.ts `runReview`'s conclusion, without approvals.
function concludePull(pr, policy, nowMs) {
  const reviewed = pr.bumps.map((bump) => ({
    bump,
    verdict: verdictFor(bump, policy, nowMs),
    approved: false,
  }));
  let conclusion = concludeDependencyReview(reviewed);
  const partial = pr.unreadLockfiles.length > 0 || !pr.listingComplete;
  const partialHold = partial && policy.holdOnUnreviewed && conclusion !== "held";
  if (partialHold) conclusion = "held";
  return { conclusion, reviewed, partialHold };
}

function strictPolicy() {
  const policy = { ...DEFAULT_DEPENDENCY_REVIEW_POLICY };
  for (const [key, value] of Object.entries(policy)) {
    if (key.startsWith("hold") && typeof value === "boolean") policy[key] = true;
  }
  return policy;
}

const VARIANTS = {
  previous: { ...DEFAULT_DEPENDENCY_REVIEW_POLICY, unreadMinimumAgeDays: null },
  proposed: { ...DEFAULT_DEPENDENCY_REVIEW_POLICY },
  strict: strictPolicy(),
};

// ---------------------------------------------------------------------------
// Summarize.

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

function spread(values) {
  return {
    n: values.length,
    median: quantile(values, 0.5),
    p90: quantile(values, 0.9),
    max: values.length ? Math.max(...values) : null,
  };
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function isReplayed(pr) {
  return pr.bumps.every(
    (bump) => bump.diff?.status !== "not-replayed" && bump.publish?.lookup !== "not-replayed",
  );
}

function evaluateVariant(prs, policy, clock) {
  const rows = prs.map((pr) => {
    const nowMs = clock(pr);
    const { conclusion, reviewed, partialHold } = concludePull(pr, policy, nowMs);
    const holds = reviewed.filter(({ verdict }) => verdict.status === "hold");
    const reasons = new Set(holds.flatMap(({ verdict }) => verdict.reasons));
    if (partialHold) reasons.add("unread-lockfile");
    const unvouched = reviewed.filter(
      ({ verdict }) =>
        verdict.status === "unreviewed" ||
        verdict.status === "new-package" ||
        (verdict.status === "clear" && hasUnreadContent(verdict.evidence)),
    ).length;
    const ageOnly = conclusion === "held" && [...reasons].every((reason) => reason === "too-new");
    let passesInHours = null;
    if (ageOnly) {
      const times = holds.map(({ verdict }) => verdict.passesAt);
      passesInHours = times.every(Boolean)
        ? (Math.max(...times.map((time) => Date.parse(time))) - nowMs) / 3_600_000
        : Infinity;
    }
    return { pr, conclusion, holds: holds.length, reasons, unvouched, ageOnly, passesInHours };
  });
  const withBumps = rows.filter((row) => row.pr.bumps.length > 0);
  const held = rows.filter((row) => row.conclusion === "held");
  const reasonCounts = {};
  for (const row of held) {
    for (const reason of row.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }
  const ageWaits = rows.filter((row) => row.ageOnly).map((row) => row.passesInHours);
  return {
    prs: rows.length,
    withBumps: withBumps.length,
    held: held.length,
    heldWithBumps: held.filter((row) => row.pr.bumps.length > 0).length,
    passUnvouched: rows.filter((row) => row.conclusion !== "held" && row.unvouched > 0).length,
    holdsPerHeld: spread(held.map((row) => row.holds)),
    reasonCounts,
    ageOnly: {
      prs: ageWaits.length,
      untilApproved: ageWaits.filter((hours) => hours === Infinity).length,
      hours: spread(ageWaits.filter((hours) => hours !== Infinity)),
    },
    rows,
  };
}

const createdClock = (pr) => Date.parse(pr.createdAt);
const headClock = (pr) => Date.parse(pr.headCommittedAt ?? pr.createdAt);

function summarizeReplay(dataset) {
  const complete = dataset.prs.filter(isReplayed);
  const variants = Object.fromEntries(
    Object.entries(VARIANTS).map(([name, policy]) => [
      name,
      evaluateVariant(complete, policy, createdClock),
    ]),
  );
  variants["proposed@head"] = evaluateVariant(complete, VARIANTS.proposed, headClock);
  const repos = [...new Set(complete.map((pr) => pr.repo))].map((repo) => {
    const prs = complete.filter((pr) => pr.repo === repo);
    return {
      repo,
      prs: prs.length,
      withBumps: prs.filter((pr) => pr.bumps.length > 0).length,
      bumps: prs.reduce((sum, pr) => sum + pr.bumps.length, 0),
      held: Object.fromEntries(
        Object.keys(variants).map((name) => [
          name,
          variants[name].rows.filter((row) => row.pr.repo === repo && row.conclusion === "held")
            .length,
        ]),
      ),
    };
  });
  const withBumps = complete.filter((pr) => pr.bumps.length > 0);
  const reviewable = (pr) =>
    pr.bumps.filter((bump) => !bump.privateSource && bump.fromVersion !== null).length;
  const bumps = complete.flatMap((pr) => pr.bumps.map((bump) => ({ pr, bump })));
  const ages = { known: 0, unknown: 0, negative: 0, under1: 0, under3: 0, under7: 0 };
  for (const { pr, bump } of bumps) {
    const published = bump.publish?.publishedAt ? Date.parse(bump.publish.publishedAt) : NaN;
    if (!Number.isFinite(published)) {
      ages.unknown += 1;
      continue;
    }
    ages.known += 1;
    const age = createdClock(pr) - published;
    if (age < 0) ages.negative += 1;
    if (age < DAY_MS) ages.under1 += 1;
    if (age < 3 * DAY_MS) ages.under3 += 1;
    if (age < 7 * DAY_MS) ages.under7 += 1;
  }
  const costByPair = new Map();
  for (const { bump } of bumps) {
    if (bump.cost)
      costByPair.set(`${bump.ecosystem}|${bump.name}|${bump.fromVersion}|${bump.toVersion}`, {
        ...bump.cost,
        ecosystem: bump.ecosystem,
        status: bump.diff.status,
      });
  }
  const costs = [...costByPair.values()];
  const costFor = (list) => ({
    pairs: list.length,
    cpu: spread(list.map((cost) => cost.cpuMs)),
    wall: spread(list.map((cost) => cost.wallMs)),
    parentCpu: spread(list.map((cost) => cost.cpuMs - cost.sandboxCpuMs)),
    over750: list.filter((cost) => cost.cpuMs > CPU_FLAG_MS).length,
    parentOver750: list.filter((cost) => cost.cpuMs - cost.sandboxCpuMs > CPU_FLAG_MS).length,
    parseOver2000: list.filter((cost) => cost.maxParseCpuMs > SANDBOX_CPU_LIMIT_MS).length,
    networkCold: list.filter((cost) => cost.network).length,
  });
  const statusCounts = {};
  for (const { bump } of bumps) {
    statusCounts[bump.diff.status] = (statusCounts[bump.diff.status] ?? 0) + 1;
  }
  const created = complete.map((pr) => pr.createdAt).sort();
  return {
    complete: complete.length,
    incomplete: dataset.prs.length - complete.length,
    dateRange: created.length ? [created[0], created.at(-1)] : null,
    variants,
    repos,
    bumpsPerPr: spread(withBumps.map((pr) => pr.bumps.length)),
    reviewablePerPr: spread(withBumps.map((pr) => reviewable(pr))),
    over40Reviewable: withBumps.filter((pr) => reviewable(pr) > COLD_DIFFS_PER_PASS).length,
    over500: withBumps.filter((pr) => pr.bumps.length > MAX_DIFFED_BUMPS).length,
    ecosystems: {
      npm: bumps.filter(({ bump }) => bump.ecosystem === "npm").length,
      pypi: bumps.filter(({ bump }) => bump.ecosystem === "pypi").length,
    },
    totalBumps: bumps.length,
    ages,
    cost: {
      all: costFor(costs),
      npm: costFor(costs.filter((c) => c.ecosystem === "npm")),
      pypi: costFor(costs.filter((c) => c.ecosystem === "pypi")),
    },
    statusCounts,
    unreadLockfilePrs: complete.filter((pr) => pr.unreadLockfiles.length > 0).length,
    unreadReasons: countBy(complete.flatMap((pr) => pr.unreadReasons.map((entry) => entry.reason))),
    incompleteListings: complete.filter((pr) => !pr.listingComplete).length,
    manifestOnlyPrs: complete.filter(
      (pr) => pr.lockfiles.length === 0 && pr.changedManifests.length > 0,
    ).length,
  };
}

// ---------------------------------------------------------------------------
// Report.

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
const num = (value, digits = 0) =>
  value === null || value === undefined ? "–" : Number(value).toFixed(digits);
const trio = (s, digits = 0) =>
  `${num(s.median, digits)} / ${num(s.p90, digits)} / ${num(s.max, digits)}`;

function renderReport(dataset, summary) {
  const names = Object.keys(summary.variants);
  const lines = [
    `# Dependency review replay`,
    ``,
    `${dataset.generatedAt} · ${summary.complete} PRs replayed across ${summary.repos.length} repositories · ${summary.totalBumps} bumps (npm ${summary.ecosystems.npm}, PyPI ${summary.ecosystems.pypi}) · ${dataset.authenticated ? "authenticated" : "unauthenticated"} GitHub API · up to ${dataset.prsPerRepo} bot PRs per repository`,
    ``,
    `Evaluation time is each PR's creation time (\`proposed@head\`: its head commit time). Variants: \`previous\` = defaults with \`unreadMinimumAgeDays: null\`; \`proposed\` = \`DEFAULT_DEPENDENCY_REVIEW_POLICY\` (age fallback ${DEFAULT_DEPENDENCY_REVIEW_POLICY.unreadMinimumAgeDays} days); \`strict\` = every boolean hold switch on, release risk at \`${VARIANTS.strict.holdAtReleaseRisk}\`. Verdicts come from the production \`decideBump\`.`,
    ``,
    `## Headline`,
    ``,
    `| Variant | PRs | with bumps | held | held (of PRs with bumps) | pass with unvouched bump | holds per held PR (median / p90 / max) |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const name of names) {
    const v = summary.variants[name];
    lines.push(
      `| ${name} | ${v.prs} | ${v.withBumps} | ${v.held} (${pct(v.held, v.prs)}) | ${v.heldWithBumps} (${pct(v.heldWithBumps, v.withBumps)}) | ${v.passUnvouched} (${pct(v.passUnvouched, v.prs)}) | ${trio(v.holdsPerHeld)} |`,
    );
  }
  const reasons = [
    ...new Set(names.flatMap((name) => Object.keys(summary.variants[name].reasonCounts))),
  ].sort();
  lines.push(``, `## Hold reasons (held PRs carrying each reason)`, ``);
  lines.push(
    `| Reason | ${names.join(" | ")} |`,
    `| --- | ${names.map(() => "---").join(" | ")} |`,
  );
  for (const reason of reasons) {
    lines.push(
      `| ${reason} | ${names.map((name) => summary.variants[name].reasonCounts[reason] ?? 0).join(" | ")} |`,
    );
  }
  lines.push(``, `## Per repository (held PRs)`, ``);
  lines.push(
    `| Repository | PRs | with bumps | bumps | ${names.join(" | ")} |`,
    `| --- | --- | --- | --- | ${names.map(() => "---").join(" | ")} |`,
  );
  for (const repo of summary.repos) {
    lines.push(
      `| ${repo.repo} | ${repo.prs} | ${repo.withBumps} | ${repo.bumps} | ${names.map((name) => repo.held[name]).join(" | ")} |`,
    );
  }
  const { ages } = summary;
  const proposed = summary.variants.proposed;
  lines.push(
    ``,
    `## Bumps per PR (PRs with at least one bump)`,
    ``,
    `- All bumps, median / p90 / max: ${trio(summary.bumpsPerPr)}`,
    `- Reviewable (public, with a previous version), median / p90 / max: ${trio(summary.reviewablePerPr)}`,
    `- PRs over ${COLD_DIFFS_PER_PASS} reviewable bumps (the old per-review cap; now cold diffs per pass, so more than one pass when cold): ${summary.over40Reviewable} (${pct(summary.over40Reviewable, summary.bumpsPerPr.n)})`,
    `- PRs over ${MAX_DIFFED_BUMPS} bumps (diffed per review across passes): ${summary.over500} (${pct(summary.over500, summary.bumpsPerPr.n)})`,
    ``,
    `## Target age at PR creation`,
    ``,
    `- Bumps with a known publish time: ${ages.known}; unknown or private: ${ages.unknown}`,
    `- Younger than 1 day: ${ages.under1} (${pct(ages.under1, ages.known)}); 3 days: ${ages.under3} (${pct(ages.under3, ages.known)}); 7 days: ${ages.under7} (${pct(ages.under7, ages.known)})`,
    `- Published after the PR was opened (a later push moved the PR to it): ${ages.negative}`,
    `- \`proposed\` PRs held only by age: ${proposed.ageOnly.prs}; of those ${proposed.ageOnly.untilApproved} hold until approved (unknown publish time). Hours until the last one passes, median / p90 / max: ${trio(proposed.ageOnly.hours, 1)}`,
    ``,
    `## Cold diff cost (unique pairs measured)`,
    ``,
    `Local Node CPU, not Workers CPU. \`cpu\` is the whole process around \`loadPublicPackageDiff\` + \`extractBumpEvidence\`; \`parent\` subtracts the sandbox parses, which run in their own isolate (${SANDBOX_CPU_LIMIT_MS} ms limit each) in production. Pairs whose bytes came from disk have lower wall time than a cold fetch.`,
    ``,
    `| Ecosystem | pairs | CPU ms (median / p90 / max) | parent CPU ms | wall ms | CPU > ${CPU_FLAG_MS} ms | parent > ${CPU_FLAG_MS} ms | a parse > ${SANDBOX_CPU_LIMIT_MS} ms | fetched over network |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  );
  for (const [name, cost] of Object.entries(summary.cost)) {
    lines.push(
      `| ${name} | ${cost.pairs} | ${trio(cost.cpu)} | ${trio(cost.parentCpu)} | ${trio(cost.wall)} | ${cost.over750} (${pct(cost.over750, cost.pairs)}) | ${cost.parentOver750} (${pct(cost.parentOver750, cost.pairs)}) | ${cost.parseOver2000} | ${cost.networkCold} |`,
    );
  }
  lines.push(``, `## Diff outcomes (bumps)`, ``);
  for (const [status, count] of Object.entries(summary.statusCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${status}: ${count}`);
  }
  lines.push(
    ``,
    `- PRs with an unread lockfile: ${summary.unreadLockfilePrs}; PRs whose compare listing hit ${COMPARE_FILE_LIMIT} files: ${summary.incompleteListings}`,
    `- Unread lockfiles by reason: ${
      Object.entries(summary.unreadReasons)
        .map(([reason, count]) => `${reason} ${count}`)
        .join(", ") || "none"
    }${summary.unreadReasons["parse-incomplete"] ? ". Any parse-incomplete on a well-known repository's lockfile more likely means the lockfile layer failed at run time than a malformed file; check the parsers before reading the numbers." : ""}`,
    `- PRs changing a manifest but no parsed lockfile (manifest coverage is not replayed, so these pass here): ${summary.manifestOnlyPrs}`,
  );
  const failures = dataset.prs
    .flatMap((pr) => pr.bumps)
    .filter((bump) => bump.diff.status === "failed" || bump.diff.status === "unsupported");
  if (failures.length) {
    lines.push(``, `### Failed or unsupported diffs`, ``);
    for (const bump of failures.slice(0, 40)) {
      lines.push(
        `- ${bump.ecosystem} ${bump.name} ${bump.fromVersion} → ${bump.toVersion}: ${bump.diff.status}${bump.diff.error ? ` (${bump.diff.error})` : ""}`,
      );
    }
  }
  lines.push(``, `## Held PRs under \`proposed\``, ``);
  for (const row of proposed.rows.filter((r) => r.conclusion === "held")) {
    lines.push(
      `- ${row.pr.repo}#${row.pr.number} (${row.pr.author}, ${row.pr.bumps.length} bumps, ${row.holds} held): ${[...row.reasons].join(", ")} — ${String(row.pr.title).slice(0, 90)}`,
    );
  }
  lines.push(
    ``,
    `## Sample and limits`,
    ``,
    `- Repositories: ${dataset.repositories.join(", ")}`,
    `- Bot PRs listed per repository: ${dataset.listed.map((entry) => `${entry.repo} ${entry.botPulls}`).join(", ") || "none"}`,
    `- PRs replayed: ${summary.complete}; incomplete (budget): ${summary.incomplete}; skipped: ${dataset.skipped.length}`,
    `- PR creation dates: ${summary.dateRange ? `${summary.dateRange[0]} to ${summary.dateRange[1]}` : "n/a"}`,
    `- Run stops: ${dataset.stops.length ? dataset.stops.join("; ") : "none"}`,
    `- The PR file list and merge base come from one compare call per PR (at most ${COMPARE_FILE_LIMIT} files), lockfiles from raw.githubusercontent.com at the merge base and head. Production lists files through the pulls API (up to 3,000) and reads contents through the contents API.`,
    `- Manifest coverage (\`unreadManifests\`), approvals, mirror proofs, the per-pass budgets (eight minutes, ${COLD_DIFFS_PER_PASS} cold diffs), and the KV cache are not replayed: every pair up to the ${MAX_DIFFED_BUMPS}-bump cap is diffed once, cold, as if every pass completed.`,
    `- Publish times come from today's registry metadata; a version unpublished or yanked since reads as unknown.`,
  );
  if (dataset.skipped.length) {
    lines.push(``, `### Skipped`, ``);
    for (const skip of dataset.skipped.slice(0, 60)) {
      lines.push(`- ${skip.repo}${skip.number ? `#${skip.number}` : ""}: ${skip.reason}`);
    }
  }
  return lines.join("\n");
}

export function writeReplayReport(dataset) {
  const summary = summarizeReplay(dataset);
  mkdirSync(REPLAY_DIR, { recursive: true });
  writeFileSync(join(REPLAY_DIR, "dataset.json"), JSON.stringify(dataset, null, 2));
  writeFileSync(join(REPLAY_DIR, "report.md"), renderReport(dataset, summary));
  return summary;
}
