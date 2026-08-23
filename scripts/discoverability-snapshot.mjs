#!/usr/bin/env node
// Operator-only, read-only aggregate snapshot for the discoverability funnel.
// Search impressions and landing-page clicks stay in Google Search Console;
// this script reads the privacy-preserving product outcomes already recorded in
// Cloudflare Analytics Engine. It never sends or prints visitor identifiers.
import { pathToFileURL } from "node:url";

const DEFAULT_DATASET = "drydock_product_events";
const DEFAULT_DAYS = 28;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function snapshotQueries(dataset = DEFAULT_DATASET, days = DEFAULT_DAYS) {
  if (!IDENTIFIER.test(dataset)) throw new Error("dataset must be a SQL identifier");
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error("days must be an integer from 1 to 90");
  }
  const window = `timestamp > NOW() - INTERVAL '${days}' DAY`;
  const schema = "blob1 = '1'";
  const weightedCount = "SUM(_sample_interval)";

  return [
    {
      name: "discovery_outcomes",
      sql: `SELECT blob2 AS event, ${weightedCount} AS events FROM ${dataset} WHERE ${schema} AND ${window} AND blob2 IN ('public_diff.viewed', 'user.signed_up', 'organization.created', 'integration.connected', 'scan.completed', 'workflow_gate.opened') GROUP BY event ORDER BY events DESC`,
    },
    {
      name: "public_diff_by_ecosystem_and_cache",
      sql: `SELECT blob4 AS ecosystem, blob6 AS cache, ${weightedCount} AS views FROM ${dataset} WHERE ${schema} AND ${window} AND blob2 = 'public_diff.viewed' GROUP BY ecosystem, cache ORDER BY views DESC`,
    },
    {
      name: "integrations_by_kind",
      sql: `SELECT blob4 AS kind, ${weightedCount} AS connections FROM ${dataset} WHERE ${schema} AND ${window} AND blob2 = 'integration.connected' GROUP BY kind ORDER BY connections DESC`,
    },
    {
      name: "completed_scans_by_ecosystem",
      sql: `SELECT blob4 AS ecosystem, ${weightedCount} AS scans FROM ${dataset} WHERE ${schema} AND ${window} AND blob2 = 'scan.completed' GROUP BY ecosystem ORDER BY scans DESC`,
    },
  ];
}

export function parseSnapshotArgs(argv, env = process.env) {
  const options = {
    accountId: env.DRYDOCK_CF_ACCOUNT_ID || "",
    token: env.DRYDOCK_CF_ANALYTICS_TOKEN || "",
    dataset: env.DRYDOCK_ANALYTICS_DATASET || DEFAULT_DATASET,
    days: DEFAULT_DAYS,
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
    else if (arg === "--days") options.days = Number(readValue());
    else if (arg === "--dataset") options.dataset = readValue();
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export async function runDiscoverabilitySnapshot(options, fetchImpl = fetch) {
  if (!/^[a-f0-9]{32}$/i.test(options.accountId)) {
    throw new Error("DRYDOCK_CF_ACCOUNT_ID must be a 32-character Cloudflare account id");
  }
  if (!options.token) throw new Error("DRYDOCK_CF_ANALYTICS_TOKEN is required");

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/analytics_engine/sql`;
  const queries = snapshotQueries(options.dataset, options.days);
  const results = await Promise.all(
    queries.map(async (query) => {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.token}` },
        body: query.sql,
      });
      if (!response.ok) {
        throw new Error(`Analytics Engine query ${query.name} returned ${response.status}`);
      }
      const payload = await response.json();
      const rows = Array.isArray(payload) ? payload : payload?.data;
      if (!Array.isArray(rows)) {
        throw new Error(`Analytics Engine query ${query.name} returned an unexpected shape`);
      }
      return [query.name, rows];
    }),
  );

  return {
    generatedAt: new Date().toISOString(),
    windowDays: options.days,
    dataset: options.dataset,
    queries: Object.fromEntries(results),
  };
}

function printUsage() {
  process.stdout.write(
    `Usage: pnpm run discoverability:snapshot [-- --days <1-90>]\n\nEnvironment:\n  DRYDOCK_CF_ACCOUNT_ID       Cloudflare account id\n  DRYDOCK_CF_ANALYTICS_TOKEN  API token with Account Analytics Read\n  DRYDOCK_ANALYTICS_DATASET   Optional dataset override\n`,
  );
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseSnapshotArgs(argv, env);
  if (options.help) {
    printUsage();
    return 0;
  }
  const report = await runDiscoverabilitySnapshot(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    process.stderr.write(`discoverability snapshot: ${error.message}\n`);
    process.exitCode = 1;
  });
}
