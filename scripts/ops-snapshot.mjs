#!/usr/bin/env node
// Operator-only aggregate snapshot of production D1. Runs a fixed set of
// read-only, AGGREGATE-ONLY queries via `wrangler d1 execute --remote --json`
// and writes a timestamped JSON report to ~/.drydock-ops/snapshots/.
//
// HARD RULES (the repo is public; ops output must be unattributable):
// - Queries and output must never contain customer, organization, user,
//   package, or stage identifiers. Enforced by assertAggregateOnly() and
//   assertRowShape() below, plus tests in test/ops-snapshot.test.mjs.
// - The report must never land inside the repository. Enforced by
//   resolveSnapshotDir().
// - Never runs in verify/CI: it is only reachable via `pnpm run ops:snapshot`.
//
// Usage:
//   pnpm run ops:snapshot                     # remote prod D1 (wrangler auth)
//   pnpm run ops:snapshot -- --local          # local D1 (validation/dev)
//   pnpm run ops:snapshot -- --config <path> --persist-to <path>
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DATABASE = "staged-publish-review";
// Milliseconds-since-epoch cutoff for "last 14 days", computed in SQL so the
// snapshot reflects D1's clock, not the operator's machine.
const FOURTEEN_DAYS_SQL = "(CAST(strftime('%s', 'now', '-14 days') AS INTEGER) * 1000)";

// Every query is a plain aggregate SELECT. Result columns may only be product
// dimensions (day, source, status, decision, rule id, event type, error code)
// plus counts — never identifiers.
export const SNAPSHOT_QUERIES = [
  {
    name: "scan_volume_by_day_14d",
    columns: ["day", "scans"],
    sql: `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS scans FROM scans WHERE created_at >= ${FOURTEEN_DAYS_SQL} GROUP BY day ORDER BY day ASC`,
  },
  {
    // The scans table has no ecosystem column; ecosystem is derived from
    // source + summary JSON at read time (server/db). `source` is the closest
    // schema-level split (manual / discovery / workflow_gate ...).
    name: "scans_by_source",
    columns: ["source", "scans"],
    sql: "SELECT source, COUNT(*) AS scans FROM scans GROUP BY source ORDER BY scans DESC",
  },
  {
    name: "scans_by_status",
    columns: ["status", "scans"],
    sql: "SELECT status, COUNT(*) AS scans FROM scans GROUP BY status ORDER BY scans DESC",
  },
  {
    name: "finding_counts_by_rule",
    columns: ["ruleId", "source", "findings"],
    sql: "SELECT COALESCE(rule_id, '(none)') AS ruleId, source, COUNT(*) AS findings FROM scan_findings GROUP BY rule_id, source ORDER BY findings DESC",
  },
  {
    name: "gate_decisions_by_outcome",
    columns: ["status", "decision", "gates"],
    sql: "SELECT status, COALESCE(decision, '(none)') AS decision, COUNT(*) AS gates FROM github_workflow_gates GROUP BY status, decision ORDER BY gates DESC",
  },
  {
    name: "scan_events_by_type_14d",
    columns: ["type", "events"],
    sql: `SELECT type, COUNT(*) AS events FROM scan_events WHERE created_at >= ${FOURTEEN_DAYS_SQL} GROUP BY type ORDER BY events DESC`,
  },
  {
    name: "scan_errors_by_code",
    columns: ["errorCode", "scans"],
    sql: "SELECT COALESCE(json_extract(error_json, '$.code'), '(none)') AS errorCode, COUNT(*) AS scans FROM scans WHERE status = 'failed' GROUP BY errorCode ORDER BY scans DESC",
  },
];

// Column names that would make a row attributable (or leak secrets) if they
// ever appeared in a query. Kept deliberately broad — a false positive here
// costs a moment of operator review; a false negative costs a public leak.
const FORBIDDEN_SQL_PATTERN =
  /\b(organization_id|owner_user_id|user_id|actor_user_id|decided_by_user_id|created_by_user_id|invited_by_user_id|accepted_by_user_id|public_shared_by_user_id|package_name|public_package_key|stage_id|scan_id|delivery_id|installation_id|repository_full_name|repository_id|account_login|registry_url|ip_address|user_agent|email|token|secret|password|ciphertext|nonce|fingerprint|backup_codes)\b/i;

export function assertAggregateOnly(query) {
  if (!/^\s*SELECT\b/i.test(query.sql)) {
    throw new Error(`ops snapshot query ${query.name} must be a SELECT`);
  }
  if (!/\bGROUP BY\b/i.test(query.sql) || !/\bCOUNT\s*\(/i.test(query.sql)) {
    throw new Error(`ops snapshot query ${query.name} must be a GROUP BY count aggregate`);
  }
  const forbidden = FORBIDDEN_SQL_PATTERN.exec(query.sql);
  if (forbidden) {
    throw new Error(
      `ops snapshot query ${query.name} references forbidden identifier column "${forbidden[1]}"`,
    );
  }
}

// Belt and braces on the output side: rows may only carry the columns the
// query declared. An unexpected key aborts before anything is written, and the
// error names the key — never its value.
export function assertRowShape(query, rows) {
  const allowed = new Set(query.columns);
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!allowed.has(key)) {
        throw new Error(`ops snapshot query ${query.name} returned unexpected column "${key}"`);
      }
    }
  }
}

// The repo is public and gets committed/pushed by agents; a snapshot that
// lands inside it is one `git add -A` away from being published. Refuse any
// output directory inside the repository, including via DRYDOCK_OPS_DIR.
export function resolveSnapshotDir(env = process.env, repositoryRoot = repoRoot) {
  const base = env.DRYDOCK_OPS_DIR
    ? path.resolve(env.DRYDOCK_OPS_DIR)
    : path.join(os.homedir(), ".drydock-ops");
  const dir = path.join(base, "snapshots");
  const relative = path.relative(repositoryRoot, dir);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error(
      `refusing to write ops snapshots inside the repository (${dir}) — the repo is public; use the default ~/.drydock-ops or set DRYDOCK_OPS_DIR outside the repo`,
    );
  }
  return dir;
}

export function parseSnapshotArgs(argv, env = process.env) {
  const options = {
    database: env.DRYDOCK_D1_DATABASE || DEFAULT_DATABASE,
    mode: "remote",
    config: env.WRANGLER_CONFIG || "",
    persistTo: env.WRANGLER_PERSIST_TO || "",
    wranglerBin: env.WRANGLER_BIN || "pnpm",
    wranglerPrefix: env.WRANGLER_BIN ? [] : ["exec", "wrangler"],
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === "--") continue;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--local") options.mode = "local";
    else if (arg === "--remote") options.mode = "remote";
    else if (arg === "--database") options.database = readValue();
    else if (arg === "--config") options.config = readValue();
    else if (arg === "--persist-to") options.persistTo = readValue();
    else if (arg === "--wrangler-bin") {
      options.wranglerBin = readValue();
      options.wranglerPrefix = [];
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function runSnapshot(options) {
  for (const query of SNAPSHOT_QUERIES) assertAggregateOnly(query);
  const snapshotDir = resolveSnapshotDir();

  const queries = {};
  for (const query of SNAPSHOT_QUERIES) {
    const rows = await d1Execute(options, query.sql);
    assertRowShape(query, rows);
    queries[query.name] = { rowCount: rows.length, rows };
    process.stdout.write(`ops snapshot: ${query.name} rows=${rows.length}\n`);
  }

  const generatedAt = new Date();
  const report = {
    generatedAt: generatedAt.toISOString(),
    database: options.database,
    mode: options.mode,
    queries,
  };
  await mkdir(snapshotDir, { recursive: true });
  const fileName = `${generatedAt
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d+Z$/, "Z")}.json`;
  const outPath = path.join(snapshotDir, fileName);
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`ops snapshot: wrote ${outPath}\n`);
  return outPath;
}

async function d1Execute(options, sql) {
  const args = [
    ...options.wranglerPrefix,
    ...(options.config ? ["--config", options.config] : []),
    "d1",
    "execute",
    options.database,
    options.mode === "local" ? "--local" : "--remote",
    ...(options.persistTo ? ["--persist-to", options.persistTo] : []),
    "--json",
    "--yes",
    "--command",
    sql,
  ];
  const stdout = await spawnCapture(options.wranglerBin, args);
  // `pnpm exec` may prepend install-status lines before wrangler's JSON array;
  // parse from the first bracket onward.
  const jsonStart = stdout.indexOf("[");
  let parsed;
  try {
    parsed = JSON.parse(jsonStart === -1 ? stdout : stdout.slice(jsonStart));
  } catch {
    throw new Error("wrangler d1 execute did not return valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("wrangler d1 execute did not return an array");
  for (const statement of parsed) {
    if (!statement?.success) throw new Error("wrangler d1 execute reported a failed statement");
  }
  const last = parsed.at(-1);
  return Array.isArray(last?.results) ? last.results : [];
}

function spawnCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else {
        reject(
          new Error(
            `${[command, ...args].join(" ")} failed with exit code ${code ?? 1}: ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

function printUsage() {
  process.stdout.write(`Usage: pnpm run ops:snapshot [-- options]

Options:
  --local              Query local Wrangler D1 storage instead of remote.
  --remote             Query remote (production) D1. Default.
  --database <name>    D1 database name. Defaults to ${DEFAULT_DATABASE}.
  --config <path>      Forward a Wrangler config path.
  --persist-to <path>  Forward local Wrangler persistence path.
  --wrangler-bin <p>   Use a specific Wrangler binary instead of "pnpm exec wrangler".

Environment:
  DRYDOCK_OPS_DIR      Output base directory (default ~/.drydock-ops). Must be
                       outside the repository.
  DRYDOCK_D1_DATABASE, WRANGLER_CONFIG, WRANGLER_PERSIST_TO, WRANGLER_BIN
`);
}

function isMain() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  try {
    const options = parseSnapshotArgs(process.argv.slice(2));
    if (options.help) {
      printUsage();
      process.exit(0);
    }
    await runSnapshot(options);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
