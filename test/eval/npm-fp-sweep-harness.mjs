// Real-package false-positive sweep for the deterministic npm rules.
//
// The benign hard-negative corpus is hand-distilled; this measures the same
// thing against what maintainers actually ship. For each popular package it
// downloads real consecutive releases from the public registry and runs them
// through the production public-diff path: the rendered sandbox parser, then
// buildNpmFindings, redaction, release-delta annotation and the risk breakdown
// with AI review off. A pair that rolls up to >= medium is a candidate false
// positive for triage — not proof of one.
//
// Tarball bytes are hostile evidence. They are only ever parsed by Drydock's
// own sandbox module as data: nothing is extracted to disk, installed,
// imported or executed. Cached archives stay compressed under .context/.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  annotateFindingsWithDiffStatus,
  createPackageDiff,
  DETERMINISTIC_RULES_VERSION,
  redactFileRecords,
  redactFindings,
  redactJson,
  summarizePackageJsonDiff,
} from "../../server/lib/review";
import { computeScanRiskBreakdown } from "../../server/lib/review/risk";
import { buildNpmFindings } from "../../server/lib/ecosystems/npm/findings";
import { compareSemver } from "../../server/lib/ecosystems/npm/registry";
import {
  SANDBOX_MAX_FILES,
  SANDBOX_MAX_STREAM_TAR_BYTES,
  sandboxSource,
} from "../../server/lib/sandbox";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
export const SWEEP_DIR = join(ROOT, ".context", "npm-fp-sweep");
const TARBALL_CACHE = process.env.NPM_FP_SWEEP_CACHE ?? join(SWEEP_DIR, "tarballs");
const REGISTRY = "https://registry.npmjs.org";
const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 };
const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const AI_REVIEW_OFF = {
  status: "unavailable",
  risk: "low",
  releaseAssessment: "not_assessed",
  summary: "AI review is disabled.",
  findings: [],
  requiresManualReview: false,
  model: null,
  reviewerVersion: null,
};
// Mirrors the sandbox `env` the Worker loader hands a published-baseline
// parse (loadSandbox): same caps, unbounded text samples, strip1 root.
const SANDBOX_ENV = {
  NPM_REGISTRY: REGISTRY,
  ARCHIVE_FORMAT: "tgz",
  MAX_FILES: SANDBOX_MAX_FILES,
  MAX_ENTRIES: 20_000,
  MAX_TAR_BYTES: SANDBOX_MAX_STREAM_TAR_BYTES / 10,
  MAX_STREAM_TAR_BYTES: SANDBOX_MAX_STREAM_TAR_BYTES,
  ARCHIVE_DIGEST_ALGORITHMS: "SHA-1",
  MAX_TEXT_SAMPLE_CHARS: 0,
  TAR_ROOT_STRIP: "strip1",
};

let renderedSandbox;
function sandbox() {
  // The same module string production loads into the credentials-free
  // isolate; see test/workers/sandbox-parser-retention.test.ts.
  renderedSandbox ??= new Function(sandboxSource().replace("export default", "return"))();
  return renderedSandbox;
}

export function loadSweepPackages() {
  const groups = JSON.parse(readFileSync(join(__dirname, "npm-fp-sweep-packages.json"), "utf8"));
  const seen = new Set();
  const packages = [];
  for (const [group, names] of Object.entries(groups)) {
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      packages.push({ name, group });
    }
  }
  return packages;
}

async function fetchWithRetry(url, init = {}, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
      if (res.ok) return res;
      if (res.status < 500 && res.status !== 429) {
        throw new Error(`${res.status} ${url}`);
      }
      lastError = new Error(`${res.status} ${url}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
  }
  throw lastError;
}

// The pairs production would review: the latest release against the version
// below it (listVersions' suggestion), then walking further down the same
// ordering for depth > 1. Prereleases are skipped so every pair is a release a
// maintainer actually promoted.
async function resolvePairs(name, depth) {
  const res = await fetchWithRetry(`${REGISTRY}/${name.replace("/", "%2f")}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });
  const metadata = await res.json();
  const latest = metadata["dist-tags"]?.latest;
  if (!latest) return [];
  const versions = Object.keys(metadata.versions ?? {})
    .filter((version) => !version.includes("-") || version === latest)
    .filter((version) => compareSemver(version, latest) <= 0)
    .sort((a, b) => compareSemver(b, a));
  const pairs = [];
  for (let i = 0; i + 1 < versions.length && pairs.length < depth; i += 1) {
    const to = metadata.versions[versions[i]];
    const from = metadata.versions[versions[i + 1]];
    if (!to?.dist?.tarball || !from?.dist?.tarball) continue;
    pairs.push({
      packageName: name,
      fromVersion: versions[i + 1],
      toVersion: versions[i],
      fromTarball: from.dist.tarball,
      toTarball: to.dist.tarball,
    });
  }
  return pairs;
}

function assertRegistryTarball(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "registry.npmjs.org") {
    throw new Error(`refusing non-registry tarball URL ${url}`);
  }
}

async function tarballBytes(url) {
  assertRegistryTarball(url);
  const key = url
    .slice(REGISTRY.length + 1)
    .replace(/[^a-zA-Z0-9._@-]+/g, "_")
    .slice(-200);
  const cached = join(TARBALL_CACHE, key);
  if (existsSync(cached)) return new Uint8Array(readFileSync(cached));
  const res = await fetchWithRetry(url, { headers: { accept: "application/octet-stream" } });
  const bytes = new Uint8Array(await res.arrayBuffer());
  mkdirSync(TARBALL_CACHE, { recursive: true });
  writeFileSync(cached, bytes);
  return bytes;
}

async function parseTarball(bytes) {
  const res = await sandbox().fetch(
    new Request("https://sandbox.local/download", {
      method: "POST",
      body: bytes,
      headers: { "content-type": "application/octet-stream", "x-archive-format": "tgz" },
    }),
    SANDBOX_ENV,
  );
  const body = await res.json();
  if (res.status !== 200) throw new Error(`sandbox ${res.status}: ${body.error}`);
  return body;
}

// loadPublicPackageDiff, minus caching and display metadata.
async function reviewPair(pair) {
  const [fromArchive, toArchive] = await Promise.all([
    tarballBytes(pair.fromTarball).then(parseTarball),
    tarballBytes(pair.toTarball).then(parseTarball),
  ]);
  const fileDiff = createPackageDiff(fromArchive.files, toArchive.files);
  const manifestDiff = redactJson(
    summarizePackageJsonDiff(fromArchive.packageJson ?? null, toArchive.packageJson ?? null),
  );
  const ruleFindings = redactFindings(
    buildNpmFindings({
      staged: {
        files: toArchive.files,
        manifest: toArchive.packageJson ?? null,
        suspiciousTarEntries: toArchive.suspiciousEntries,
      },
      previousFiles: fromArchive.files,
      details: null,
      fileDiff,
      manifestDiff,
      stagedManifestText:
        toArchive.files.find((file) => file.path === "package.json")?.textSample ?? null,
    }),
  );
  const findings = annotateFindingsWithDiffStatus(ruleFindings, fileDiff, {
    previousFiles: redactFileRecords(fromArchive.files),
    stagedFiles: redactFileRecords(toArchive.files),
  });
  const risk = computeScanRiskBreakdown(findings, AI_REVIEW_OFF);
  return {
    packageName: pair.packageName,
    fromVersion: pair.fromVersion,
    toVersion: pair.toVersion,
    fileCount: toArchive.files.length,
    changedFiles: fileDiff.filter((entry) => entry.status !== "unchanged").length,
    risk,
    findings: findings.map((finding) => ({
      ruleId: finding.ruleId,
      severity: finding.severity,
      file: finding.file,
      evidence: String(finding.evidence ?? "").slice(0, 240),
      releaseDelta: finding.releaseDelta ?? null,
      releaseDeltaKind: finding.releaseDeltaKind ?? null,
      diffStatus: finding.diffStatus ?? null,
      line: finding.line ?? null,
      excerpt: lineExcerpt(toArchive.files, finding),
    })),
  };
}

// Triage context for the local report only: the flagged line, clipped so a
// minified bundle does not land in the report whole.
function lineExcerpt(files, finding) {
  if (!finding.line) return null;
  const text = files.find((file) => file.path === finding.file)?.textSample;
  if (typeof text !== "string") return null;
  const line = text.split("\n")[finding.line - 1];
  if (line === undefined) return null;
  return line.length > 300 ? `${line.slice(0, 300)}… [${line.length} chars]` : line;
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

export async function runSweep({ packages, depth = 1, concurrency = 6, onProgress } = {}) {
  const resolved = await mapLimit(packages, concurrency, async (pkg) => {
    try {
      return { pkg, pairs: await resolvePairs(pkg.name, depth) };
    } catch (err) {
      return { pkg, error: String(err?.message ?? err) };
    }
  });
  const errors = resolved
    .filter((entry) => entry.error)
    .map((entry) => ({ packageName: entry.pkg.name, stage: "metadata", error: entry.error }));
  const work = resolved.flatMap((entry) =>
    (entry.pairs ?? []).map((pair) => ({ ...pair, group: entry.pkg.group })),
  );
  let done = 0;
  const reviews = await mapLimit(work, concurrency, async (pair) => {
    try {
      const review = await reviewPair(pair);
      return { ...review, group: pair.group };
    } catch (err) {
      errors.push({
        packageName: pair.packageName,
        stage: `${pair.fromVersion}..${pair.toVersion}`,
        error: String(err?.message ?? err),
      });
      return null;
    } finally {
      done += 1;
      onProgress?.(done, work.length, pair);
    }
  });
  return summarize(reviews.filter(Boolean), errors);
}

function summarize(reviews, errors) {
  const at = (field, min) =>
    reviews.filter((review) => RISK_RANK[review.risk[field]] >= RISK_RANK[min]);
  const ruleCounts = (field) => {
    const counts = {};
    for (const review of at(field, "medium")) {
      const ids = new Set(
        review.findings
          .filter(
            (finding) =>
              SEVERITY_RANK[finding.severity] >= SEVERITY_RANK.medium &&
              (field === "artifactRisk" || finding.releaseDelta === true),
          )
          .map((finding) => finding.ruleId),
      );
      for (const id of ids) counts[id] = (counts[id] ?? 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  };
  return {
    rulesVersion: DETERMINISTIC_RULES_VERSION,
    generatedAt: new Date().toISOString(),
    pairs: reviews.length,
    packages: new Set(reviews.map((review) => review.packageName)).size,
    release: {
      medium: at("releaseRisk", "medium").length,
      high: at("releaseRisk", "high").length,
      critical: at("releaseRisk", "critical").length,
      rules: ruleCounts("releaseRisk"),
    },
    artifact: {
      medium: at("artifactRisk", "medium").length,
      high: at("artifactRisk", "high").length,
      critical: at("artifactRisk", "critical").length,
      rules: ruleCounts("artifactRisk"),
    },
    errors,
    reviews,
  };
}

function pct(n, d) {
  return d ? `${((100 * n) / d).toFixed(1)}%` : "n/a";
}

function renderSweepMarkdown(result) {
  const lines = [
    `# npm false-positive sweep`,
    ``,
    `Rules ${result.rulesVersion} · ${result.pairs} release pairs across ${result.packages} packages · ${result.generatedAt}`,
    ``,
    `| Roll-up | >= medium | >= high | critical |`,
    `| --- | --- | --- | --- |`,
    `| releaseRisk | ${result.release.medium} (${pct(result.release.medium, result.pairs)}) | ${result.release.high} (${pct(result.release.high, result.pairs)}) | ${result.release.critical} |`,
    `| artifactRisk | ${result.artifact.medium} (${pct(result.artifact.medium, result.pairs)}) | ${result.artifact.high} (${pct(result.artifact.high, result.pairs)}) | ${result.artifact.critical} |`,
    ``,
    `## Rules driving release >= medium`,
    ``,
    ...result.release.rules.map(([id, count]) => `- \`${id}\` — ${count} pairs`),
    ``,
    `## Rules driving artifact >= medium`,
    ``,
    ...result.artifact.rules.map(([id, count]) => `- \`${id}\` — ${count} pairs`),
    ``,
    `## Flagged pairs`,
    ``,
  ];
  const flagged = result.reviews
    .filter(
      (review) =>
        RISK_RANK[review.risk.releaseRisk] >= 1 || RISK_RANK[review.risk.artifactRisk] >= 2,
    )
    .sort(
      (a, b) =>
        RISK_RANK[b.risk.releaseRisk] - RISK_RANK[a.risk.releaseRisk] ||
        RISK_RANK[b.risk.artifactRisk] - RISK_RANK[a.risk.artifactRisk],
    );
  for (const review of flagged) {
    lines.push(
      `### ${review.packageName} ${review.fromVersion} → ${review.toVersion} (release ${review.risk.releaseRisk}, artifact ${review.risk.artifactRisk})`,
      ``,
    );
    for (const finding of review.findings.filter(
      (f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK.medium,
    )) {
      const delta = finding.releaseDelta
        ? `delta${finding.releaseDeltaKind ? `:${finding.releaseDeltaKind}` : ""}`
        : "context";
      lines.push(
        `- ${finding.severity} \`${finding.ruleId}\` [${delta}] \`${finding.file}\` — ${finding.evidence.replace(/\s+/g, " ").slice(0, 160)}`,
      );
    }
    lines.push(``);
  }
  if (result.errors.length) {
    lines.push(`## Errors`, ``);
    for (const error of result.errors) {
      lines.push(`- ${error.packageName} (${error.stage}): ${error.error}`);
    }
  }
  return lines.join("\n");
}

export function writeSweepReport(result) {
  mkdirSync(SWEEP_DIR, { recursive: true });
  writeFileSync(join(SWEEP_DIR, "report.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(SWEEP_DIR, "report.md"), renderSweepMarkdown(result));
}
