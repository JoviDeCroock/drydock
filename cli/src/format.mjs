// @ts-check

// Human-readable output. Package names, file paths, and finding text come from
// packages under review, so every server string is stripped of control and
// bidi-override characters before it reaches a terminal: an escape sequence in a
// hostile package's README must not be able to rewrite what the reviewer sees.
// `--json` output escapes the same characters as `\uXXXX`, which leaves the JSON
// value unchanged.

// C0/C1 controls (including ESC and newlines), DEL, and Unicode format controls
// (zero-width, bidi overrides and isolates, line/paragraph separators) that
// can reorder or hide text.
// eslint-disable-next-line no-control-regex -- stripping C0/C1 is the point
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
// The same set minus C0, which JSON.stringify already escapes inside strings
// and which is the structural whitespace of pretty-printed JSON.
const UNSAFE_JSON_TEXT = /[\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/**
 * Pretty JSON with every unsafe character escaped. JSON.stringify escapes only
 * C0 controls; DEL, C1 controls (including the one-byte CSI) and bidi overrides
 * would otherwise reach the terminal raw.
 * @param {unknown} value
 */
export function terminalSafeJson(value) {
  return JSON.stringify(value, null, 2).replace(
    UNSAFE_JSON_TEXT,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function clean(value, max = 200) {
  if (value === null || value === undefined) return "-";
  const text = String(value).replace(UNSAFE_TEXT, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text || "-";
}

/** @param {unknown} value */
function when(value) {
  if (typeof value !== "string" || !value) return "-";
  return clean(value.replace(/\.\d{3}Z$/, "Z").replace("T", " "));
}

/**
 * @param {string[]} headers
 * @param {string[][]} rows
 */
function table(headers, rows) {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column].length)),
  );
  const line = (/** @type {string[]} */ cells) =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column])))
      .join("  ");
  return [line(headers), ...rows.map(line)].join("\n");
}

/** @param {{ name?: unknown; stagedVersion?: unknown; packageName?: unknown }} item */
function packageLabel(item) {
  const name = item.packageName ?? item.name;
  const version = item.stagedVersion;
  return version ? `${clean(name)}@${clean(version)}` : clean(name);
}

/** @param {any} body */
export function formatWhoami(body) {
  return [
    `organization  ${clean(body.organization?.name)} (${clean(body.organization?.id)})`,
    `key           ${clean(body.key?.name)} (${clean(body.key?.prefix)}…)`,
    `expires       ${when(body.key?.expiresAt)}`,
    `access        ${clean(body.access)}`,
  ].join("\n");
}

/** @param {any} body */
export function formatScanList(body) {
  const scans = Array.isArray(body.scans) ? body.scans : [];
  if (scans.length === 0) return `No reviews match filter "${clean(body.filter)}".`;
  const rows = scans.map((/** @type {any} */ scan) => [
    clean(scan.id),
    packageLabel(scan),
    clean(scan.ecosystem),
    clean(scan.source),
    clean(scan.status),
    clean(scan.risk),
    clean(scan.decision ?? "undecided"),
    when(scan.createdAt),
  ]);
  const out = [
    table(["ID", "PACKAGE", "ECOSYSTEM", "SOURCE", "STATUS", "RISK", "DECISION", "CREATED"], rows),
  ];
  if (body.nextCursor) out.push(`\nmore: --cursor ${clean(body.nextCursor)}`);
  return out.join("\n");
}

/** @param {any[]} findings */
function formatFindings(findings) {
  if (findings.length === 0) return "No findings.";
  const rows = findings.map((finding) => [
    clean(finding.severity),
    clean(finding.ruleId ?? (finding.source === "ai" ? "ai-review" : "-")),
    finding.line ? `${clean(finding.file)}:${finding.line}` : clean(finding.file),
    clean(finding.reason, 120),
  ]);
  return table(["SEVERITY", "RULE", "LOCATION", "REASON"], rows);
}

/** @param {any} body */
export function formatScan(body) {
  const scan = body.scan ?? {};
  const risk = body.riskSummary;
  const lines = [
    `review     ${clean(scan.id)}`,
    `package    ${packageLabel(scan)}${scan.previousVersion ? ` (from ${clean(scan.previousVersion)})` : ""}`,
    `source     ${clean(scan.source)}`,
    `status     ${clean(scan.status)}`,
    `risk       ${clean(scan.risk)}${risk ? ` (release ${clean(risk.releaseRisk)}, context ${clean(risk.contextRisk)})` : ""}`,
    `decision   ${clean(scan.decision ?? "undecided")}${scan.decidedAt ? ` at ${when(scan.decidedAt)}` : ""}`,
    "",
    formatFindings(Array.isArray(body.findings) ? body.findings : []),
  ];
  return lines.join("\n");
}

/** @param {any} scan */
export function formatScanStatus(scan) {
  return `${clean(scan.id)}  ${packageLabel(scan)}  ${clean(scan.status)}  risk ${clean(scan.risk)}`;
}

/** @param {any} body */
export function formatReleases(body) {
  const releases = Array.isArray(body.releases) ? body.releases : [];
  const header = `${clean(body.package?.name)} (${clean(body.package?.ecosystem)}): ${Number(body.summary?.totalReviews ?? releases.length)} reviews`;
  if (releases.length === 0) return `${header}\nNo reviews of this package in this organization.`;
  const rows = releases.map((/** @type {any} */ release) => [
    clean(release.stagedVersion),
    clean(release.tag),
    clean(release.source),
    clean(release.status),
    clean(release.risk),
    clean(release.decision ?? "undecided"),
    clean(release.id),
  ]);
  const out = [
    header,
    "",
    table(["VERSION", "TAG", "SOURCE", "STATUS", "RISK", "DECISION", "REVIEW"], rows),
  ];
  if (body.nextCursor) out.push(`\nmore: --cursor ${clean(body.nextCursor)}`);
  return out.join("\n");
}

/** @param {any} body */
export function formatGate(body) {
  const gate = body.gate ?? {};
  const packages = Array.isArray(gate.packages) ? gate.packages : [];
  const lines = [
    `gate         ${clean(gate.id)}`,
    `repository   ${clean(gate.repositoryFullName)} (${clean(gate.environment)}, run ${clean(gate.runId)})`,
    `status       ${clean(gate.status)}${gate.decision ? `, ${clean(gate.decision)}` : ""}`,
    "",
  ];
  const rows = packages.map((/** @type {any} */ pkg) => [
    pkg.version ? `${clean(pkg.packageName)}@${clean(pkg.version)}` : clean(pkg.packageName),
    clean(pkg.status),
    clean(pkg.releaseRisk),
    clean(pkg.decision ?? "undecided"),
    clean(pkg.scanId),
  ]);
  lines.push(
    rows.length
      ? table(["PACKAGE", "STATUS", "RELEASE RISK", "DECISION", "REVIEW"], rows)
      : "No packages yet.",
  );
  return lines.join("\n");
}

/** @param {any} body */
export function formatDiff(body) {
  const diff = Array.isArray(body.diff) ? body.diff : [];
  const changed = diff.filter((/** @type {any} */ entry) => entry.status !== "unchanged").length;
  const lines = [
    `${clean(body.packageName)} ${clean(body.fromVersion)} → ${clean(body.toVersion)} (${clean(body.ecosystem)})`,
    `${changed} changed files · release risk ${clean(body.risk?.releaseRisk)} · package risk ${clean(body.risk?.artifactRisk)}`,
  ];
  for (const notice of Array.isArray(body.notices) ? body.notices : []) {
    lines.push(`note: ${clean(notice)}`);
  }
  lines.push("", formatFindings(Array.isArray(body.findings) ? body.findings : []));
  return lines.join("\n");
}
