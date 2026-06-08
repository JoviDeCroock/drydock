#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const DEFAULT_LIMIT = 10;
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

export function parseBackfillArgs(argv, env = process.env) {
  const options = {
    baseUrl: env.DRYDOCK_BASE_URL || "",
    cookie: env.DRYDOCK_SESSION_COOKIE || "",
    organizationId: env.DRYDOCK_ORGANIZATION_ID || "",
    allOrganizations: false,
    limit: DEFAULT_LIMIT,
    cursor: "",
    maxBatches: Number.POSITIVE_INFINITY,
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

    if (arg === "--help" || arg === "-h") return { ...options, help: true };
    if (arg === "--base-url") {
      options.baseUrl = readValue(arg);
    } else if (arg.startsWith("--base-url=")) {
      options.baseUrl = arg.slice("--base-url=".length);
    } else if (arg === "--cookie") {
      options.cookie = readValue(arg);
    } else if (arg.startsWith("--cookie=")) {
      options.cookie = arg.slice("--cookie=".length);
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
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.help) return options;
  if (!options.baseUrl) {
    throw new Error("set --base-url or DRYDOCK_BASE_URL");
  }
  if (!options.cookie) {
    throw new Error("set --cookie or DRYDOCK_SESSION_COOKIE");
  }
  if (options.allOrganizations && options.organizationId) {
    throw new Error("--all-organizations cannot be combined with --organization-id");
  }
  if (options.allOrganizations && options.cursor) {
    throw new Error("--cursor is only supported for a single organization run");
  }

  return {
    ...options,
    baseUrl: normalizeBaseUrl(options.baseUrl),
    organizationId: options.organizationId || null,
    cursor: options.cursor || null,
  };
}

export async function runBackfill(options, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("global fetch is not available");
  const stdout = deps.stdout || process.stdout;

  const targets = options.allOrganizations
    ? await listManageableOrganizations(options, fetchImpl, stdout)
    : [
        {
          id: options.organizationId,
          label: options.organizationId || "active organization",
        },
      ];

  const totals = emptyTotals();
  for (const target of targets) {
    stdout.write(`scan artifacts: backfilling ${target.label}\n`);
    const result = await drainOrganizationBackfill(options, target.id, fetchImpl, stdout);
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
  pnpm run scan-artifacts:backfill -- --base-url <url> --cookie <cookie> [options]

Options:
  --organization-id <id>   Backfill one organization by sending x-organization-id.
  --all-organizations      Backfill every visible owner/admin organization.
  --limit <n>              Batch size sent to the API. Defaults to ${DEFAULT_LIMIT}.
  --cursor <id>            Resume a single-organization run from a cursor.
  --max-batches <n>        Stop after n successful batches.

Environment:
  DRYDOCK_BASE_URL, DRYDOCK_SESSION_COOKIE, DRYDOCK_ORGANIZATION_ID
`);
}

async function listManageableOrganizations(options, fetchImpl, stdout) {
  const data = await requestJson(fetchImpl, options, "/api/v1/organizations", {
    method: "GET",
  });
  if (!Array.isArray(data.organizations)) {
    throw new Error("organizations response did not include an organizations array");
  }

  const manageable = data.organizations.filter(
    (organization) => organization.role === "owner" || organization.role === "admin",
  );
  const skipped = data.organizations.length - manageable.length;
  if (skipped > 0) {
    stdout.write(`scan artifacts: skipped ${skipped} organization(s) without admin access\n`);
  }
  if (manageable.length === 0) {
    throw new Error("no owner/admin organizations are visible to this session");
  }
  return manageable.map((organization) => ({
    id: organization.id,
    label: `${organization.name || organization.id} (${organization.id})`,
  }));
}

async function drainOrganizationBackfill(options, organizationId, fetchImpl, stdout) {
  const totals = emptyTotals();
  let cursor = options.cursor;
  let batch = 0;

  do {
    if (batch >= options.maxBatches) {
      stdout.write(`scan artifacts: stopped after --max-batches=${options.maxBatches}\n`);
      return totals;
    }

    batch += 1;
    const result = await requestJson(fetchImpl, options, "/api/v1/scans/artifacts/backfill", {
      method: "POST",
      organizationId,
      body: JSON.stringify({ limit: options.limit, cursor }),
    });
    assertBackfillResult(result);
    addTotals(totals, result);
    cursor = result.nextCursor || null;
    stdout.write(
      `scan artifacts: batch=${batch} scanned=${result.scanned} backfilled=${result.backfilled} alreadyBacked=${result.alreadyBacked} digestMismatch=${result.digestMismatch} failed=${result.failed} nextCursor=${cursor || "done"}\n`,
    );
  } while (cursor);

  return totals;
}

async function requestJson(fetchImpl, options, path, init) {
  const headers = new Headers({
    accept: "application/json",
    cookie: options.cookie,
  });
  if (init.method !== "GET") headers.set("content-type", "application/json");
  if (init.organizationId) headers.set("x-organization-id", init.organizationId);

  const response = await fetchImpl(`${options.baseUrl}${path}`, {
    method: init.method,
    headers,
    body: init.body,
  });
  const text = await response.text();
  const data = text ? parseJson(text) : {};
  if (!response.ok) {
    const detail = data && typeof data.error === "string" ? `: ${data.error}` : "";
    throw new Error(`${init.method} ${path} failed with ${response.status}${detail}`);
  }
  if (!data) throw new Error("response was not valid JSON");
  return data;
}

function assertBackfillResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("backfill response was not an object");
  }
  const fields = ["scanned", "backfilled", "alreadyBacked", "digestMismatch", "failed"];
  for (const field of fields) {
    if (!Number.isFinite(value[field])) {
      throw new Error(`backfill response field ${field} was not a number`);
    }
  }
  if (value.nextCursor !== null && typeof value.nextCursor !== "string") {
    throw new Error("backfill response field nextCursor was not null or a string");
  }
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

function parsePositiveInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  return url.href.replace(/\/$/, "");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
