// Replays real Dependabot/Renovate pull requests through the dependency review
// stages to measure how often the check would hold, and what a cold diff costs.
//
// Collect is the production `collectBumps` itself. Its GitHub reads (the PR
// file listing, the merge-base compare, the contents API) are answered by the
// cached fetch below from the same public data in another shape: one compare
// per PR and raw.githubusercontent.com file reads. Review mirrors
// `runReviewStage` (review-bumps.ts): the production `verifyPublicPin` /
// `verifyMirrorBump` proofs, then `loadPublicPackageDiff` per unique pair run
// one at a time so CPU can be attributed, then the publish-time listing.
// Decide calls the production `decideBump` and the `job.ts` coverage rule
// through `verdictFor` / `concludePull`. The Worker bindings are local
// stand-ins: no KV, no colo cache, and a LOADER that runs the same rendered
// sandbox module `npm-fp-sweep-harness.mjs` uses.
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
import { collectBumps } from "../../server/lib/dependency-review/collect";
import { hasCheckablePin, hasUnreadContent } from "../../server/lib/dependency-review/evidence";
import {
  lockfileKindForPath,
  parseLockfile,
  unpinnedRequirementsChanged,
} from "../../server/lib/dependency-review/lockfiles";
import {
  verifyMirrorBump,
  verifyPublicPin,
} from "../../server/lib/dependency-review/mirror-identity";
import {
  collectionPolicy,
  concludeDependencyReview,
  decideBump,
  extractBumpEvidence,
} from "../../server/lib/dependency-review/policy";
import {
  committedInstallInput,
  resolutionConfigChanged,
  resolutionConfigKind,
} from "../../server/lib/dependency-review/registry-config";
import { ageRecheckAt } from "../../server/lib/dependency-review/recheck";
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

// Namespace reads so a renamed constant falls back instead of failing the import.
const MAX_REVIEWED_BUMPS = render.MAX_STORED_BUMPS ?? 500;
const COLD_DIFFS_PER_PASS = reviewStage.MAX_COLD_DIFFS_PER_PASS ?? 12;
// github.ts's lockfile size cap, and collect.ts's file patterns, used here only
// to say why a path the production collect reported went unread.
const MAX_LOCKFILE_BYTES = 8 * 1024 * 1024;
const UNPARSED_LOCKFILE =
  /(?:^|\/)(?:bun\.lockb?|poetry\.lock|Pipfile\.lock|pdm\.lock|pylock(?:\.[^/]+)?\.toml)$/;
const OTHER_REQUIREMENTS = /\.txt$/;
const NPM_MANIFEST = /(?:^|\/)package\.json$/;
const PYPI_MANIFEST = /(?:^|\/)(?:pyproject\.toml|setup\.cfg|setup\.py|Pipfile|[^/]+\.in)$/;
// GitHub's compare lists at most 300 files.
const COMPARE_FILE_LIMIT = 300;
const REPLAY_POLICY = collectionPolicy(DEFAULT_DEPENDENCY_REVIEW_POLICY);

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
  // API paths no cache entry answered (fetched live, or refused when limited).
  apiMisses: [],
};

// ---------------------------------------------------------------------------
// GitHub reads production makes, answered from the replay's cached shapes.

// PR number to the SHAs its compare is cached under, registered per PR before
// the production collect runs.
const replayPulls = new Map();
const PULL_FILES = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/;
const CONTENTS = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/;
const COMPARE = /^\/repos\/([^/]+)\/([^/]+)\/compare\/([^/]+)$/;

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function translateGithubRead(url) {
  const path = url.pathname;
  let match = PULL_FILES.exec(path);
  if (match) {
    const pr = replayPulls.get(
      `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}#${match[3]}`,
    );
    if (!pr) return null;
    const compare = await githubJson(`/repos/${pr.repo}/compare/${pr.baseSha}...${pr.headSha}`);
    if (!compare) return new Response("not found", { status: 404 });
    // One page, no `Link`: collect reads it as a complete listing; the caller
    // passes a changed-file count that marks a compare at its cap incomplete.
    return jsonResponse(compare.files ?? []);
  }
  match = CONTENTS.exec(path);
  if (match && url.searchParams.get("ref")) {
    const repo = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
    const filePath = match[3].split("/").map(decodeURIComponent).join("/");
    return rawFile(repo, url.searchParams.get("ref"), filePath);
  }
  // Production asks `?per_page=1` for the merge base; the cached compare is
  // the same document.
  match = COMPARE.exec(path);
  if (match && url.search) {
    const repo = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
    const compare = await githubJson(`/repos/${repo}/compare/${decodeURIComponent(match[3])}`);
    return compare ? jsonResponse(compare) : new Response("not found", { status: 404 });
  }
  return null;
}
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
  if (url.hostname === "api.github.com") {
    const translated = await translateGithubRead(url);
    if (translated) return translated;
  }
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
  if (url.hostname === "api.github.com") http.apiMisses.push(url.pathname);
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

function rawFile(repo, ref, path) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return cachedFetch(`https://raw.githubusercontent.com/${repo}/${ref}/${encoded}`, {
    headers: { accept: "*/*" },
  });
}

async function readRepositoryFile(repo, ref, path) {
  const response = await rawFile(repo, ref, path);
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

// The production collect stage over one PR. It reads GitHub through
// `translateGithubRead`; only `review`, `repo`, and `token` of the context are
// read, and the token never leaves (the cached fetch attaches its own).
async function collectPull(pr) {
  const compare = await githubJson(`/repos/${pr.repo}/compare/${pr.baseSha}...${pr.headSha}`);
  if (!compare?.merge_base_commit?.sha) throw new Error("compare unavailable");
  const files = compare.files ?? [];
  const [owner, name] = pr.repo.split("/");
  replayPulls.set(`${pr.repo}#${pr.number}`, pr);
  const context = {
    review: { id: "replay", organizationId: "replay", pullNumber: pr.number, headSha: pr.headSha },
    repo: { owner, name },
    token: "replay",
  };
  // A compare at its file cap may be cut short, like a pulls listing whose
  // count exceeds what it returned.
  const changedFiles = files.length >= COMPARE_FILE_LIMIT ? files.length + 1 : null;
  const collected = await collectBumps(context, pr.baseSha, changedFiles, REPLAY_POLICY);
  const mergeBase = compare.merge_base_commit.sha;
  const unreadReasons = [];
  for (const path of collected.unreadLockfiles) {
    unreadReasons.push({ path, ...(await explainUnread(pr, mergeBase, files, path)) });
  }
  return {
    ...pr,
    mergeBase,
    headCommittedAt: (compare.commits ?? []).at(-1)?.commit?.committer?.date ?? null,
    changedFiles: files.length,
    listingComplete: collected.listingComplete,
    lockfiles: files
      .map((file) => file.filename)
      .filter((path) => lockfileKindForPath(path) || UNPARSED_LOCKFILE.test(path)),
    unreadLockfiles: collected.unreadLockfiles,
    unreadReasons,
    bumps: collected.bumps.map((bump) => ({
      ...bump,
      format: lockfileKindForPath(bump.lockfilePath) ?? "requirements",
    })),
  };
}

/**
 * Why the production collect reported `path` unread. collect.ts returns only
 * paths, so this re-derives the reason from the same files: a format it
 * doesn't parse, resolution config, a manifest no lockfile covers, or a
 * lockfile that is deleted, too large, unpinned, or that the strict parsers
 * did not finish (`parse-incomplete`, which on a real lockfile is a parser
 * regression to look at).
 */
async function explainUnread(pr, mergeBase, files, path) {
  const file = files.find((entry) => entry.filename === path);
  if (UNPARSED_LOCKFILE.test(path)) return { reason: "unparsed-format" };
  const installInput = files.some((entry) =>
    [entry.filename, entry.previous_filename].some(
      (at) => at && committedInstallInput(at) === path,
    ),
  );
  if (installInput) return { reason: "committed-install-input" };
  const configKind = resolutionConfigKind(path);
  if (configKind === "routing" || configKind === "opaque") {
    return { reason: file ? "resolution-config-changed" : "resolution-config-unreadable" };
  }
  if (configKind === "pyproject" && file) {
    const [before, after] = await Promise.all([
      file.status === "added" ? null : readRepositoryFile(pr.repo, mergeBase, path),
      file.status === "removed" ? null : readRepositoryFile(pr.repo, pr.headSha, path),
    ]);
    if (file.status === "renamed" || resolutionConfigChanged(path, before, after)) {
      return { reason: "resolution-config-changed" };
    }
  }
  const kind = lockfileKindForPath(path) ?? (OTHER_REQUIREMENTS.test(path) ? "requirements" : null);
  if (kind && file) {
    if (file.status === "removed") return { reason: "lockfile-deleted", kind };
    const read = async (ref, at) => {
      const text = await readRepositoryFile(pr.repo, ref, at);
      if (typeof text !== "string" || kind !== "yarn") return { text, manifest: null };
      const manifest = await readRepositoryFile(pr.repo, ref, `${dirname(at)}package.json`);
      return { text, manifest: typeof manifest === "string" ? manifest : null };
    };
    const beforePath = file.status === "added" ? null : (file.previous_filename ?? path);
    const [before, after] = await Promise.all([
      beforePath ? read(mergeBase, beforePath) : { text: null, manifest: null },
      read(pr.headSha, path),
    ]);
    if (after.text === null) return { reason: "lockfile-missing-at-head", kind };
    if (before.text === "too-large" || after.text === "too-large") {
      return { reason: "lockfile-too-large", kind };
    }
    const base =
      before.text === null
        ? null
        : parseLockfile(kind, before.text, { manifestText: before.manifest });
    const head = parseLockfile(kind, after.text, { manifestText: after.manifest });
    const sides = [!head.complete && "head", base && !base.complete && "merge base"].filter(
      Boolean,
    );
    if (sides.length > 0) {
      return {
        reason: "parse-incomplete",
        kind,
        sides,
        bytes: { head: after.text.length, base: before.text?.length ?? null },
      };
    }
    if (unpinnedRequirementsChanged(base, head)) return { reason: "unpinned-requirements", kind };
    return { reason: "lockfile-over-cap-or-unexplained", kind };
  }
  if (NPM_MANIFEST.test(path) || PYPI_MANIFEST.test(path)) return { reason: "manifest-uncovered" };
  return { reason: "other" };
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
    result = { status: "served", evidence, files: diff.toFiles.length };
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

// Diffs cached by the name-matching rule's harness carry the added
// dependency names in their evidence. Production evidence no longer has them,
// so they move out of the evidence into `addedNames`, which only the report
// reads (null: not recorded for this pair).
function splitAddedNames(result) {
  if (result.status !== "served") return result;
  const { addedDependencies, ...evidence } = result.evidence;
  const addedNames = evidence.dependenciesAdded === 0 ? [] : (addedDependencies?.names ?? null);
  return { ...result, evidence, addedNames };
}

async function diffFor(bump, deadline) {
  const adapter = getPublicDiffAdapter(bump.ecosystem);
  const file = diffCachePath(pairKey(bump, adapter), adapter);
  const cached = readJsonGz(file);
  if (cached) return splitAddedNames(cached);
  if (Date.now() > deadline) return { status: "not-replayed" };
  const result = await coldDiff(bump);
  // A failure may be transient; a rerun tries it again.
  if (result.status !== "failed") writeJsonGz(file, result);
  return splitAddedNames(result);
}

// ---------------------------------------------------------------------------
// Proofs and outcomes, as `runReviewStage` makes them. `proofPending`,
// `needsPinProof`, `resolveBump`, and `settledOutcome` are module-private in review-bumps.ts and
// copied here without the progress store; the proofs themselves are the
// production functions, reading the public registry through the cached fetch.

const proofs = new Map();

function proofKey(bump) {
  const hashes = bump.mirror
    ? `${bump.mirror.fromHashes?.join(",") ?? ""}>${bump.mirror.toHashes.join(",")}`
    : (bump.pinnedHashes ?? []).join(",");
  return `${bump.mirror ? "mirror" : "pin"}|${bump.ecosystem}|${bump.name}|${bump.fromVersion}|${bump.toVersion}|${hashes}`;
}

function runProof(bump) {
  // An empty pin (the format always writes one, this entry has none usable)
  // proves nothing and is never looked up, as in production.
  if (!hasCheckablePin(bump)) return Promise.resolve(false);
  const key = proofKey(bump);
  if (!proofs.has(key)) {
    const env = { LOADER: loader };
    const ctx = replayContext([]);
    const proof = bump.mirror ? verifyMirrorBump(env, ctx, bump) : verifyPublicPin(env, ctx, bump);
    proofs.set(
      key,
      proof.catch(() => false),
    );
  }
  return proofs.get(key);
}

function proofPending(bump) {
  if (bump.mirror) return true;
  return needsPinProof(bump);
}

// A defined `pinnedHashes`, empty included, must be proven.
function needsPinProof(bump) {
  return bump.pinnedHashes !== undefined && !bump.privateSource;
}

// null: a proof not yet made either way.
function resolveBump(bump, verified) {
  if (bump.mirror) {
    if (verified === undefined) return null;
    if (!verified) return { ...bump, remoteSource: true };
    const { privateSource: _private, mirror: _mirror, remoteSource: _remote, ...rest } = bump;
    return { ...rest, viaMirror: true };
  }
  if (needsPinProof(bump)) {
    if (verified === undefined) return null;
    if (verified) {
      const { pinnedHashes: _pinned, ...rest } = bump;
      return rest;
    }
    return { ...bump, privateSource: true, remoteSource: true };
  }
  return bump;
}

// Every pass completed: no outcome is left pending, so `pastReviewLimit` only
// marks bumps past the per-PR review limit.
function settledOutcome(entry, bump, diff) {
  const { original } = entry;
  if (!entry.reviewable) {
    return {
      kind: "unreviewed",
      reason: original.privateScopePublic
        ? "private-scope-public"
        : original.remoteSource
          ? "remote-source"
          : "private-source",
    };
  }
  if (!entry.inReview) {
    return original.fromVersion === null && !original.mirror && original.pinnedHashes === undefined
      ? {
          kind: "new-package",
          pastReviewLimit: true,
          ...(original.repinned ? { repinned: true } : {}),
          ...(original.buildsFromSource ? { buildsFromSource: true } : {}),
        }
      : { kind: "unreviewed", reason: "over-cap", pastReviewLimit: true };
  }
  if (bump.privateSource) {
    return { kind: "unreviewed", reason: "unverified-pin" };
  }
  if (bump.fromVersion === null) {
    return {
      kind: "new-package",
      ...(bump.repinned ? { repinned: true } : {}),
      ...(bump.buildsFromSource ? { buildsFromSource: true } : {}),
    };
  }
  if (diff.status === "served") {
    return {
      kind: "diffed",
      evidence: diff.evidence,
      lockfilePinsTree: bump.lockfilePinsTree === true,
    };
  }
  if (diff.status === "not-replayed") return null;
  return { kind: "unreviewed", reason: diff.status };
}

// review-bumps.ts `markNewPackage` (module-private): an unreviewed outcome of
// a package new to its lockfile says so.
function markNewPackage(outcome, original) {
  return outcome.kind === "unreviewed" && original.fromVersion === null && !original.repinned
    ? { ...outcome, newPackage: true }
    : outcome;
}

// ---------------------------------------------------------------------------
// Registry publish time of the target version, read as review-bumps.ts
// `publishedAtOf` does: the adapter's version listing (npm `time[version]`,
// PyPI's newest non-yanked upload), matched by the ecosystem's equivalence.

const listings = new Map();
const publishTimes = new Map();

// review-bumps.ts `firstPublishedAtOf` (module-private): the adapter's own
// figure where it has one (PyPI: the earliest non-yanked upload of any file),
// otherwise the earliest publish time the listing reports.
function firstPublishedAtOf(listing) {
  if (listing?.firstPublishedAt) return listing.firstPublishedAt;
  let first = null;
  let firstMs = Number.POSITIVE_INFINITY;
  for (const { publishedAt } of listing?.versions ?? []) {
    const ms = publishedAt ? Date.parse(publishedAt) : Number.NaN;
    if (Number.isFinite(ms) && ms < firstMs) {
      firstMs = ms;
      first = publishedAt;
    }
  }
  return first;
}

// The target version's publish time and the package's first, from one
// listing, as production records them.
async function lookupPublishTime(bump) {
  const adapter = getPublicDiffAdapter(bump.ecosystem);
  if (!adapter) return { publishedAt: null, firstPublishedAt: null };
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
  if (!listing) return { publishedAt: null, firstPublishedAt: null };
  const same = adapter.versionsEquivalent ?? ((a, b) => a === b);
  return {
    publishedAt:
      listing.versions.find((entry) => same(entry.version, bump.toVersion))?.publishedAt ?? null,
    firstPublishedAt: firstPublishedAtOf(listing),
  };
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
        (times) => ({ ...times, lookup: times.publishedAt ? "found" : "missing" }),
        () => ({ publishedAt: null, firstPublishedAt: null, lookup: "failed" }),
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

function outcomeStatus(outcome) {
  if (outcome.kind === "diffed") return "served";
  return outcome.kind === "new-package" ? "new-package" : outcome.reason;
}

// One bump as the dataset records it: the collected fields, the pin and its
// proof, the settled outcome, the evidence, and the cold-diff cost.
function recordBump(entry, result) {
  const { original, resolved } = entry;
  const outcome = markNewPackage(
    settledOutcome(entry, resolved, result ?? { status: "none" }) ?? {
      kind: "unreviewed",
      reason: "not-replayed",
    },
    original,
  );
  const { pinnedHashes, mirror, ...fields } = original;
  const proof = mirror ? "mirror" : needsPinProof(original) ? "pin" : null;
  return {
    ...fields,
    pin: {
      expected: pinnedHashes !== undefined || Boolean(mirror),
      hashes: (pinnedHashes ?? mirror?.toHashes ?? []).length,
      proof,
      proven: proof && entry.inReview ? entry.verified === true : null,
    },
    // A failed pin proof makes the bump a remote source; its name is then
    // never sent to a registry again.
    ...(resolved?.privateSource && !original.privateSource ? { resolvedPrivate: true } : {}),
    outcome,
    diff: { status: outcomeStatus(outcome), ...(result?.error ? { error: result.error } : {}) },
    ...(outcome.kind === "diffed"
      ? { evidence: outcome.evidence, addedNames: result?.addedNames ?? null }
      : {}),
    ...(result?.cost ? { cost: result.cost } : {}),
  };
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
    if (http.apiMisses.length > 0) {
      stops.push(`${http.apiMisses.length} GitHub API reads were not in the cache`);
    }

    // Entries in collect order (direct first), as `runReviewStage` builds them:
    // only the first `MAX_STORED_BUMPS` reviewable bumps get proofs, diffs,
    // and publish times.
    for (const pr of prs) {
      let reviewable = 0;
      pr.entries = pr.bumps.map((original) => {
        const isReviewable = !original.privateSource || Boolean(original.mirror);
        const inReview = isReviewable && reviewable < MAX_REVIEWED_BUMPS;
        if (isReviewable) reviewable += 1;
        return { original, reviewable: isReviewable, inReview };
      });
    }
    const toProve = prs.flatMap((pr) =>
      pr.entries.filter((entry) => entry.inReview && proofPending(entry.original)),
    );
    log(`proving ${toProve.length} pinned or mirrored bumps`);
    await mapLimit(toProve, 8, async (entry) => {
      entry.verified = await runProof(entry.original);
    });

    const unique = new Map();
    for (const pr of prs) {
      for (const entry of pr.entries) {
        entry.resolved = resolveBump(entry.original, entry.verified);
        const bump = entry.resolved;
        if (!entry.inReview || !bump || bump.privateSource || bump.fromVersion === null) continue;
        entry.pairKey = pairKey(bump, getPublicDiffAdapter(bump.ecosystem));
        if (!unique.has(entry.pairKey)) unique.set(entry.pairKey, bump);
      }
    }
    const pairs = [...unique.entries()];
    log(`diffing ${pairs.length} unique pairs (sequential, for CPU attribution)`);
    const results = new Map();
    let done = 0;
    for (const [key, bump] of pairs) {
      results.set(key, await diffFor(bump, deadline));
      done += 1;
      if (done % 100 === 0 || done === pairs.length) log(`diffs ${done}/${pairs.length}`);
    }
    if (Date.now() > deadline) stops.push("time budget reached during diffs; rerun to resume");

    for (const pr of prs) {
      pr.bumps = pr.entries.map((entry) => recordBump(entry, results.get(entry.pairKey)));
      delete pr.entries;
    }

    const lookups = prs.flatMap((pr) => pr.bumps);
    log(`publish times for ${lookups.length} bumps`);
    await mapLimit(lookups, 8, async (bump) => {
      if (bump.outcome.pastReviewLimit) {
        bump.publish = { publishedAt: null, lookup: "past-review-limit" };
        return;
      }
      const key = `${bump.ecosystem}|${bump.name}|${bump.toVersion}`;
      if (Date.now() > deadline && !bump.privateSource && !publishTimes.has(key)) {
        bump.publish = { publishedAt: null, lookup: "not-replayed" };
        return;
      }
      bump.publish = await publishTimeFor(
        bump.resolvedPrivate ? { ...bump, privateSource: true } : bump,
      );
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
    apiMisses: [...new Set(http.apiMisses)],
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
function verdictFor(bump, policy, nowMs, partial, oldRule = false) {
  const outcome = outcomeFor(bump, partial);
  if (!oldRule) return decideBump(outcome, policy, nowMs);
  // The rule before the young-package one, which production no longer has a
  // switch for: a reviewed release that declares a new dependency holds for
  // `dependency-added` (an outcome that does not say its lockfile pins the
  // tree reads as unpinned, which holds whenever `dependenciesAdded > 0`),
  // and a package new to the lockfile is judged by the age fallback alone.
  if (outcome.kind === "diffed") {
    const { lockfilePinsTree: _pins, coverageIncomplete: _partial, ...rest } = outcome;
    return decideBump(rest, policy, nowMs);
  }
  return decideBump(outcome, { ...policy, holdOnNewDependencies: false }, nowMs);
}

// The outcome as job.ts decides it: the publish time on every kind, on a new
// package its first publish time too, and on a diffed bump whether the review
// was partial (job.ts adds `coverageIncomplete`).
function outcomeFor(bump, partial) {
  const publishedAt = bump.publish?.publishedAt ?? null;
  if (bump.outcome.kind === "new-package") {
    return {
      ...bump.outcome,
      publishedAt,
      firstPublishedAt: bump.publish?.firstPublishedAt ?? null,
    };
  }
  if (bump.outcome.kind === "diffed" && partial) {
    return { ...bump.outcome, publishedAt, coverageIncomplete: true };
  }
  return { ...bump.outcome, publishedAt };
}

// job.ts's conclusion, without approvals: unread coverage (an unread lockfile,
// manifest, or resolution config, or a cut-short listing) holds whenever the
// age fallback is on or `holdOnUnreviewed` is (`heldOnCoverage`).
// `oldRule`: the rule before the young-package one (see `verdictFor`).
function concludePull(pr, policy, nowMs, oldRule = false) {
  const partial = pr.unreadLockfiles.length > 0 || !pr.listingComplete;
  const reviewed = pr.bumps.map((bump) => ({
    bump,
    verdict: verdictFor(bump, policy, nowMs, partial, oldRule),
    approved: false,
  }));
  let conclusion = concludeDependencyReview(reviewed);
  const heldOnCoverage =
    partial && (policy.holdOnUnreviewed || policy.unreadMinimumAgeDays !== null);
  if (heldOnCoverage && conclusion !== "held") conclusion = "held";
  const recheckAt = ageRecheckAt(reviewed, conclusion, heldOnCoverage);
  return { conclusion, reviewed, heldOnCoverage, recheckAt };
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

function evaluateVariant(prs, policy, clock, oldRule = false) {
  const rows = prs.map((pr) => {
    const nowMs = clock(pr);
    const { conclusion, reviewed, heldOnCoverage, recheckAt } = concludePull(
      pr,
      policy,
      nowMs,
      oldRule,
    );
    const holds = reviewed.filter(({ verdict }) => verdict.status === "hold");
    const reasons = new Set(holds.flatMap(({ verdict }) => verdict.reasons));
    const triggers = new Set(holds.flatMap(({ verdict }) => holdTriggers(verdict)));
    if (heldOnCoverage) {
      reasons.add("unread-coverage");
      triggers.add("unread-coverage");
    }
    const unreadOptions = { nativeAddedHeld: policy.holdOnNativeBinaries };
    const unvouched = reviewed.filter(
      ({ verdict }) =>
        verdict.status === "unreviewed" ||
        verdict.status === "new-package" ||
        (verdict.status === "clear" && hasUnreadContent(verdict.evidence, unreadOptions)),
    ).length;
    const ageOnly = conclusion === "held" && [...reasons].every((reason) => reason === "too-new");
    let passesInHours = null;
    if (ageOnly) {
      const times = holds.map(({ verdict }) => verdict.passesAt);
      passesInHours = times.every(Boolean)
        ? (Math.max(...times.map((time) => Date.parse(time))) - nowMs) / 3_600_000
        : Infinity;
    }
    return {
      pr,
      conclusion,
      holds: holds.length,
      reasons,
      triggers,
      bumpTriggers: holds.flatMap(({ verdict }) => holdTriggers(verdict)),
      heldOnCoverage,
      coverageOnly: heldOnCoverage && holds.length === 0,
      pinOnly:
        holds.length > 0 &&
        !heldOnCoverage &&
        [...triggers].every((trigger) => trigger.endsWith(":unverified-pin")),
      unvouched,
      ageOnly,
      passesInHours,
      // Held with nothing a recheck lifts: someone has to approve or push.
      needsPerson: conclusion === "held" && recheckAt === null,
      nowMs,
      reviewed,
    };
  });
  const withBumps = rows.filter((row) => row.pr.bumps.length > 0);
  const held = rows.filter((row) => row.conclusion === "held");
  const reasonCounts = {};
  const triggerCounts = {};
  for (const row of held) {
    for (const reason of row.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    for (const trigger of row.triggers) triggerCounts[trigger] = (triggerCounts[trigger] ?? 0) + 1;
  }
  const bumpTriggers = {};
  for (const row of rows) {
    for (const trigger of row.bumpTriggers)
      bumpTriggers[trigger] = (bumpTriggers[trigger] ?? 0) + 1;
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
    triggerCounts,
    bumpTriggers,
    coverageOnly: rows.filter((row) => row.conclusion === "held" && row.coverageOnly).length,
    pinOnly: rows
      .filter((row) => row.conclusion === "held" && row.pinOnly)
      .map((row) => `${row.pr.repo}#${row.pr.number}`),
    heldOnCoverage: rows.filter((row) => row.heldOnCoverage).length,
    bySize: sizeBuckets(rows),
    ageOnly: {
      prs: ageWaits.length,
      untilApproved: ageWaits.filter((hours) => hours === Infinity).length,
      hours: spread(ageWaits.filter((hours) => hours !== Infinity)),
    },
    rows,
  };
}

const SIZE_BUCKETS = [
  ["1", 1, 1],
  ["2-5", 2, 5],
  ["6-20", 6, 20],
  ["21+", 21, Infinity],
];

// PRs with bumps by size: passing, held only until an age recheck lifts it,
// or held for a person.
function sizeBuckets(rows) {
  return SIZE_BUCKETS.map(([label, min, max]) => {
    const inBucket = rows.filter((row) => row.pr.bumps.length >= min && row.pr.bumps.length <= max);
    const held = inBucket.filter((row) => row.conclusion === "held");
    const person = held.filter((row) => row.needsPerson).length;
    return {
      label,
      prs: inBucket.length,
      pass: inBucket.length - held.length,
      timer: held.length - person,
      person,
    };
  });
}

const YOUNG_CLASS = {
  "first-published": "young package",
  "version-published": "young version",
  "age-unknown": "age unknown",
  "no-verdict": "no verdict",
  "built-from-source": "built from source",
};

// PyPI names compare by PEP 503; npm names as written.
function sameName(ecosystem, a, b) {
  if (ecosystem !== "pypi") return a === b;
  const norm = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");
  return norm(a) === norm(b);
}

/**
 * The young-package and `dependency-added` holds of the current rule (`after`)
 * against the old one (`before`): `dependency-added` counts on both sides, and
 * for every young-package hold its cause, its ages at the decision time, how
 * it entered the lockfile (declared by a release the PR diffs, a direct
 * dependency, or neither), and what the old rule decided for it.
 */
function youngPackageShift(before, after) {
  const holds = (verdict, reason) => verdict.status === "hold" && verdict.reasons.includes(reason);
  let depsBefore = 0;
  let depsAfter = 0;
  const young = [];
  after.rows.forEach((row, index) => {
    const old = before.rows[index];
    const ageDays = (iso) =>
      iso && Number.isFinite(Date.parse(iso)) ? (row.nowMs - Date.parse(iso)) / DAY_MS : null;
    row.reviewed.forEach(({ bump, verdict }, at) => {
      if (holds(old.reviewed[at].verdict, "dependency-added")) depsBefore += 1;
      if (holds(verdict, "dependency-added")) depsAfter += 1;
      if (!holds(verdict, "young-package")) return;
      const declaredBy = row.pr.bumps
        .filter(
          (other) =>
            other.ecosystem === bump.ecosystem &&
            other.addedNames?.some((name) => sameName(bump.ecosystem, name, bump.name)),
        )
        .map((other) => `${other.name}@${other.toVersion}`);
      const namesUnknown = row.pr.bumps.some(
        (other) => other.ecosystem === bump.ecosystem && other.addedNames === null,
      );
      const otherNew = row.pr.bumps.filter(
        (other) =>
          other !== bump &&
          other.ecosystem === bump.ecosystem &&
          other.fromVersion === null &&
          !other.repinned,
      ).length;
      const oldVerdict = old.reviewed[at].verdict;
      young.push({
        pr: `${row.pr.repo}#${row.pr.number}`,
        bump: `${bump.ecosystem} ${bump.name}@${bump.toVersion}`,
        cause: YOUNG_CLASS[verdict.young?.why] ?? String(verdict.young?.why),
        unreviewed: verdict.unreviewed ?? null,
        firstPublishedDays: ageDays(bump.publish?.firstPublishedAt),
        versionDays: ageDays(bump.publish?.publishedAt),
        entered: declaredBy.length
          ? `declared by ${declaredBy.join(", ")}`
          : bump.direct
            ? "direct dependency"
            : otherNew > 0
              ? `transitive, under another new package (${otherNew} in the PR)`
              : namesUnknown
                ? "not matched (a diffed release's names unrecorded)"
                : "not declared by any diffed release (alias or other path)",
        oldRule:
          oldVerdict.status === "hold"
            ? oldVerdict.reasons.join("+")
            : `passes (${oldVerdict.status})`,
      });
    });
  });
  return { depsBefore, depsAfter, young };
}

// What put a held bump on hold, finer than `verdict.reasons`: an age hold is
// split by what left the bump unvouched (an unread diff, a new package, or the
// unreviewed reason such as `unverified-pin`), and a strict `unreviewed` hold
// keeps its reason.
function holdTriggers(verdict) {
  return verdict.reasons.map((reason) => {
    if (reason === "too-new") {
      if (verdict.unreviewed) return `too-new:${verdict.unreviewed}`;
      return verdict.evidence ? "too-new:unread-content" : "too-new:new-package";
    }
    if (reason === "unreviewed") return `unreviewed:${verdict.unreviewed}`;
    if (reason === "young-package") return `young-package:${verdict.young?.why}`;
    return reason;
  });
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
  variants["proposed-old-deps"] = evaluateVariant(complete, VARIANTS.proposed, createdClock, true);
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
    overPassReviewable: withBumps.filter((pr) => reviewable(pr) > COLD_DIFFS_PER_PASS).length,
    over500: withBumps.filter((pr) => pr.bumps.length > MAX_REVIEWED_BUMPS).length,
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
    pins: pinCounts(bumps.map(({ bump }) => bump)),
    failedProofs: bumps
      .filter(({ bump }) => bump.pin?.proven === false)
      .map(({ pr, bump }) => ({
        pr: `${pr.repo}#${pr.number}`,
        format: bump.format,
        name: bump.name,
        from: bump.fromVersion,
        to: bump.toVersion,
        hashes: bump.pin.hashes,
        proof: bump.pin.proof,
      })),
    repinned: bumps.filter(({ bump }) => bump.repinned).length,
    unverifiedPins: bumps.filter(({ bump }) => bump.outcome?.reason === "unverified-pin").length,
    coverageOnly: Object.fromEntries(
      Object.entries(variants).map(([name, variant]) => [
        name,
        variant.rows
          .filter((row) => row.conclusion === "held" && row.coverageOnly)
          .map((row) => ({
            pr: `${row.pr.repo}#${row.pr.number}`,
            listingComplete: row.pr.listingComplete,
            unread: row.pr.unreadReasons,
          })),
      ]),
    ),
    youngShift: youngPackageShift(variants["proposed-old-deps"], variants.proposed),
    parseIncomplete: complete.flatMap((pr) =>
      pr.unreadReasons
        .filter((entry) => entry.reason === "parse-incomplete")
        .map((entry) => ({ pr: `${pr.repo}#${pr.number}`, ...entry })),
    ),
  };
}

// Per lockfile format: bumps with no pin, a public pin proven or not against
// the public registry, a mirror proof, and pins on a private source (never
// proven: the name is not sent to a public registry).
function pinCounts(bumps) {
  const counts = {};
  for (const bump of bumps) {
    const row = (counts[bump.format] ??= {
      bumps: 0,
      noPin: 0,
      pinned: 0,
      unusable: 0,
      proven: 0,
      failed: 0,
      pastLimit: 0,
      mirror: 0,
      mirrorProven: 0,
      privatePinned: 0,
    });
    row.bumps += 1;
    const pin = bump.pin ?? { hashes: 0, proof: null, proven: null };
    if (pin.proof === "pin" && pin.hashes === 0) {
      row.unusable += 1;
    } else if (pin.proof === "pin") {
      row.pinned += 1;
      if (pin.proven === true) row.proven += 1;
      else if (pin.proven === false) row.failed += 1;
      else row.pastLimit += 1;
    } else if (pin.proof === "mirror") {
      row.mirror += 1;
      if (pin.proven === true) row.mirrorProven += 1;
    } else if (pin.hashes > 0) {
      row.privatePinned += 1;
    } else {
      row.noPin += 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Report.

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
const num = (value, digits = 0) =>
  value === null || value === undefined ? "–" : Number(value).toFixed(digits);
const trio = (s, digits = 0) =>
  `${num(s.median, digits)} / ${num(s.p90, digits)} / ${num(s.max, digits)}`;

function renderReport(dataset, summary) {
  const order = ["previous", "proposed-old-deps", "proposed", "strict", "proposed@head"];
  const names = [
    ...order.filter((name) => summary.variants[name]),
    ...Object.keys(summary.variants).filter((name) => !order.includes(name)),
  ];
  const lines = [
    `# Dependency review replay`,
    ``,
    `${dataset.generatedAt} · ${summary.complete} PRs replayed across ${summary.repos.length} repositories · ${summary.totalBumps} bumps (npm ${summary.ecosystems.npm}, PyPI ${summary.ecosystems.pypi}) · ${dataset.authenticated ? "authenticated" : "unauthenticated"} GitHub API · up to ${dataset.prsPerRepo} bot PRs per repository`,
    ``,
    `Evaluation time is each PR's creation time (\`proposed@head\`: its head commit time). Variants: \`previous\` = defaults with \`unreadMinimumAgeDays: null\`; \`proposed\` = \`DEFAULT_DEPENDENCY_REVIEW_POLICY\` (age fallback ${DEFAULT_DEPENDENCY_REVIEW_POLICY.unreadMinimumAgeDays} days); \`strict\` = every boolean hold switch on, release risk at \`${VARIANTS.strict.holdAtReleaseRisk}\`. \`proposed-old-deps\` = \`proposed\` under the rule before \`young-package\`, computed in this harness because production has no switch for it: a diffed release with \`dependenciesAdded > 0\` holds for \`dependency-added\`, and a package new to the lockfile is judged by the 3-day age fallback alone. Every other variant is production at HEAD. Verdicts come from the production \`decideBump\`.`,
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
  const triggers = [
    ...new Set(
      names.flatMap((name) => [
        ...Object.keys(summary.variants[name].triggerCounts),
        ...Object.keys(summary.variants[name].bumpTriggers),
      ]),
    ),
  ].sort();
  lines.push(
    ``,
    `## Hold triggers (held PRs / held bumps)`,
    ``,
    `\`too-new:*\` splits the age fallback by what left the bump unvouched: \`unread-content\` (a diff with unread files or an unheld added native binary), \`new-package\`, or the unreviewed reason (\`unverified-pin\`, \`not-found\`, \`over-cap\`, ...). \`unread-coverage\` is the \`job.ts\` rule: an unread lockfile, changed resolution config, uncovered manifest, or cut-short listing holds the PR when \`unreadMinimumAgeDays\` is set or \`holdOnUnreviewed\` is on. \`coverage only\` counts held PRs with no held bump.`,
    ``,
    `| Trigger | ${names.join(" | ")} |`,
    `| --- | ${names.map(() => "---").join(" | ")} |`,
  );
  for (const trigger of triggers) {
    lines.push(
      `| ${trigger} | ${names
        .map((name) => {
          const v = summary.variants[name];
          return `${v.triggerCounts[trigger] ?? 0} / ${v.bumpTriggers[trigger] ?? 0}`;
        })
        .join(" | ")} |`,
    );
  }
  lines.push(
    `| coverage only (PRs) | ${names.map((name) => summary.variants[name].coverageOnly).join(" | ")} |`,
  );
  const shift = summary.youngShift;
  const fallbackToo = shift.young.filter((entry) => entry.oldRule.startsWith("too-new"));
  lines.push(
    ``,
    `## \`young-package\` and \`dependency-added\` (\`proposed\` against \`proposed-old-deps\`)`,
    ``,
    `Held bumps with \`dependency-added\`: ${shift.depsBefore} under the old rule, ${shift.depsAfter} now. Held bumps with \`young-package\`: ${shift.young.length}; the 3-day age fallback alone (old rule) also holds ${fallbackToo.length}, only the new rule holds ${shift.young.length - fallbackToo.length}.`,
    ``,
    `Ages are days before PR creation. \`entered\`: how the package reached the lockfile, from the added dependency names recorded for each diffed release by the earlier name-matching harness (kept outside the evidence).`,
    ``,
    `| PR | package | cause | first published (d) | version (d) | entered | old rule |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
  );
  for (const entry of shift.young) {
    lines.push(
      `| ${entry.pr} | ${entry.bump} | ${entry.cause}${entry.unreviewed ? ` (${entry.unreviewed})` : ""} | ${num(entry.firstPublishedDays, 1)} | ${num(entry.versionDays, 1)} | ${entry.entered} | ${entry.oldRule} |`,
    );
  }
  lines.push(
    ``,
    `## Who has to act, by PR size (PRs with bumps)`,
    ``,
    `\`timer\` = held, and an age recheck (\`ageRecheckAt\`) lifts every hold; \`person\` = held with something only an approval or a push clears.`,
    ``,
    `| Variant | ${SIZE_BUCKETS.map(([label]) => `${label} bump${label === "1" ? "" : "s"}: PRs · pass · timer · person`).join(" | ")} |`,
    `| --- | ${SIZE_BUCKETS.map(() => "---").join(" | ")} |`,
  );
  for (const name of names) {
    lines.push(
      `| ${name} | ${summary.variants[name].bySize
        .map(
          (b) =>
            `${b.prs} · ${b.pass} · ${b.timer} (${pct(b.timer, b.prs)}) · ${b.person} (${pct(b.person, b.prs)})`,
        )
        .join(" | ")} |`,
    );
  }
  lines.push(``, `## Pin proofs (bumps, by lockfile format)`, ``);
  lines.push(
    `A public bump that pins hashes is diffed only after \`verifyPublicPin\` proves a pinned hash is the public release's; a failed proof is \`unverified-pin\`. Re-pins (same version, new hash): ${summary.repinned}. Bumps settled as \`unverified-pin\`: ${summary.unverifiedPins}.`,
    ``,
    `| Format | bumps | no pin by design | pin expected but unusable | public pin | proven | failed | past review limit | mirror | mirror proven | pinned, private source |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  );
  for (const [format, c] of Object.entries(summary.pins).sort()) {
    lines.push(
      `| ${format} | ${c.bumps} | ${c.noPin} | ${c.unusable} | ${c.pinned} | ${c.proven} | ${c.failed} | ${c.pastLimit} | ${c.mirror} | ${c.mirrorProven} | ${c.privatePinned} |`,
    );
  }
  if (summary.failedProofs.length > 0) {
    lines.push(``, `Failed proofs (an empty pin fails without a lookup):`, ``);
    for (const entry of summary.failedProofs) {
      lines.push(
        `- ${entry.pr} ${entry.format} ${entry.name} ${entry.from ?? "(new)"} → ${entry.to}: ${entry.hashes} pinned hash${entry.hashes === 1 ? "" : "es"} (${entry.proof})`,
      );
    }
  }
  lines.push(
    ``,
    `PRs held only on an unverified pin under \`proposed\`: ${summary.variants.proposed.pinOnly.join(", ") || "none"}`,
  );
  lines.push(``, `## PRs held only by unread coverage under \`proposed\``, ``);
  const coverageOnly = summary.coverageOnly.proposed;
  if (coverageOnly.length === 0) lines.push(`None.`);
  for (const entry of coverageOnly) {
    const files = entry.unread.map(
      (item) => `\`${item.path}\` (${item.reason}${item.kind ? `, ${item.kind}` : ""})`,
    );
    if (!entry.listingComplete) files.push("cut-short file listing");
    lines.push(`- ${entry.pr}: ${files.join(", ")}`);
  }
  lines.push(``, `## Lockfiles the strict parsers call incomplete`, ``);
  if (summary.parseIncomplete.length === 0) lines.push(`None.`);
  for (const entry of summary.parseIncomplete) {
    lines.push(
      `- ${entry.pr} \`${entry.path}\` (${entry.kind}): incomplete at ${entry.sides.join(" and ")}; ${entry.bytes.head} bytes at head, ${entry.bytes.base ?? "–"} at the merge base`,
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
    `- PRs over ${COLD_DIFFS_PER_PASS} reviewable bumps (cold diffs per pass, so more than one pass when the cache is cold): ${summary.overPassReviewable} (${pct(summary.overPassReviewable, summary.bumpsPerPr.n)})`,
    `- PRs over ${MAX_REVIEWED_BUMPS} bumps (the review limit; later bumps are \`pastReviewLimit\`): ${summary.over500} (${pct(summary.over500, summary.bumpsPerPr.n)})`,
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
    `- GitHub API reads missing from the cache: ${dataset.apiMisses?.length ? dataset.apiMisses.slice(0, 20).join(", ") : "none"}`,
    `- Collection is the production \`collectBumps\` (lockfile diff, routing, pins, re-pins, resolution config, manifest coverage). Its GitHub reads are answered from one cached compare call per PR (at most ${COMPARE_FILE_LIMIT} files; a compare at the cap counts as a cut-short listing) and raw.githubusercontent.com reads at the merge base and head. Production lists files through the pulls API (up to 3,000) and reads through the contents API.`,
    `- Pin proofs are the production \`verifyPublicPin\` / \`verifyMirrorBump\` over anonymous public metadata. Approvals, the per-pass budgets (eight minutes, ${COLD_DIFFS_PER_PASS} cold diffs), and the KV cache are not replayed: every pair up to the ${MAX_REVIEWED_BUMPS}-bump review limit is diffed once, cold, as if every pass completed.`,
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
