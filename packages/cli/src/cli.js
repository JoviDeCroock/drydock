const DEFAULT_API_URL = "https://drydock.org";
const DEFAULT_FAIL_ON = "high";
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_SECONDS = 15 * 60;
const REQUEST_TIMEOUT_MS = 30_000;

const RISK_ORDER = ["none", "low", "medium", "high", "critical"];
const FAIL_ON_LEVELS = [...RISK_ORDER.slice(1), "none"];
const TERMINAL_STATUSES = new Set(["complete", "failed"]);

const HELP = `Drydock CLI

Usage:
  drydock scan --stage <stageId> [options]
  drydock scan --gate <scanId> [options]
  drydock report <scanId> [--json] [options]

Commands:
  scan      Create and await a staged-publish scan, or await a workflow-gate scan.
  report    Print a completed scan report. --json emits the canonical report document.

Options:
  --fail-on <risk>       Exit 2 when artifact risk reaches low, medium, high, or critical
                         (default: high; use none to disable).
  --api-url <url>        Drydock origin (default: DRYDOCK_API_URL or https://drydock.org).
  --poll-interval <ms>   Poll interval in milliseconds (default: 2000).
  --timeout <seconds>    Overall scan wait timeout (default: 900).
  --json                 Emit the canonical JSON document (report only).
  -h, --help             Show help.
  -v, --version          Show version.

Environment:
  DRYDOCK_TOKEN          Organization API token (required).
  DRYDOCK_API_URL        Optional Drydock origin override.

Exit codes:
  0  Command succeeded and risk is below the configured threshold.
  1  Configuration, API, timeout, or scan failure.
  2  Completed scan reached the configured risk threshold.
`;

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

class DrydockApi {
  constructor({ baseUrl, token, fetchImpl }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async json(path, init = {}) {
    const response = await this.request(path, init);
    try {
      return await response.json();
    } catch {
      throw new CliError(`Drydock returned invalid JSON for ${init.method ?? "GET"} ${path}.`);
    }
  }

  async text(path, init = {}) {
    return (await this.request(path, init)).text();
  }

  async request(path, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");

    let response;
    try {
      response = await this.fetchImpl(new URL(path, `${this.baseUrl}/`), {
        ...init,
        headers,
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new CliError("Drydock API request timed out.");
      }
      throw new CliError(`Could not reach the Drydock API: ${safeErrorMessage(error, this.token)}`);
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) return response;

    const responseText = await response.text().catch(() => "");
    const serverMessage = readServerError(responseText);
    const suffix = serverMessage ? `: ${redact(serverMessage, this.token)}` : "";
    throw new CliError(`Drydock API returned HTTP ${response.status}${suffix}`);
  }
}

export async function runCli(argv, overrides = {}) {
  const deps = {
    env: overrides.env ?? process.env,
    fetch: overrides.fetch ?? globalThis.fetch,
    now: overrides.now ?? Date.now,
    sleep:
      overrides.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
  };

  try {
    const parsed = parseArgs(argv);
    if (parsed.kind === "help") {
      deps.stdout.write(HELP);
      return 0;
    }
    if (parsed.kind === "version") {
      deps.stdout.write("drydock 0.1.0\n");
      return 0;
    }

    const token = deps.env.DRYDOCK_TOKEN?.trim();
    if (!token) throw new CliError("DRYDOCK_TOKEN is required.");

    const api = new DrydockApi({
      baseUrl: parsed.apiUrl ?? deps.env.DRYDOCK_API_URL ?? DEFAULT_API_URL,
      token,
      fetchImpl: deps.fetch,
    });

    if (parsed.kind === "report") {
      await printReport(api, parsed, deps.stdout);
      return 0;
    }

    const scanId = parsed.mode === "stage" ? await createScan(api, parsed.value) : parsed.value;
    const detail = await pollScan(api, scanId, parsed, deps);

    deps.stdout.write(`${formatScanSummary(detail)}\n`);
    return riskReached(detail.scan?.risk, parsed.failOn) ? 2 : 0;
  } catch (error) {
    const cliError = error instanceof CliError ? error : new CliError(safeErrorMessage(error));
    deps.stderr.write(`drydock: ${cliError.message}\n`);
    return cliError.exitCode;
  }
}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    return { kind: "help" };
  }
  if (argv[0] === "--version" || argv[0] === "-v") return { kind: "version" };

  const [command, ...tokens] = argv;
  if (command === "scan") return parseScanArgs(tokens);
  if (command === "report") return parseReportArgs(tokens);
  throw new CliError(`Unknown command ${JSON.stringify(command)}. Run drydock --help.`);
}

function parseScanArgs(tokens) {
  const options = {
    kind: "scan",
    mode: null,
    value: null,
    failOn: DEFAULT_FAIL_ON,
    apiUrl: null,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1_000,
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--help" || token === "-h") return { kind: "help" };
    if (token === "--stage" || token === "--gate") {
      if (options.mode) throw new CliError("Use exactly one of --stage or --gate.");
      options.mode = token.slice(2);
      options.value = optionValue(tokens, ++index, token);
      continue;
    }
    if (token === "--fail-on") {
      const value = optionValue(tokens, ++index, token).toLowerCase();
      if (!FAIL_ON_LEVELS.includes(value)) {
        throw new CliError(`--fail-on must be one of ${FAIL_ON_LEVELS.join(", ")}.`);
      }
      options.failOn = value;
      continue;
    }
    if (token === "--api-url") {
      options.apiUrl = optionValue(tokens, ++index, token);
      continue;
    }
    if (token === "--poll-interval") {
      options.pollIntervalMs = positiveNumber(optionValue(tokens, ++index, token), token);
      continue;
    }
    if (token === "--timeout") {
      options.timeoutMs = positiveNumber(optionValue(tokens, ++index, token), token) * 1_000;
      continue;
    }
    throw new CliError(`Unknown scan option ${JSON.stringify(token)}.`);
  }

  if (!options.mode || !options.value) {
    throw new CliError("scan requires exactly one of --stage <stageId> or --gate <scanId>.");
  }
  return options;
}

function parseReportArgs(tokens) {
  const options = { kind: "report", scanId: null, json: false, apiUrl: null };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--help" || token === "-h") return { kind: "help" };
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--api-url") {
      options.apiUrl = optionValue(tokens, ++index, token);
      continue;
    }
    if (token.startsWith("-"))
      throw new CliError(`Unknown report option ${JSON.stringify(token)}.`);
    if (options.scanId) throw new CliError("report accepts exactly one scan ID.");
    options.scanId = token;
  }
  if (!options.scanId) throw new CliError("report requires a scan ID.");
  return options;
}

function optionValue(tokens, index, option) {
  const value = tokens[index];
  if (!value || value.startsWith("-")) throw new CliError(`${option} requires a value.`);
  return value;
}

function positiveNumber(value, option) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError(`${option} must be a positive number.`);
  }
  return parsed;
}

async function createScan(api, stageId) {
  const result = await api.json("/api/v1/scans", {
    method: "POST",
    body: JSON.stringify({ stageId }),
  });
  const scanId = result?.scan?.id;
  if (typeof scanId !== "string" || !scanId) {
    throw new CliError("Drydock create-scan response did not include a scan ID.");
  }
  return scanId;
}

async function pollScan(api, scanId, options, deps) {
  const deadline = deps.now() + options.timeoutMs;
  let lastStatus = null;
  while (deps.now() <= deadline) {
    const detail = await api.json(`/api/v1/scans/${encodeURIComponent(scanId)}?poll=1`);
    const status = detail?.scan?.status;
    if (typeof status !== "string") {
      throw new CliError("Drydock scan response did not include a status.");
    }
    if (options.mode === "gate" && detail.scan?.source !== "workflow_gate") {
      throw new CliError(`Scan ${scanId} is not a workflow-gate scan.`);
    }
    if (status !== lastStatus) {
      deps.stderr.write(`Scan ${scanId}: ${status}\n`);
      lastStatus = status;
    }
    if (TERMINAL_STATUSES.has(status)) {
      if (status === "failed") {
        const reason = detail.scan.error
          ? `: ${redact(String(detail.scan.error).slice(0, 300), api.token)}`
          : "";
        throw new CliError(`Scan ${scanId} failed${reason}`);
      }
      return detail;
    }
    await deps.sleep(Math.min(options.pollIntervalMs, Math.max(0, deadline - deps.now())));
  }
  throw new CliError(`Timed out waiting for scan ${scanId}.`);
}

async function printReport(api, options, stdout) {
  const raw = await api.text(`/api/v1/scans/${encodeURIComponent(options.scanId)}/report.json`);
  if (options.json) {
    stdout.write(raw.endsWith("\n") ? raw : `${raw}\n`);
    return;
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    throw new CliError("Drydock returned an invalid canonical report.");
  }
  const identity = packageIdentity(report.package);
  const findings = Array.isArray(report.findings) ? report.findings.length : 0;
  const risk = normalizeRisk(report.scan?.risk);
  const releaseRisk = normalizeRisk(report.riskSummary?.releaseRisk);
  const contextRisk = normalizeRisk(report.riskSummary?.contextRisk);
  stdout.write(
    [
      `Drydock report ${report.scan?.id ?? options.scanId}`,
      `Package: ${identity}`,
      `Status: ${report.scan?.status ?? "unknown"}`,
      `Artifact risk: ${risk}`,
      `Release risk: ${releaseRisk}`,
      `Context risk: ${contextRisk}`,
      `Findings: ${findings}`,
    ].join("\n") + "\n",
  );
}

function formatScanSummary(detail) {
  const scan = detail.scan ?? {};
  const identity = packageIdentity({ name: scan.packageName, stagedVersion: scan.stagedVersion });
  const artifactRisk = normalizeRisk(scan.risk);
  const releaseRisk = normalizeRisk(detail.riskSummary?.releaseRisk);
  const contextRisk = normalizeRisk(detail.riskSummary?.contextRisk);
  const findings = Array.isArray(detail.findings)
    ? detail.findings.length
    : Number(scan.findingCount ?? 0);
  return `Drydock scan ${scan.id}: ${identity} — artifact ${artifactRisk}, release ${releaseRisk}, context ${contextRisk}; ${findings} finding${findings === 1 ? "" : "s"}`;
}

function packageIdentity(pkg) {
  const name = typeof pkg?.name === "string" && pkg.name ? pkg.name : "unknown package";
  const version =
    typeof pkg?.stagedVersion === "string" && pkg.stagedVersion ? pkg.stagedVersion : null;
  return version ? `${name}@${version}` : name;
}

function riskReached(value, threshold) {
  if (threshold === "none") return false;
  const risk = normalizeRisk(value);
  const rank = RISK_ORDER.indexOf(risk);
  if (rank < 0)
    throw new CliError(`Completed scan returned unknown risk ${JSON.stringify(value)}.`);
  return rank >= RISK_ORDER.indexOf(threshold);
}

function normalizeRisk(value) {
  return typeof value === "string" && RISK_ORDER.includes(value.toLowerCase())
    ? value.toLowerCase()
    : "unknown";
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`Invalid Drydock API URL ${JSON.stringify(value)}.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CliError("Drydock API URL must use http or https.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new CliError(
      "Drydock API URL must be an origin without credentials, path, query, or fragment.",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function readServerError(value) {
  if (!value) return "";
  try {
    const parsed = JSON.parse(value);
    return typeof parsed?.error === "string" ? parsed.error.slice(0, 500) : "";
  } catch {
    return "";
  }
}

function redact(value, secret) {
  return String(value).split(secret).join("[redacted]");
}

function safeErrorMessage(error, secret = "") {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  return secret ? redact(message, secret) : message;
}
