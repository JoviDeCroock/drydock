// @ts-check
import { parseArguments } from "./args.mjs";
import { CliError, createClient, pathSegment, requireApiKey, resolveBaseUrl } from "./client.mjs";
import {
  terminalSafeJson,
  formatDiscovery,
  formatDiff,
  formatGate,
  formatReleases,
  formatScan,
  formatScanList,
  formatScanStatus,
  formatStartedScan,
  formatWhoami,
} from "./format.mjs";
import { CLI_VERSION } from "./version.mjs";

const USAGE = `Usage: drydock <command> [options]

Read an organization's Drydock reviews from scripts and CI, and start new ones
with a key that has scan access. Release decisions stay with signed-in
maintainers.

Commands:
  whoami                          The API key's organization, expiry, and access
  scans list                      Reviews, newest first
      [--filter undecided|published_without_decision|publish|no_publish|all]
      [--limit N] [--cursor C]
  scans get <review-id>           One review and its findings
  scans wait <review-id>          Poll until the review completes
      [--timeout SECONDS] [--interval SECONDS] [--fail-on RISK]
  scans start <package>@<version> Review a published version (scan access)
      [--ecosystem npm|pypi|vscode|atpm] [--baseline VERSION]
      [--wait [--timeout S] [--interval S] [--fail-on RISK]]
  scans start --stage <stage-id>  Review an npm staged publish (scan access)
      [--wait [--timeout S] [--interval S] [--fail-on RISK]]
  check-npm                       Discover new npm staged publishes and start
                                  their reviews, like "Check npm" (scan access)
      [--wait [--timeout S] [--interval S] [--fail-on RISK]]
  report <review-id>              The canonical report export (drydock.report.v2)
      [--output FILE]
  receipt <review-id>             The Release Receipt, checked against its digest
      [--output FILE]
  releases <package>              One package's reviews in the organization
      [--ecosystem npm|pypi|vscode|atpm] [--limit N] [--cursor C]
  gate <review-id>                The GitHub workflow gate a review belongs to
  diff <package> <from> <to>      Diff two published releases (no API key needed)
      [--ecosystem npm|pypi|atpm] [--fail-on RISK]

Options:
  --url URL        Drydock origin (default: $DRYDOCK_URL or https://drydock.org)
  --json           Print the API response as JSON
  -h, --help       Show this help
  -v, --version    Print the CLI version

Environment:
  DRYDOCK_API_KEY  Organization API key (ddk_…), read only from the environment
                   so it stays out of shell history and process listings
  DRYDOCK_URL      Drydock origin

Exit codes: 0 success, 1 request or review failed, 2 usage error,
3 risk at or above --fail-on (RISK is low, medium, high, or critical). With
--wait over several reviews, 3 wins over 1: any review at the threshold exits 3.
`;

const RISK_ORDER = ["low", "medium", "high", "critical"];
const SCAN_FILTERS = ["undecided", "published_without_decision", "publish", "no_publish", "all"];
const ECOSYSTEMS = ["npm", "pypi", "vscode", "atpm"];
const PUBLIC_DIFF_ECOSYSTEMS = ["npm", "pypi", "atpm"];

/**
 * @typedef {object} CliIo
 * @property {Record<string, string | undefined>} env
 * @property {typeof fetch} fetch
 * @property {(text: string) => void} stdout
 * @property {(text: string) => void} stderr
 * @property {(path: string, data: string) => Promise<void>} writeFile
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} now
 */

/**
 * Runs one command and returns its exit code. All process access goes through
 * `io` so tests can drive the CLI against a real Worker.
 * @param {string[]} argv
 * @param {CliIo} io
 * @returns {Promise<number>}
 */
export async function main(argv, io) {
  let parsed;
  try {
    parsed = parseArguments(argv, {
      url: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      filter: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
      ecosystem: { type: "string" },
      output: { type: "string", short: "o" },
      timeout: { type: "string" },
      interval: { type: "string" },
      "fail-on": { type: "string" },
      stage: { type: "string" },
      baseline: { type: "string" },
      wait: { type: "boolean" },
    });
  } catch (err) {
    io.stderr(`drydock: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(`${CLI_VERSION}\n`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    io.stdout(USAGE);
    return values.help ? 0 : 2;
  }

  try {
    const command = resolveCommand(positionals);
    const baseUrl = resolveBaseUrl(
      typeof values.url === "string" ? values.url : io.env.DRYDOCK_URL,
    );
    const client = createClient({
      baseUrl,
      apiKey: command.anonymous ? null : requireApiKey(io.env.DRYDOCK_API_KEY),
      fetch: io.fetch,
    });
    return await command.run({ client, io, values, positionals });
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr(`drydock: ${err.message}\n`);
      return err.exitCode;
    }
    throw err;
  }
}

/**
 * @typedef {{ run: (ctx: CommandContext) => Promise<number>; anonymous?: boolean }} Command
 */

/**
 * @param {string[]} positionals
 * @returns {Command}
 */
function resolveCommand(positionals) {
  const [first, second] = positionals;
  /** @type {Record<string, Command>} */
  const commands = {
    whoami: { run: whoami },
    "scans list": { run: scansList },
    "scans get": { run: scansGet },
    "scans wait": { run: scansWait },
    "scans start": { run: scansStart },
    "check-npm": { run: checkNpm },
    report: { run: (ctx) => download(ctx, "report.json") },
    receipt: { run: (ctx) => download(ctx, "release-receipt.json") },
    releases: { run: releases },
    gate: { run: gate },
    diff: { run: diff, anonymous: true },
  };
  const command = commands[first === "scans" ? `scans ${second ?? ""}`.trim() : first];
  if (!command) {
    throw new CliError(
      `unknown command: ${positionals.slice(0, 2).join(" ")} (see drydock --help)`,
      2,
    );
  }
  return command;
}

/**
 * @typedef {object} CommandContext
 * @property {ReturnType<typeof createClient>} client
 * @property {CliIo} io
 * @property {Record<string, string | boolean | undefined>} values
 * @property {string[]} positionals
 */

/**
 * @param {CommandContext} ctx
 * @param {number} count positional arguments after the command words
 * @param {number} offset command words
 * @param {string} usage
 */
function args(ctx, count, offset, usage) {
  const rest = ctx.positionals.slice(offset);
  if (rest.length !== count) throw new CliError(`usage: drydock ${usage}`, 2);
  return rest;
}

/**
 * @param {CommandContext} ctx
 * @param {unknown} body
 * @param {(body: any) => string} format
 */
function print(ctx, body, format) {
  ctx.io.stdout(`${ctx.values.json ? terminalSafeJson(body) : format(body)}\n`);
}

/**
 * @param {Record<string, string | boolean | undefined>} values
 * @param {string[]} names
 */
function query(values, names) {
  const params = new URLSearchParams();
  for (const name of names) {
    const value = values[name];
    if (typeof value === "string" && value) params.set(name, value);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {string} flag
 */
function oneOf(value, allowed, flag) {
  if (value === undefined) return;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new CliError(`${flag} must be one of: ${allowed.join(", ")}`, 2);
  }
}

/**
 * @param {unknown} value
 * @param {string} flag
 * @param {number} fallback
 */
function positiveNumber(value, flag, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new CliError(`${flag} must be a positive number`, 2);
  return parsed;
}

/** @param {Record<string, string | boolean | undefined>} values */
function failOnThreshold(values) {
  oneOf(values["fail-on"], RISK_ORDER, "--fail-on");
  const value = values["fail-on"];
  return typeof value === "string" ? RISK_ORDER.indexOf(value) : null;
}

/**
 * @param {number | null} threshold
 * @param {unknown} risk
 */
function meetsThreshold(threshold, risk) {
  if (threshold === null) return false;
  const level = typeof risk === "string" ? RISK_ORDER.indexOf(risk) : -1;
  return level >= threshold;
}

/** @param {CommandContext} ctx */
async function whoami(ctx) {
  args(ctx, 0, 1, "whoami");
  print(ctx, await ctx.client.json("/api/v1/api-keys/current"), formatWhoami);
  return 0;
}

/** @param {CommandContext} ctx */
async function scansList(ctx) {
  args(ctx, 0, 2, "scans list [--filter F] [--limit N] [--cursor C]");
  oneOf(ctx.values.filter, SCAN_FILTERS, "--filter");
  const body = await ctx.client.json(
    `/api/v1/scans${query(ctx.values, ["filter", "limit", "cursor"])}`,
  );
  print(ctx, body, formatScanList);
  return 0;
}

/** @param {CommandContext} ctx */
async function scansGet(ctx) {
  const [id] = args(ctx, 1, 2, "scans get <review-id>");
  print(ctx, await ctx.client.json(`/api/v1/scans/${pathSegment(id, "review id")}`), formatScan);
  return 0;
}

/** @param {CommandContext} ctx */
async function scansWait(ctx) {
  const [id] = args(
    ctx,
    1,
    2,
    "scans wait <review-id> [--timeout S] [--interval S] [--fail-on RISK]",
  );
  const waiting = waitSettings(ctx);
  const scan = await waitForReview(ctx, id, waiting);
  print(ctx, scan, formatScanStatus);
  return reviewExitCode([scan], waiting.threshold);
}

/**
 * @param {CommandContext} ctx
 * @returns {{ threshold: number | null; intervalMs: number; deadline: number }}
 */
function waitSettings(ctx) {
  const threshold = failOnThreshold(ctx.values);
  const timeoutMs = positiveNumber(ctx.values.timeout, "--timeout", 600) * 1000;
  const intervalMs = positiveNumber(ctx.values.interval, "--interval", 5) * 1000;
  return { threshold, intervalMs, deadline: ctx.io.now() + timeoutMs };
}

/**
 * Polls one review until it completes or fails, or the shared deadline passes.
 * @param {CommandContext} ctx
 * @param {string} id
 * @param {{ intervalMs: number; deadline: number }} waiting
 * @returns {Promise<any>} the review's final status
 */
async function waitForReview(ctx, id, { intervalMs, deadline }) {
  const path = `/api/v1/scans/${pathSegment(id, "review id")}/status`;
  for (;;) {
    const { scan } = await ctx.client.json(path);
    if (scan?.status === "complete" || scan?.status === "failed") return scan;
    if (ctx.io.now() + intervalMs > deadline) {
      throw new CliError(`review ${id} is still ${scan?.status ?? "pending"} after the timeout`);
    }
    await ctx.io.sleep(intervalMs);
  }
}

/**
 * 3 when any review reaches the threshold, else 1 when any failed, else 0. A
 * review at the threshold is the decisive signal for a release gate; a failed
 * one only says that review has no verdict.
 * @param {any[]} scans final statuses
 * @param {number | null} threshold
 */
function reviewExitCode(scans, threshold) {
  if (scans.some((scan) => scan.status !== "failed" && meetsThreshold(threshold, scan.risk))) {
    return 3;
  }
  return scans.some((scan) => scan.status === "failed") ? 1 : 0;
}

/**
 * Waits for each started review in turn under one deadline and prints their
 * final statuses: one JSON object with `--json`, a status line each otherwise.
 * @param {CommandContext} ctx
 * @param {string[]} ids
 * @param {ReturnType<typeof waitSettings>} waiting
 * @param {unknown} started the start response, carried into `--json` output
 */
async function waitAndReport(ctx, ids, waiting, started) {
  const results = [];
  for (const id of ids) results.push(await waitForReview(ctx, id, waiting));
  if (ctx.values.json) {
    ctx.io.stdout(`${terminalSafeJson({ .../** @type {object} */ (started), results })}\n`);
  } else {
    for (const scan of results) ctx.io.stdout(`${formatScanStatus(scan)}\n`);
  }
  return reviewExitCode(results, waiting.threshold);
}

/**
 * `<name>@<version>`, splitting at the last `@` so a scoped npm name keeps its
 * leading one (`@scope/name@1.2.3`).
 * @param {string} spec
 */
function parsePackageSpec(spec) {
  const at = spec.lastIndexOf("@");
  const packageName = at > 0 ? spec.slice(0, at).trim() : "";
  const version = at > 0 ? spec.slice(at + 1).trim() : "";
  if (!packageName || !version) {
    throw new CliError(`expected <package>@<version>, got: ${spec}`, 2);
  }
  return { packageName, version };
}

const START_USAGE =
  "scans start <package>@<version> [--ecosystem E] [--baseline V] | scans start --stage <stage-id> [--wait] [--fail-on RISK]";

/** @param {CommandContext} ctx */
async function scansStart(ctx) {
  const { stage, ecosystem, baseline } = ctx.values;
  /** @type {Record<string, string>} */
  let body;
  if (stage !== undefined) {
    args(ctx, 0, 2, START_USAGE);
    if (ecosystem !== undefined || baseline !== undefined) {
      throw new CliError("--stage names an npm staged publish; drop --ecosystem and --baseline", 2);
    }
    if (typeof stage !== "string" || !stage.trim()) throw new CliError("--stage needs a value", 2);
    body = { stageId: stage.trim() };
  } else {
    const [spec] = args(ctx, 1, 2, START_USAGE);
    oneOf(ecosystem, ECOSYSTEMS, "--ecosystem");
    const { packageName, version } = parsePackageSpec(spec);
    body = { ecosystem: typeof ecosystem === "string" ? ecosystem : "npm", packageName, version };
    if (typeof baseline === "string" && baseline.trim()) body.baselineVersion = baseline.trim();
  }
  const waiting = ctx.values.wait ? waitSettings(ctx) : null;
  if (!waiting && ctx.values["fail-on"] !== undefined) {
    throw new CliError("--fail-on needs --wait", 2);
  }

  const started = await ctx.client.json("/api/v1/scans", { method: "POST", body });
  const id = started?.scan?.id;
  if (typeof id !== "string" || !id) throw new CliError("Drydock did not return a review id");
  if (!waiting) {
    print(ctx, started, formatStartedScan);
    return 0;
  }
  if (!ctx.values.json) ctx.io.stderr(`${formatStartedScan(started)}\n`);
  return waitAndReport(ctx, [id], waiting, started);
}

/** @param {CommandContext} ctx */
async function checkNpm(ctx) {
  args(ctx, 0, 1, "check-npm [--wait [--timeout S] [--interval S] [--fail-on RISK]]");
  const waiting = ctx.values.wait ? waitSettings(ctx) : null;
  if (!waiting && ctx.values["fail-on"] !== undefined) {
    throw new CliError("--fail-on needs --wait", 2);
  }
  const result = await ctx.client.json("/api/v1/staged-publishes/scan", { method: "POST" });
  if (!waiting) {
    print(ctx, result, formatDiscovery);
    return 0;
  }
  if (!ctx.values.json) ctx.io.stderr(`${formatDiscovery(result)}\n`);
  const ids = (Array.isArray(result?.scans) ? result.scans : [])
    .map((/** @type {any} */ scan) => scan?.id)
    .filter((/** @type {unknown} */ id) => typeof id === "string" && id);
  return waitAndReport(ctx, ids, waiting, result);
}

/**
 * Writes the export's exact bytes, which are byte-stable on the server. A
 * receipt is checked against the digest the server sent with it.
 * @param {CommandContext} ctx
 * @param {"report.json" | "release-receipt.json"} file
 */
async function download(ctx, file) {
  const label = file === "report.json" ? "report" : "receipt";
  const [id] = args(ctx, 1, 1, `${label} <review-id> [--output FILE]`);
  const res = await ctx.client.request(`/api/v1/scans/${pathSegment(id, "review id")}/${file}`);
  if (file === "release-receipt.json") {
    const declared = res.headers.get("x-drydock-receipt-sha256");
    const actual = await sha256Hex(res.text);
    if (declared !== actual) {
      throw new CliError("the receipt does not match the digest Drydock sent with it");
    }
  }
  const output = ctx.values.output;
  if (typeof output === "string" && output) {
    await ctx.io.writeFile(output, res.text);
    ctx.io.stderr(`wrote ${output}\n`);
  } else {
    ctx.io.stdout(res.text.endsWith("\n") ? res.text : `${res.text}\n`);
  }
  return 0;
}

/** @param {CommandContext} ctx */
async function releases(ctx) {
  const [name] = args(ctx, 1, 1, "releases <package> [--ecosystem E] [--limit N] [--cursor C]");
  oneOf(ctx.values.ecosystem, ECOSYSTEMS, "--ecosystem");
  // Scoped npm names keep their slash (`/packages/@scope/name/releases`).
  const encoded = name
    .split("/")
    .map((segment) => pathSegment(segment, "package name"))
    .join("/");
  const body = await ctx.client.json(
    `/api/v1/packages/${encoded}/releases${query(ctx.values, ["ecosystem", "limit", "cursor"])}`,
  );
  print(ctx, body, formatReleases);
  return 0;
}

/** @param {CommandContext} ctx */
async function gate(ctx) {
  const [id] = args(ctx, 1, 1, "gate <review-id>");
  const body = await ctx.client.json(
    `/api/v1/github-app/workflow-gates/by-scan/${pathSegment(id, "review id")}`,
  );
  print(ctx, body, formatGate);
  return 0;
}

/** @param {CommandContext} ctx */
async function diff(ctx) {
  const [name, from, to] = args(
    ctx,
    3,
    1,
    "diff <package> <from> <to> [--ecosystem E] [--fail-on RISK]",
  );
  oneOf(ctx.values.ecosystem, PUBLIC_DIFF_ECOSYSTEMS, "--ecosystem");
  const threshold = failOnThreshold(ctx.values);
  const params = new URLSearchParams({ package: name, from, to });
  if (typeof ctx.values.ecosystem === "string") params.set("ecosystem", ctx.values.ecosystem);
  const body = await ctx.client.json(`/api/public/v1/package-diff?${params}`, {
    authenticated: false,
  });
  print(ctx, body, formatDiff);
  return meetsThreshold(threshold, body?.risk?.releaseRisk) ? 3 : 0;
}

/** @param {string} text */
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
