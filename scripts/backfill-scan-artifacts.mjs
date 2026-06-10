#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parsePackageJson } from "../server/lib/tar-parser.js";

const DEFAULT_DATABASE = "staged-publish-review";
const DEFAULT_BUCKET = "staged-publish-review-artifacts";
const DEFAULT_LIMIT = 10;
const ARTIFACT_STORAGE_VERSION = 1;
const ARTIFACT_CONTENT_TYPE = "application/json; charset=utf-8";
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const ENCODER = new TextEncoder();

const SECRET_PATTERNS = [
  [/npm_[A-Za-z0-9]{20,}/g, "[REDACTED_NPM_TOKEN]"],
  [/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_ACCESS_KEY]"],
  [/ASIA[0-9A-Z]{16}/g, "[REDACTED_AWS_SESSION_KEY]"],
  [/AIza[0-9A-Za-z\-_]{35}/g, "[REDACTED_GOOGLE_API_KEY]"],
  [/ya29\.[0-9A-Za-z\-_]{20,}/g, "[REDACTED_GOOGLE_OAUTH_TOKEN]"],
  [/sk_(?:live|test)_[0-9a-zA-Z]{16,}/g, "[REDACTED_STRIPE_KEY]"],
  [/rk_(?:live|test)_[0-9a-zA-Z]{16,}/g, "[REDACTED_STRIPE_KEY]"],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]"],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, "[REDACTED_SLACK_WEBHOOK]"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
  [/\b(?:[A-Za-z]+:\/\/)[^\s/@:]+:[^\s/@]+@[^\s'"\\]+/g, "[REDACTED_URL_WITH_CREDENTIALS]"],
  [
    /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [/(authorization\s*[:=]\s*)['"]?Bearer\s+[A-Za-z0-9._\-+/=]{16,}/gi, "$1[REDACTED_BEARER]"],
  [
    /(?<![A-Za-z0-9])((?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*)['"]?[^'"\s()]{12,}(?=$|[\s'",;}\]])/gi,
    "$1[REDACTED_SECRET]",
  ],
];

export function parseBackfillArgs(argv, env = process.env) {
  const usesExplicitWranglerBin = Boolean(env.WRANGLER_BIN);
  const options = {
    database: env.DRYDOCK_D1_DATABASE || DEFAULT_DATABASE,
    bucket: env.DRYDOCK_ARTIFACT_BUCKET || DEFAULT_BUCKET,
    organizationId: env.DRYDOCK_ORGANIZATION_ID || "",
    allOrganizations: false,
    limit: DEFAULT_LIMIT,
    cursor: "",
    maxBatches: Number.POSITIVE_INFINITY,
    mode: env.DRYDOCK_BACKFILL_LOCAL === "1" ? "local" : "remote",
    config: env.WRANGLER_CONFIG || "",
    environment: env.WRANGLER_ENV || "",
    persistTo: env.WRANGLER_PERSIST_TO || "",
    wranglerBin: env.WRANGLER_BIN || "pnpm",
    wranglerPrefix: usesExplicitWranglerBin ? [] : ["exec", "wrangler"],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (name) => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${name} requires a value`);
      }
      index += 1;
      return value;
    };

    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") return { ...options, help: true };
    if (arg === "--database") {
      options.database = readValue(arg);
    } else if (arg.startsWith("--database=")) {
      options.database = arg.slice("--database=".length);
    } else if (arg === "--bucket") {
      options.bucket = readValue(arg);
    } else if (arg.startsWith("--bucket=")) {
      options.bucket = arg.slice("--bucket=".length);
    } else if (arg === "--organization-id") {
      options.organizationId = readValue(arg);
    } else if (arg.startsWith("--organization-id=")) {
      options.organizationId = arg.slice("--organization-id=".length);
    } else if (arg === "--all-organizations") {
      options.allOrganizations = true;
    } else if (arg === "--limit") {
      options.limit = parsePositiveInteger(arg, readValue(arg));
    } else if (arg.startsWith("--limit=")) {
      options.limit = parsePositiveInteger("--limit", arg.slice("--limit=".length));
    } else if (arg === "--cursor") {
      options.cursor = readValue(arg);
    } else if (arg.startsWith("--cursor=")) {
      options.cursor = arg.slice("--cursor=".length);
    } else if (arg === "--max-batches") {
      options.maxBatches = parsePositiveInteger(arg, readValue(arg));
    } else if (arg.startsWith("--max-batches=")) {
      options.maxBatches = parsePositiveInteger(
        "--max-batches",
        arg.slice("--max-batches=".length),
      );
    } else if (arg === "--remote") {
      options.mode = "remote";
    } else if (arg === "--local") {
      options.mode = "local";
    } else if (arg === "--config" || arg === "-c") {
      options.config = readValue(arg);
    } else if (arg.startsWith("--config=")) {
      options.config = arg.slice("--config=".length);
    } else if (arg === "--env" || arg === "-e") {
      options.environment = readValue(arg);
    } else if (arg.startsWith("--env=")) {
      options.environment = arg.slice("--env=".length);
    } else if (arg === "--persist-to") {
      options.persistTo = readValue(arg);
    } else if (arg.startsWith("--persist-to=")) {
      options.persistTo = arg.slice("--persist-to=".length);
    } else if (arg === "--wrangler-bin") {
      options.wranglerBin = readValue(arg);
      options.wranglerPrefix = [];
    } else if (arg.startsWith("--wrangler-bin=")) {
      options.wranglerBin = arg.slice("--wrangler-bin=".length);
      options.wranglerPrefix = [];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.help) return options;
  if (!options.database) throw new Error("set --database or DRYDOCK_D1_DATABASE");
  if (!options.bucket) throw new Error("set --bucket or DRYDOCK_ARTIFACT_BUCKET");
  if (options.allOrganizations && options.organizationId) {
    throw new Error("--all-organizations cannot be combined with --organization-id");
  }
  if (!options.allOrganizations && !options.organizationId) {
    throw new Error("set --organization-id or --all-organizations");
  }
  if (options.allOrganizations && options.cursor) {
    throw new Error("--cursor is only supported for a single organization run");
  }

  return {
    ...options,
    organizationId: options.organizationId || null,
    cursor: options.cursor || null,
  };
}

export async function runBackfill(options, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const client = createWranglerClient(options, deps);
  const targets = options.allOrganizations
    ? await listOrganizations(client)
    : [{ id: options.organizationId, label: options.organizationId }];

  const totals = emptyTotals();
  for (const target of targets) {
    stdout.write(`scan artifacts: backfilling ${target.label}\n`);
    const result = await drainOrganizationBackfill(client, options, target.id, stdout, stderr);
    addTotals(totals, result);
  }

  stdout.write(
    `scan artifacts: complete scanned=${totals.scanned} backfilled=${totals.backfilled} alreadyBacked=${totals.alreadyBacked} digestMismatch=${totals.digestMismatch} failed=${totals.failed}\n`,
  );

  if (totals.failed > 0) {
    throw new Error(`backfill completed with ${totals.failed} failed row(s)`);
  }

  return totals;
}

function printUsage(stdout = process.stdout) {
  stdout.write(`Usage:
  pnpm run scan-artifacts:backfill -- --organization-id <id> [options]
  pnpm run scan-artifacts:backfill -- --all-organizations [options]

Options:
  --organization-id <id>   Backfill one organization.
  --all-organizations      Backfill every organization in D1.
  --database <name>        D1 database name or binding. Defaults to ${DEFAULT_DATABASE}.
  --bucket <name>          R2 bucket name. Defaults to ${DEFAULT_BUCKET}.
  --limit <n>              Batch size. Defaults to ${DEFAULT_LIMIT}.
  --cursor <id>            Resume a single-organization run from a scan id cursor.
  --max-batches <n>        Stop after n successful batches per organization.
  --remote                 Use remote D1/R2 bindings. Default.
  --local                  Use local Wrangler D1/R2 storage.
  --config <path>          Forward a Wrangler config path.
  --env <name>             Forward a Wrangler environment.
  --persist-to <path>      Forward local Wrangler persistence path.
  --wrangler-bin <path>    Use a specific Wrangler binary instead of "pnpm exec wrangler".

Environment:
  DRYDOCK_D1_DATABASE, DRYDOCK_ARTIFACT_BUCKET, DRYDOCK_ORGANIZATION_ID,
  DRYDOCK_BACKFILL_LOCAL=1, WRANGLER_CONFIG, WRANGLER_ENV, WRANGLER_PERSIST_TO,
  WRANGLER_BIN
`);
}

function createWranglerClient(options, deps) {
  const runWrangler =
    deps.runWrangler ??
    ((args, runOptions = {}) =>
      spawnWrangler(options.wranglerBin, [...options.wranglerPrefix, ...args], runOptions.input));

  return {
    options,
    async d1(sql) {
      const stdout = await runWrangler([
        ...wranglerGlobalArgs(options),
        "d1",
        "execute",
        options.database,
        ...storageArgs(options),
        "--json",
        "--yes",
        "--command",
        sql,
      ]);
      const parsed = parseJson(stdout);
      if (!Array.isArray(parsed)) throw new Error("wrangler d1 execute did not return an array");
      for (const statement of parsed) {
        if (!statement?.success) throw new Error("wrangler d1 execute reported a failed statement");
      }
      const last = parsed.at(-1);
      return Array.isArray(last?.results) ? last.results : [];
    },
    async r2Put(key, body) {
      await runWrangler(
        [
          ...wranglerGlobalArgs(options),
          "r2",
          "object",
          "put",
          `${options.bucket}/${key}`,
          ...storageArgs(options),
          "--pipe",
          "--content-type",
          ARTIFACT_CONTENT_TYPE,
          "--force",
        ],
        { input: body },
      );
    },
    async r2Get(key) {
      return runWrangler([
        ...wranglerGlobalArgs(options),
        "r2",
        "object",
        "get",
        `${options.bucket}/${key}`,
        ...storageArgs(options),
        "--pipe",
      ]);
    },
  };
}

function wranglerGlobalArgs(options) {
  return [
    ...(options.config ? ["--config", options.config] : []),
    ...(options.environment ? ["--env", options.environment] : []),
  ];
}

function storageArgs(options) {
  return [
    options.mode === "local" ? "--local" : "--remote",
    ...(options.persistTo ? ["--persist-to", options.persistTo] : []),
  ];
}

function spawnWrangler(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        const rendered = [command, ...args].join(" ");
        reject(new Error(`${rendered} failed with exit code ${code ?? 1}: ${stderr.trim()}`));
      }
    });
    if (typeof input === "string") child.stdin.end(input);
    else child.stdin.end();
  });
}

async function listOrganizations(client) {
  const rows = await client.d1(
    "SELECT id, name FROM organizations ORDER BY created_at ASC, id ASC",
  );
  if (!rows.length) throw new Error("no organizations found in D1");
  return rows.map((row) => ({
    id: String(row.id),
    label: `${row.name || row.id} (${row.id})`,
  }));
}

async function drainOrganizationBackfill(client, options, organizationId, stdout, stderr) {
  const totals = emptyTotals();
  let cursor = options.cursor;
  let batch = 0;

  do {
    if (batch >= options.maxBatches) {
      stdout.write(`scan artifacts: stopped after --max-batches=${options.maxBatches}\n`);
      return totals;
    }

    batch += 1;
    const page = await listCandidates(client, organizationId, options.limit + 1, cursor);
    const hasMore = page.length > options.limit;
    const candidates = hasMore ? page.slice(0, options.limit) : page;
    const result = {
      scanned: candidates.length,
      backfilled: 0,
      alreadyBacked: 0,
      digestMismatch: 0,
      failed: 0,
      nextCursor: hasMore ? candidates[candidates.length - 1].id : null,
    };

    for (const candidate of candidates) {
      const outcome = await backfillOneScan(client, candidate).catch((err) => {
        stderr.write(
          `scan artifacts: scan=${candidate.id} failed ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return "failed";
      });
      result[outcome] += 1;
    }

    addTotals(totals, result);
    cursor = result.nextCursor;
    stdout.write(
      `scan artifacts: batch=${batch} scanned=${result.scanned} backfilled=${result.backfilled} alreadyBacked=${result.alreadyBacked} digestMismatch=${result.digestMismatch} failed=${result.failed} nextCursor=${cursor || "done"}\n`,
    );
  } while (cursor);

  return totals;
}

async function listCandidates(client, organizationId, limit, cursor) {
  const conditions = [
    `organization_id = ${sqlString(organizationId)}`,
    "status = 'complete'",
    "artifact_storage_version IS NULL",
  ];
  if (cursor) conditions.push(`id > ${sqlString(cursor)}`);
  return client.d1(`
    SELECT
      id,
      stage_id AS stageId,
      organization_id AS organizationId,
      package_name AS packageName,
      staged_version AS stagedVersion,
      previous_version AS previousVersion,
      summary_json AS summaryJson,
      ai_json AS aiJson,
      report_version AS reportVersion,
      report_digest AS reportDigest
    FROM scans
    WHERE ${conditions.join(" AND ")}
    ORDER BY id ASC
    LIMIT ${sqlInteger(limit)}
  `);
}

async function backfillOneScan(client, scan) {
  if (!scan.organizationId || !scan.reportDigest || !scan.reportVersion) return "digestMismatch";

  const [files, findings] = await Promise.all([
    client.d1(`
      SELECT
        path,
        status,
        size,
        sha256,
        flags_json AS flagsJson,
        text_sample AS textSample
      FROM scan_files
      WHERE scan_id = ${sqlString(scan.id)}
      ORDER BY rowid ASC
    `),
    client.d1(`
      SELECT
        id,
        severity,
        file,
        evidence,
        reason,
        line,
        rule_id AS ruleId,
        rule_version AS ruleVersion
      FROM scan_findings
      WHERE scan_id = ${sqlString(scan.id)}
      ORDER BY rowid ASC
    `),
  ]);
  const report = reconstructReport(scan, files, findings);
  if (!report) return "digestMismatch";

  const reportJson = stableJson(report.payload);
  const digest = await sha256Hex(reportJson);
  if (digest !== scan.reportDigest) return "digestMismatch";

  const metadata = await writeScanArtifacts(client, {
    organizationId: scan.organizationId,
    scanId: scan.id,
    reportJson,
    reportDigest: digest,
    files: report.files,
    diff: report.diff,
    generatedAt: report.generatedAt,
  });

  await client.d1(`
    UPDATE scans
    SET
      artifact_storage_version = ${sqlInteger(metadata.artifactStorageVersion)},
      artifact_manifest_key = ${sqlString(metadata.artifactManifestKey)},
      artifact_manifest_digest = ${sqlString(metadata.artifactManifestDigest)},
      artifact_manifest_size = ${sqlInteger(metadata.artifactManifestSize)},
      report_artifact_key = ${sqlString(metadata.reportArtifactKey)},
      file_samples_artifact_key = ${sqlString(metadata.fileSamplesArtifactKey)},
      diff_artifact_key = ${sqlString(metadata.diffArtifactKey)},
      updated_at = ${Date.now()}
    WHERE
      id = ${sqlString(scan.id)}
      AND organization_id = ${sqlString(scan.organizationId)}
      AND status = 'complete'
      AND artifact_storage_version IS NULL
  `);

  const [updated] = await client.d1(`
    SELECT
      artifact_storage_version AS artifactStorageVersion,
      artifact_manifest_key AS artifactManifestKey
    FROM scans
    WHERE id = ${sqlString(scan.id)} AND organization_id = ${sqlString(scan.organizationId)}
    LIMIT 1
  `);
  if (updated?.artifactManifestKey === metadata.artifactManifestKey) return "backfilled";
  if (updated?.artifactStorageVersion !== null && updated?.artifactStorageVersion !== undefined) {
    return "alreadyBacked";
  }
  return "failed";
}

function reconstructReport(scan, files, findings) {
  const summary = readObject(readJsonValue(scan.summaryJson));
  const report = readObject(summary?.report);
  const version = typeof report?.version === "number" ? report.version : scan.reportVersion;
  const rulesVersion = typeof report?.rulesVersion === "string" ? report.rulesVersion : null;
  const generatedAt =
    typeof report?.generatedAt === "string" ? report.generatedAt : new Date().toISOString();
  const baseline = readObject(summary?.baseline);
  const risk = readObject(summary?.risk);
  const safety = readObject(summary?.safety);
  const stagedPublish = readObject(summary?.stagedPublish);
  const packageJsonDiff = readObject(summary?.packageJsonDiff);
  const diff = readDiff(summary?.diff);
  if (!version || !rulesVersion || !baseline || !risk || !safety || !packageJsonDiff || !diff) {
    return null;
  }

  const fileRecords = files.map((file) => ({
    path: String(file.path),
    size: typeof file.size === "number" ? file.size : Number(file.size ?? 0),
    sha256: typeof file.sha256 === "string" ? file.sha256 : "",
    flags: readStringArray(readJsonValue(file.flagsJson)),
    ...(typeof file.textSample === "string" && file.textSample
      ? { textSample: file.textSample }
      : {}),
  }));
  const packageJson = readPackageJsonSummary(fileRecords, scan);
  const annotations = readReportFindingAnnotations(summary?.findingAnnotations, findings);
  if (!annotations) return null;

  return {
    generatedAt,
    files: fileRecords,
    diff,
    payload: {
      version,
      rulesVersion,
      stageId: scan.stageId,
      stagedPublish,
      package: {
        name: scan.packageName,
        stagedVersion: scan.stagedVersion,
        stagedTag: typeof stagedPublish?.tag === "string" ? stagedPublish.tag : null,
        previousVersion: scan.previousVersion,
      },
      baseline,
      fileCount: fileRecords.length,
      previousFileCount: countPreviousFiles(diff),
      packageJson,
      packageJsonDiff,
      diff,
      ruleFindings: findings.map(findingRowToReportFinding),
      findingAnnotations: annotations,
      aiFindings: readJsonValue(scan.aiJson),
      risk,
      safety,
    },
  };
}

function readPackageJsonSummary(files, scan) {
  const parsed = parsePackageJson(files);
  if (parsed) return redactJson(parsed);
  if (!scan.packageName && !scan.stagedVersion) return null;
  return {
    ...(scan.packageName ? { name: scan.packageName } : {}),
    ...(scan.stagedVersion ? { version: scan.stagedVersion } : {}),
  };
}

function readReportFindingAnnotations(value, findings) {
  if (!Array.isArray(value)) return findings.length ? null : [];
  const byId = new Map();
  for (const item of value) {
    const entry = readObject(item);
    if (!entry || typeof entry.id !== "string" || typeof entry.diffStatus !== "string") {
      return null;
    }
    byId.set(entry.id, {
      diffStatus: entry.diffStatus,
      releaseDelta: Boolean(entry.releaseDelta),
    });
  }
  const out = [];
  for (let index = 0; index < findings.length; index += 1) {
    const annotation = byId.get(findings[index].id);
    if (!annotation) return null;
    out.push({ findingIndex: index, ...annotation });
  }
  return out;
}

function findingRowToReportFinding(row) {
  return {
    severity: normalizeSeverity(row.severity),
    file: row.file,
    evidence: row.evidence,
    reason: row.reason,
    ...(row.line !== null && row.line !== undefined ? { line: Number(row.line) } : {}),
    ...(row.ruleId !== null && row.ruleId !== undefined ? { ruleId: row.ruleId } : {}),
    ...(row.ruleVersion !== null && row.ruleVersion !== undefined
      ? { ruleVersion: row.ruleVersion }
      : {}),
  };
}

function normalizeSeverity(value) {
  return value === "critical" ||
    value === "high" ||
    value === "medium" ||
    value === "low" ||
    value === "info"
    ? value
    : "medium";
}

function countPreviousFiles(diff) {
  return diff.filter((entry) => entry.status !== "added").length;
}

function readDiff(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    const entry = readObject(item);
    if (!entry || typeof entry.path !== "string" || typeof entry.status !== "string") return null;
    if (
      entry.status !== "added" &&
      entry.status !== "removed" &&
      entry.status !== "modified" &&
      entry.status !== "unchanged"
    ) {
      return null;
    }
    out.push({
      path: entry.path,
      status: entry.status,
      ...(typeof entry.previousSize === "number" ? { previousSize: entry.previousSize } : {}),
      ...(typeof entry.stagedSize === "number" ? { stagedSize: entry.stagedSize } : {}),
      ...(typeof entry.previousSha256 === "string" ? { previousSha256: entry.previousSha256 } : {}),
      ...(typeof entry.stagedSha256 === "string" ? { stagedSha256: entry.stagedSha256 } : {}),
      flags: readStringArray(entry.flags),
    });
  }
  return out;
}

async function writeScanArtifacts(client, input) {
  const keys = artifactKeys(input.organizationId, input.scanId);
  const files = scanFileRowsForArtifacts(input.files, input.diff);
  const filesJson = stableJson({
    version: ARTIFACT_STORAGE_VERSION,
    scanId: input.scanId,
    files,
  });
  const diffJson = stableJson({
    version: ARTIFACT_STORAGE_VERSION,
    scanId: input.scanId,
    diff: input.diff,
  });

  const descriptors = {
    report: await putVerifiedJson(client, keys.report, input.reportJson, input.reportDigest),
    files: await putVerifiedJson(client, keys.files, filesJson, await sha256Hex(filesJson)),
    diff: await putVerifiedJson(client, keys.diff, diffJson, await sha256Hex(diffJson)),
  };
  const manifest = {
    version: ARTIFACT_STORAGE_VERSION,
    scanId: input.scanId,
    organizationId: input.organizationId,
    generatedAt: input.generatedAt,
    artifacts: {
      report: descriptors.report,
      files: { ...descriptors.files, count: files.length },
      diff: { ...descriptors.diff, count: input.diff.length },
    },
  };
  const manifestJson = stableJson(manifest);
  const manifestDigest = await sha256Hex(manifestJson);
  const manifestDescriptor = await putVerifiedJson(
    client,
    keys.manifest,
    manifestJson,
    manifestDigest,
  );

  return {
    artifactStorageVersion: ARTIFACT_STORAGE_VERSION,
    artifactManifestKey: manifestDescriptor.key,
    artifactManifestDigest: manifestDescriptor.digest,
    artifactManifestSize: manifestDescriptor.size,
    reportArtifactKey: descriptors.report.key,
    fileSamplesArtifactKey: descriptors.files.key,
    diffArtifactKey: descriptors.diff.key,
  };
}

async function putVerifiedJson(client, key, body, digest) {
  const size = utf8Size(body);
  await client.r2Put(key, body);
  const stored = await client.r2Get(key);
  const bytes = ENCODER.encode(stored);
  if (bytes.byteLength !== size) {
    throw new Error(`artifact size mismatch for ${key}`);
  }
  const storedDigest = await sha256Hex(stored);
  if (storedDigest !== digest) {
    throw new Error(`artifact digest mismatch for ${key}`);
  }
  return { key, digest, size, contentType: ARTIFACT_CONTENT_TYPE };
}

function scanFileRowsForArtifacts(files, diff) {
  const diffByPath = new Map(diff.map((entry) => [entry.path, entry]));
  return files.map((file) => {
    const entry = diffByPath.get(file.path);
    return {
      path: file.path,
      status: entry?.status || "unknown",
      size: file.size,
      sha256: file.sha256,
      flagsJson: file.flags,
      textSample: file.textSample || null,
    };
  });
}

function artifactKeys(organizationId, scanId) {
  const base = `orgs/${safeSegment(organizationId)}/scans/${safeSegment(scanId)}/v${ARTIFACT_STORAGE_VERSION}`;
  return {
    report: `${base}/report.json`,
    files: `${base}/files.json`,
    diff: `${base}/diff.json`,
    manifest: `${base}/manifest.json`,
  };
}

function safeSegment(value) {
  return encodeURIComponent(value).replace(/%/g, "~");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function utf8Size(value) {
  return ENCODER.encode(value).byteLength;
}

async function sha256Hex(value) {
  const bytes = typeof value === "string" ? ENCODER.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function redactText(text) {
  return SECRET_PATTERNS.reduce(
    (out, [pattern, replacement]) => out.replace(pattern, replacement),
    text,
  );
}

function redactJson(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactJson(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactJson(nested)]),
    );
  }
  return value;
}

function readObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function readJsonValue(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("response was not valid JSON");
  }
}

function sqlString(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlInteger(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`expected integer, got ${value}`);
  return String(parsed);
}

function parsePositiveInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function emptyTotals() {
  return {
    scanned: 0,
    backfilled: 0,
    alreadyBacked: 0,
    digestMismatch: 0,
    failed: 0,
  };
}

function addTotals(target, source) {
  target.scanned += source.scanned;
  target.backfilled += source.backfilled;
  target.alreadyBacked += source.alreadyBacked;
  target.digestMismatch += source.digestMismatch;
  target.failed += source.failed;
}

function isMain() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  try {
    const options = parseBackfillArgs(process.argv.slice(2));
    if (options.help) {
      printUsage();
      process.exit(EXIT_SUCCESS);
    }
    await runBackfill(options);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(EXIT_FAILURE);
  }
}
