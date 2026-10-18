// @ts-check
import { CliError, pathSegment } from "./client.mjs";
import { clean } from "./format.mjs";
import { waitForReview } from "./wait.mjs";

// `drydock approve`: show the Drydock review at npm's approval moment, record
// the maintainer's own decision, then hand the terminal to their own
// `npm stage approve`. Drydock cannot approve on npm, and this command never
// tries: npm asks for the one-time password on the inherited terminal, and the
// CLI never reads, stores, forwards, or passes it (`--otp` is never sent). It
// never reads npm configuration or tokens either; it only runs `npm`.
//
// It is a convenience and a record, not enforcement: anyone who can approve on
// npm can do so on npmjs.com or with npm directly and skip it.

/** Drydock recorded the decision, but npm did not finish the matching action. */
const EXIT_NPM_FAILED = 5;

// npm's stage-id shape (server/lib/ecosystems/npm/stage-id.ts). The id becomes
// an npm argument, so anything outside it, including a leading `-` that npm
// would read as a flag, is refused rather than passed on.
const STAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,160}$/;
const STAGED_SOURCES = new Set(["manual", "auto_discovery"]);
const SETTLED_REGISTRY_STATUSES = new Set(["published", "blocked", "deleted"]);
const INSTALL_SCRIPTS = new Set(["preinstall", "install", "postinstall"]);
const INSTALL_TIME_RULES = new Set([
  "install-script.implicit-node-gyp",
  "install-script.gyp-command-substitution",
]);
const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];
const LOOKUP_PAGES = 10;
const PAGE_SIZE = 100;
const REASON_MAX = 500;
const TOP_FINDINGS = 5;
const LIST_ITEMS = 5;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const NO_TERMINAL = [
  "drydock approve needs an interactive terminal: it asks you for a decision, and",
  "npm then asks you for your one-time password. It has no non-interactive mode on",
  "purpose, so a script cannot approve a release in your name. In CI, gate on",
  '"drydock scans start --stage <stage-id> --wait --fail-on RISK" instead.',
].join("\n");

/**
 * @typedef {{ code: number | null; signal?: string | null; error?: string }} NpmResult
 * @typedef {import("./main.mjs").CommandContext} CommandContext
 * @typedef {{ intervalMs: number; deadline: number }} Waiting
 */

/**
 * @param {CommandContext} ctx
 * @param {() => Waiting} startWaiting the `--timeout`/`--interval` budget, read when a wait begins
 * @returns {Promise<number>}
 */
export async function approve(ctx, startWaiting) {
  const { io } = ctx;
  if (ctx.positionals.length !== 2) {
    throw new CliError("usage: drydock approve <stage-id | package@version>", 2);
  }
  if (ctx.values.json) throw new CliError("approve is interactive and has no --json output", 2);
  const prompt = io.prompt;
  const runNpm = io.runNpm;
  if (!io.interactive || !prompt || !runNpm) throw new CliError(NO_TERMINAL, 2);
  const target = parseTarget(ctx.positionals[1]);

  let found = await findStagedReview(ctx, target);
  if (!found) found = await startStagedReview(ctx, target);
  const id = String(found.id);

  if (found.status !== "complete") {
    const started = io.now();
    const final = await waitForReview(ctx, id, startWaiting(), (scan) => {
      const seconds = Math.round((io.now() - started) / 1000);
      io.stderr(
        `waiting for review ${clean(id)}: ${clean(scan?.status ?? "pending")} (${seconds}s)\n`,
      );
    });
    if (final.status === "failed") {
      throw new CliError(`review ${id} failed, so there is nothing to decide on yet`);
    }
  }

  const detail = await ctx.client.json(`/api/v1/scans/${pathSegment(id, "review id")}`);
  const scan = detail?.scan ?? {};
  const label = `${clean(scan.packageName)}@${clean(scan.stagedVersion)}`;
  assertDecidable(scan, target, label);
  const stageId = String(scan.stageId);
  const registry = registryArgs(scan.registryUrl);
  const link = reportLink(ctx.baseUrl, id, scan.organizationId);

  io.stdout(`${formatApprovalSummary(detail, link)}\n`);
  if (scan.decision) {
    io.stdout(
      `\nAlready decided: ${scan.decision === "publish" ? "publish" : "reject"}${scan.decidedByName ? ` by ${clean(scan.decidedByName)}` : ""}. A new decision replaces it.\n`,
    );
  }
  io.stdout("\n");

  const decision = await askDecision(prompt, io, label);
  const reason = decision ? await askReason(prompt, io) : null;
  if (!decision || reason === null) {
    throw new CliError("no decision made: Drydock recorded nothing and npm was not run");
  }

  try {
    await ctx.client.json(`/api/v1/scans/${pathSegment(id, "review id")}/decision`, {
      method: "POST",
      body: reason ? { decision, reason } : { decision },
    });
  } catch (err) {
    if (err instanceof CliError) {
      // Only a refusal proves nothing was written; a 5xx or a lost response
      // may follow a committed decision.
      const refused = typeof err.status === "number" && err.status >= 400 && err.status < 500;
      throw new CliError(
        refused
          ? `${err.message}. Drydock recorded nothing and npm was not run.`
          : `${err.message}. Drydock may have recorded the decision; check ${link}. npm was not run.`,
        err.exitCode,
      );
    }
    throw err;
  }
  const verdict = decision === "publish" ? "publish" : "reject";
  io.stdout(`Drydock recorded: ${verdict}${reason ? ` (${clean(reason)})` : ""}\n`);

  if (decision === "publish") {
    const args = ["stage", "approve", stageId, ...registry];
    io.stderr(
      `Running npm ${args.join(" ")}. npm asks for your one-time password itself; Drydock never sees it.\n`,
    );
    const result = await runNpm(args);
    if (result.code === 0 && !result.error) {
      io.stdout(`npm approved the stage: ${label} is published.\n`);
      return 0;
    }
    io.stderr(npmFailure("publish", "approve", result, label, args));
    return EXIT_NPM_FAILED;
  }

  const args = ["stage", "reject", stageId, ...registry];
  io.stdout(
    `${label} is still staged on npm. To remove it there, run: npm ${args.join(" ")}\n` +
      "npm asks for your one-time password, and rejecting permanently removes the staged version.\n",
  );
  const runNow = await prompt("Run it now? [y/N] ");
  if (!/^(y|yes)$/i.test(runNow?.trim() ?? "")) return 0;
  const result = await runNpm(args);
  if (result.code === 0 && !result.error) {
    io.stdout(`npm rejected the stage: ${label} is no longer staged.\n`);
    return 0;
  }
  io.stderr(npmFailure("reject", "reject", result, label, args));
  return EXIT_NPM_FAILED;
}

/**
 * @param {string} value
 * @returns {{ stageId: string } | { packageName: string; version: string }}
 */
function parseTarget(value) {
  const at = value.lastIndexOf("@");
  if (at > 0) {
    const packageName = value.slice(0, at).trim();
    const version = value.slice(at + 1).trim();
    if (packageName && version) return { packageName, version };
  }
  if (!STAGE_ID_RE.test(value)) {
    throw new CliError(`expected an npm stage id or <package>@<version>, got: ${value}`, 2);
  }
  return { stageId: value };
}

/**
 * The newest staged review of the target that did not fail, or null. Lists
 * are newest first, so a stage that was just published is on the first page.
 * @param {CommandContext} ctx
 * @param {{ stageId: string } | { packageName: string; version: string }} target
 */
async function findStagedReview(ctx, target) {
  let cursor = null;
  for (let page = 0; page < LOOKUP_PAGES; page += 1) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (cursor) params.set("cursor", cursor);
    /** @type {any[]} */
    let rows;
    /** @type {any} */
    let body;
    if ("stageId" in target) {
      params.set("filter", "all");
      body = await ctx.client.json(`/api/v1/scans?${params}`);
      rows = (Array.isArray(body?.scans) ? body.scans : []).filter(
        (/** @type {any} */ scan) => scan?.stageId === target.stageId,
      );
    } else {
      params.set("ecosystem", "npm");
      body = await ctx.client.json(
        `/api/v1/packages/${packagePath(target.packageName)}/releases?${params}`,
      );
      rows = (Array.isArray(body?.releases) ? body.releases : []).filter(
        (/** @type {any} */ release) => release?.stagedVersion === target.version,
      );
    }
    const match = rows.find(
      (row) => STAGED_SOURCES.has(row?.source) && row?.status !== "failed" && row?.id,
    );
    if (match) return match;
    cursor = typeof body?.nextCursor === "string" && body.nextCursor ? body.nextCursor : null;
    if (!cursor) break;
  }
  return null;
}

/**
 * No usable review yet: start one through the scan-access routes, the same
 * way `scans start --stage` and `check-npm` do.
 * @param {CommandContext} ctx
 * @param {{ stageId: string } | { packageName: string; version: string }} target
 */
async function startStagedReview(ctx, target) {
  if ("stageId" in target) {
    const started = await ctx.client.json("/api/v1/scans", {
      method: "POST",
      body: { stageId: target.stageId },
    });
    const scan = started?.scan;
    if (typeof scan?.id !== "string" || !scan.id) {
      throw new CliError("Drydock did not return a review id");
    }
    ctx.io.stderr(`no review of this stage yet; started review ${clean(scan.id)}\n`);
    return scan;
  }
  const result = await ctx.client.json("/api/v1/staged-publishes/scan", { method: "POST" });
  const started = (Array.isArray(result?.scans) ? result.scans : []).find(
    (/** @type {any} */ scan) =>
      scan?.packageName === target.packageName && scan?.version === target.version,
  );
  if (typeof started?.id === "string" && started.id) {
    ctx.io.stderr(`checked npm; started review ${clean(started.id)}\n`);
    return { id: started.id, status: "pending" };
  }
  // Discovery skips a stage that already has a review, which may have been
  // created since the lookup above.
  const found = await findStagedReview(ctx, target);
  if (found) return found;
  throw new CliError(
    `npm lists no staged publish of ${target.packageName}@${target.version} that this organization's npm token can see; pass the stage id from "npm stage publish"`,
  );
}

/** @param {string} name */
function packagePath(name) {
  return name
    .split("/")
    .map((segment) => pathSegment(segment, "package name"))
    .join("/");
}

/**
 * @param {any} scan
 * @param {{ stageId: string } | { packageName: string; version: string }} target
 * @param {string} label
 */
function assertDecidable(scan, target, label) {
  if (!STAGED_SOURCES.has(scan.source) || scan.gateId) {
    throw new CliError(
      `${label} is not a staged npm publish review; decide workflow gates and published-release reviews in Drydock`,
    );
  }
  if (scan.status !== "complete") throw new CliError(`the review of ${label} has not completed`);
  if (scan.registryStatusSupersededAt) {
    throw new CliError(`a newer stage of ${label} replaced this one; approve that stage instead`);
  }
  if (SETTLED_REGISTRY_STATUSES.has(scan.registryVersionStatus)) {
    throw new CliError(
      `npm already reports ${label} as ${clean(scan.registryVersionStatus)}; there is no stage left to approve`,
    );
  }
  const stageId = typeof scan.stageId === "string" ? scan.stageId : "";
  if (!STAGE_ID_RE.test(stageId) || ("stageId" in target && stageId !== target.stageId)) {
    throw new CliError(`the review of ${label} names a stage id the CLI will not pass to npm`);
  }
}

/**
 * `--registry` for the registry the stage lives on, so npm talks to the same
 * registry Drydock reviewed. npm picks its own credentials for that registry
 * from the user's configuration; the CLI never reads them. The URL becomes an
 * argument, so only a plain https (or loopback http) origin and path pass.
 * @param {unknown} value
 * @returns {string[]}
 */
function registryArgs(value) {
  if (value === null || value === undefined || value === "") return [];
  let url;
  try {
    url = new URL(String(value));
  } catch {
    url = null;
  }
  const plain =
    url &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) &&
    /^[A-Za-z0-9:/._~\-[\]]+$/.test(String(value));
  if (!plain) {
    throw new CliError(
      `this review names a registry the CLI will not pass to npm: ${clean(value)}`,
    );
  }
  return ["--registry", String(value)];
}

/**
 * @param {string} baseUrl
 * @param {string} id
 * @param {unknown} organizationId
 */
function reportLink(baseUrl, id, organizationId) {
  const org = typeof organizationId === "string" && organizationId ? organizationId : null;
  return `${baseUrl}/dashboard/scans/${encodeURIComponent(id)}${org ? `?org=${encodeURIComponent(org)}` : ""}`;
}

/**
 * @param {(question: string) => Promise<string | null>} prompt
 * @param {{ stderr: (text: string) => void }} io
 * @param {string} label
 * @returns {Promise<"publish" | "no_publish" | null>} null when the user skips or ends input
 */
async function askDecision(prompt, io, label) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = await prompt(`Decide ${label}: publish, reject, or skip? [p/r/s] `);
    if (answer === null) return null;
    const value = answer.trim().toLowerCase();
    if (value === "p" || value === "publish") return "publish";
    if (value === "r" || value === "reject") return "no_publish";
    if (value === "" || value === "s" || value === "skip") return null;
    io.stderr("Answer publish, reject, or skip.\n");
  }
  return null;
}

/**
 * @param {(question: string) => Promise<string | null>} prompt
 * @param {{ stderr: (text: string) => void }} io
 * @returns {Promise<string | null>} "" for no reason; null when input ends
 */
async function askReason(prompt, io) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = await prompt("Reason (optional, Enter for none): ");
    if (answer === null) return null;
    const reason = answer.trim();
    if (reason.length <= REASON_MAX) return reason;
    io.stderr(`Keep the reason to ${REASON_MAX} characters.\n`);
  }
  return null;
}

/**
 * @param {"publish" | "reject"} verdict
 * @param {"approve" | "reject"} action
 * @param {NpmResult} result
 * @param {string} label
 * @param {string[]} args
 */
function npmFailure(verdict, action, result, label, args) {
  const why = result.error
    ? `npm could not be run: ${clean(result.error)}`
    : result.signal
      ? `npm was stopped by ${clean(result.signal)}`
      : `npm exited with ${result.code}`;
  return [
    `Drydock recorded your ${verdict} decision, but npm did not ${action} the stage (${why}).`,
    `${label} is still staged on npm. Retry with: npm ${args.join(" ")}`,
    "",
  ].join("\n");
}

/** @param {unknown} value */
function asObject(value) {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" ? /** @type {Record<string, any>} */ (value) : null;
}

/**
 * What the review compared the stage against. npm marks a baseline it could
 * not download only by leaving the manifest diff without a previous manifest,
 * with the baseline it picked still named; PyPI sets `comparisonSkipped`.
 * Either way the diff then lists everything as added, so the facts are
 * unknown. Only a baseline lookup that found no earlier release ("none") is a
 * first release.
 * @param {any} detail
 * @returns {{ label: string; version: string | null; unknown: string | null }}
 */
function comparedAgainst(detail) {
  const scan = detail?.scan ?? {};
  const summary = asObject(scan.summaryJson);
  const manifest = asObject(summary?.packageJsonDiff);
  const baseline = asObject(summary?.baseline);
  const picked =
    typeof baseline?.version === "string" && baseline.version ? baseline.version : null;
  const version = scan.previousVersion || manifest?.previousVersion || picked || null;
  const notDownloaded = (/** @type {string | null} */ named) => ({
    label: named ? `${clean(named)} (not downloaded for comparison)` : "unknown",
    version: named,
    unknown: named
      ? `the previous release ${clean(named)} was not downloaded for comparison`
      : "the review could not tell which release came before",
  });
  if (baseline?.comparisonSkipped) return notDownloaded(version);
  if (manifest && manifest.hasPreviousManifest === false) {
    if (baseline && !picked && baseline.reason === "none") {
      return { label: "none (first release)", version: null, unknown: null };
    }
    return notDownloaded(picked);
  }
  return { label: version ? clean(version) : "unknown", version, unknown: null };
}

/**
 * The three install-path facts against the previous release, from the
 * review's manifest diff and release-delta findings. A fact the review cannot
 * support is null and prints as unknown, never as "none".
 * @param {any} detail
 */
function releaseFacts(detail) {
  const summary = asObject(detail?.scan?.summaryJson);
  const manifest = asObject(summary?.packageJsonDiff);
  const findings = Array.isArray(detail?.findings) ? detail.findings : [];
  /**
   * @param {(finding: any) => boolean} match
   * @returns {any[]}
   */
  const newFindings = (match) =>
    findings.filter(
      (/** @type {any} */ finding) => finding?.releaseDelta === true && match(finding),
    );

  let unknown = null;
  if (!manifest) unknown = "the review has no package.json comparison";
  else if (comparedAgainst(detail).unknown) {
    unknown = comparedAgainst(detail).unknown;
  } else if (
    findings.some((/** @type {any} */ finding) => finding?.ruleId === "package-json.parse-failed")
  ) {
    unknown = "package.json could not be parsed";
  }
  if (unknown || !manifest) {
    return { scripts: null, dependencies: null, executables: null, unknown };
  }

  /** @param {unknown} entries */
  const rows = (entries) => (Array.isArray(entries) ? entries : null);

  const scriptRows = rows(manifest.scripts);
  const scripts = scriptRows
    ? [
        ...scriptRows
          .filter((entry) => INSTALL_SCRIPTS.has(entry?.key) && entry?.status !== "removed")
          .map(
            (entry) =>
              `${clean(entry.key, 40)} ${entry.status === "added" ? "added" : "changed"}: ${clean(entry.staged, 80)}`,
          ),
        ...newFindings((finding) => INSTALL_TIME_RULES.has(finding.ruleId)).map(
          (finding) => `${clean(finding.ruleId, 60)} in ${clean(finding.file, 80)}`,
        ),
      ]
    : null;

  const dependencyRows = rows(manifest.dependencies);
  const dependencies = dependencyRows
    ? [
        ...new Set(
          dependencyRows
            .filter(
              (entry) =>
                entry?.status === "added" &&
                !entry.previouslyDeclared &&
                !entry.previouslyInstalled,
            )
            .map(
              (entry) =>
                `${clean(entry.key, 80)} ${clean(entry.staged, 40)}${entry.section && entry.section !== "dependencies" ? ` (${clean(entry.section, 30)})` : ""}`,
            ),
        ),
      ]
    : null;

  // Reviews recorded before the bin map was diffed carry no `bin` rows.
  const binRows = rows(manifest.bin);
  const executables = binRows
    ? [
        ...binRows
          .filter((entry) => entry?.status === "added" || entry?.status === "modified")
          .map(
            (entry) =>
              `command ${clean(entry.key, 40)} ${entry.status === "added" ? "added" : "changed"}: ${clean(entry.staged, 80)}`,
          ),
        ...newFindings((finding) => finding.ruleId === "file.native-artifact").map(
          (finding) => `native binary ${clean(finding.file, 80)}`,
        ),
      ]
    : null;

  return { scripts, dependencies, executables, unknown: null };
}

/**
 * @param {string[] | null} items
 * @param {string | null} unknown
 */
function factText(items, unknown) {
  if (items === null) return `unknown${unknown ? ` (${unknown})` : ""}`;
  if (items.length === 0) return "none";
  const shown = items.slice(0, LIST_ITEMS).join("; ");
  return items.length > LIST_ITEMS ? `${shown}; +${items.length - LIST_ITEMS} more` : shown;
}

const AI_ASSESSMENTS = /** @type {Record<string, string>} */ ({
  nothing_unusual: "nothing unusual",
  review_recommended: "review recommended",
  suspicious: "suspicious",
  blocked: "blocked",
});

/**
 * Mirrors `displayedAiResult`: a review the assistant did not complete is
 * "unavailable", never its fallback "low / nothing unusual".
 * @param {unknown} value
 * @returns {string[]}
 */
function aiLines(value) {
  const ai = asObject(value);
  if (!ai) return ["not run"];
  if (ai.status === "complete" && ai.releaseAssessment && ai.releaseAssessment !== "not_assessed") {
    const assessment = AI_ASSESSMENTS[ai.releaseAssessment] ?? clean(ai.releaseAssessment);
    const lines = [
      `${assessment} (AI risk ${clean(ai.risk)})${ai.requiresManualReview ? ", asks for a manual review" : ""}`,
    ];
    if (typeof ai.summary === "string" && ai.summary.trim()) lines.push(clean(ai.summary, 300));
    return lines;
  }
  return [`unavailable (${clean(ai.status === "complete" ? "invalid" : ai.status)})`];
}

/** @param {any} finding */
function severityRank(finding) {
  const rank = SEVERITY_ORDER.indexOf(finding?.severity);
  return rank === -1 ? SEVERITY_ORDER.length : rank;
}

/**
 * @param {any} detail the `GET /api/v1/scans/:id` response
 * @param {string} link
 */
function formatApprovalSummary(detail, link) {
  const scan = detail?.scan ?? {};
  const risk = detail?.riskSummary;
  const facts = releaseFacts(detail);
  const compared = comparedAgainst(detail);
  const previous = compared.label;
  const since = compared.version
    ? `Since ${clean(compared.version)}`
    : "Against the previous release";
  const ai = aiLines(scan.aiJson);
  const lines = [
    `package           ${clean(scan.packageName)}@${clean(scan.stagedVersion)}`,
    `stage             ${clean(scan.stageId)}`,
    `compared against  ${previous}`,
    `release risk      ${clean(risk?.releaseRisk ?? scan.risk)}${risk?.artifactRisk ? ` (package risk ${clean(risk.artifactRisk)})` : ""}`,
    `AI review         ${ai[0]}`,
    ...ai.slice(1).map((line) => `                  ${line}`),
    "",
    `${since}:`,
    `  install-time scripts   ${factText(facts.scripts, facts.unknown)}`,
    `  new dependencies       ${factText(facts.dependencies, facts.unknown)}`,
    `  new executables        ${factText(facts.executables, facts.unknown)}`,
    "",
  ];
  const findings = (Array.isArray(detail?.findings) ? [...detail.findings] : []).sort(
    (a, b) =>
      Number(b?.releaseDelta === true) - Number(a?.releaseDelta === true) ||
      severityRank(a) - severityRank(b),
  );
  if (findings.length === 0) {
    lines.push("No findings.");
  } else {
    const shown = findings.slice(0, TOP_FINDINGS);
    lines.push(`Top findings (${shown.length} of ${findings.length}):`);
    for (const finding of shown) {
      const location = finding.line
        ? `${clean(finding.file, 80)}:${clean(finding.line)}`
        : clean(finding.file, 80);
      const rule = clean(finding.ruleId ?? (finding.source === "ai" ? "ai-review" : "-"), 60);
      const marker = finding.releaseDelta === true ? "new " : "    ";
      lines.push(
        `  ${marker}${clean(finding.severity).padEnd(8)}  ${rule}  ${location}  ${clean(finding.reason, 120)}`,
      );
    }
  }
  lines.push(`Full report: ${link}`);
  return lines.join("\n");
}
