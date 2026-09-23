#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const columns = [
  "id",
  "stage_id",
  "organization_id",
  "organization_name",
  "package_name",
  "staged_version",
  "registry_url",
  "registry_package_name",
  "registry_version",
  "source",
  "status",
  "created_at",
];
export const INVENTORY_QUERY = `SELECT ${columns.map((column) => (column === "organization_name" ? "o.name AS organization_name" : `s.${column}`)).join(", ")} FROM scans s LEFT JOIN organizations o ON o.id = s.organization_id WHERE s.source IN ('manual', 'auto_discovery') ORDER BY s.id;`;
const nullable = new Set([
  "organization_id",
  "organization_name",
  "package_name",
  "staged_version",
  "registry_url",
  "registry_package_name",
  "registry_version",
]);
const sqlString = (value) =>
  value === null
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : `'${value.replaceAll("'", "''")}'`;
// The operator tool only accepts stored canonical URLs and the historical
// trailing-slash variant. Unlike connection setup, it never silently repairs
// whitespace, credentials, host casing, default ports, query strings, or fragments.
function canonicalRegistry(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    const canonical = url.toString().replace(/\/$/, "");
    return value.replace(/\/+$/, "") === canonical ? canonical : null;
  } catch {
    return null;
  }
}
const PUBLIC_NPM = "https://registry.npmjs.org";
const registryIdentity = (row, options = {}) =>
  row.registry_url === null && options.assumePublicNpmRegistry === true
    ? PUBLIC_NPM
    : (canonicalRegistry(row.registry_url) ?? row.registry_url);
const key = (row, options = {}) =>
  JSON.stringify([
    registryIdentity(row, options),
    "npm",
    row.registry_package_name ?? row.package_name,
  ]);

export function parseInventory(input) {
  if (
    !Array.isArray(input) ||
    input.length !== 1 ||
    input[0].success !== true ||
    !Array.isArray(input[0].results)
  ) {
    throw new Error("Expected one successful D1 --json SELECT result");
  }
  const ids = new Set();
  return input[0].results
    .map((row) => {
      if (
        !row ||
        Object.keys(row).length !== columns.length ||
        Object.keys(row).some((column) => !columns.includes(column))
      ) {
        throw new Error("Inventory has unexpected columns; use --query");
      }
      for (const column of columns) {
        const value = row[column];
        if (
          column === "created_at"
            ? !Number.isSafeInteger(value)
            : !(nullable.has(column) && value === null) &&
              (typeof value !== "string" || !value || value.includes("\0"))
        ) {
          throw new Error("Inventory has an invalid field");
        }
      }
      if (!["manual", "auto_discovery"].includes(row.source) || ids.has(row.id))
        throw new Error("Inventory has duplicate or unsupported scans");
      ids.add(row.id);
      return Object.fromEntries(columns.map((column) => [column, row[column]]));
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function issues(row) {
  return [
    !row.registry_url && "missing_registry_url",
    row.registry_url &&
      !canonicalRegistry(row.registry_url) &&
      "unsupported_or_noncanonical_registry_url",
    !row.registry_package_name && "missing_registry_package_name",
    !row.registry_version && "missing_registry_version",
    (!row.organization_id || !row.organization_name) && "missing_organization",
    row.registry_package_name &&
      row.package_name &&
      row.registry_package_name !== row.package_name &&
      "package_identity_mismatch",
    row.registry_version &&
      row.staged_version &&
      row.registry_version !== row.staged_version &&
      "version_identity_mismatch",
  ].filter(Boolean);
}

export function buildAudit(rows, options = {}) {
  const assumesPublicNpm = options.assumePublicNpmRegistry === true;
  if (
    assumesPublicNpm &&
    rows.some(
      (row) => row.registry_url !== null && canonicalRegistry(row.registry_url) !== PUBLIC_NPM,
    )
  )
    throw new Error("Public npm registry assumption contradicts recorded registry evidence");
  const assumptions = { missing_registry_url: assumesPublicNpm ? PUBLIC_NPM : null };
  const groups = new Map();
  for (const row of rows) {
    const groupKey = key(row, options);
    if (!groups.has(groupKey))
      groups.set(groupKey, {
        registry_url: registryIdentity(row, options),
        ecosystem: "npm",
        package_name: row.registry_package_name ?? row.package_name,
        organizations: [],
        scans: [],
      });
    const group = groups.get(groupKey);
    group.scans.push({
      ...row,
      registry_url_assumed: assumesPublicNpm && row.registry_url === null,
      issues: issues(row),
    });
    let organization = group.organizations.find((org) => org.id === row.organization_id);
    if (!organization) {
      organization = {
        id: row.organization_id,
        name: row.organization_name,
        scan_count: 0,
        sources: Object.create(null),
        statuses: Object.create(null),
        first_seen: row.created_at,
        last_seen: row.created_at,
      };
      group.organizations.push(organization);
    }
    organization.scan_count++;
    organization.sources[row.source] = (organization.sources[row.source] ?? 0) + 1;
    organization.statuses[row.status] = (organization.statuses[row.status] ?? 0) + 1;
    organization.first_seen = Math.min(organization.first_seen, row.created_at);
    organization.last_seen = Math.max(organization.last_seen, row.created_at);
  }
  return {
    inventory_sha256: createHash("sha256")
      .update(JSON.stringify({ assumptions, rows }))
      .digest("hex"),
    assumptions,
    packages: [...groups.values()].map((group) => ({
      ...group,
      collision: group.organizations.length > 1,
      related_history: [...groups.values()]
        .filter(
          (other) =>
            other !== group &&
            group.package_name !== null &&
            other.package_name === group.package_name,
        )
        .map((other) => ({
          registry_url: other.registry_url,
          organization_ids: other.organizations.map((org) => org.id),
          scan_count: other.scans.length,
        })),
    })),
  };
}

const markdown = (value) =>
  String(value ?? "unknown").replace(
    /[&<>|`\r\n]/g,
    (character) => `&#${character.charCodeAt(0)};`,
  );
export function renderAudit(audit) {
  return `# Private npm package ownership audit\n\nNo owners have been approved. ${audit.assumptions.missing_registry_url ? "Explicit operator assumption: missing registry URLs refer to https://registry.npmjs.org. Raw missing URLs remain recorded; missing package names and versions still require independent evidence." : "Missing registry coordinates require separate investigation."} Manifest fields are not ownership evidence.\n\nInventory SHA-256: ${audit.inventory_sha256}\n\n| Registry | Package (observed) | Organizations | Scans | Collision | Issues | Same-name history (registry / orgs / scans) |\n| --- | --- | --- | --- | --- | --- | --- |\n${audit.packages.map((group) => `| ${markdown(group.registry_url)} | ${markdown(group.package_name)} | ${group.organizations.map((org) => `${markdown(org.name)} (${markdown(org.id)}): ${org.scan_count}`).join("; ")} | ${group.scans.length} | ${group.collision ? "yes" : "no"} | ${[...new Set(group.scans.flatMap((row) => row.issues))].join(", ")} | ${group.related_history.map((other) => `${markdown(other.registry_url)} / ${other.organization_ids.map(markdown).join(", ")} / ${other.scan_count}`).join("; ")} |`).join("\n")}\n\nSee inventory.json for first/last timestamps, status/source counts, and each evidence scan.\n`;
}

export function approvalSql(rows, selection, options = {}) {
  const audit = buildAudit(rows, options);
  if (
    selection?.inventory_sha256 !== audit.inventory_sha256 ||
    !Array.isArray(selection.approvals) ||
    selection.approvals.length === 0
  )
    throw new Error("Explicit approvals bound to this inventory are required");
  const seen = new Set();
  const guards = [];
  const values = [];
  for (const approval of selection.approvals) {
    const evidence = rows.find((row) => row.id === approval.evidence_scan_id);
    if (
      !evidence ||
      issues(evidence).some(
        (issue) => !(issue === "missing_registry_url" && options.assumePublicNpmRegistry === true),
      ) ||
      evidence.organization_id !== approval.organization_id ||
      registryIdentity(evidence, options) !== approval.registry_url ||
      evidence.registry_package_name !== approval.package_name
    )
      throw new Error("Approval does not match complete, consistent registry evidence");
    const registryUrl = registryIdentity(evidence, options);
    const claimKey = key(evidence, options);
    if (seen.has(claimKey)) throw new Error("Duplicate package approval");
    seen.add(claimKey);
    const packagePredicate = `s.source IN ('manual', 'auto_discovery') AND COALESCE(s.registry_package_name, s.package_name) = ${sqlString(evidence.registry_package_name)} AND (rtrim(s.registry_url, '/') = ${sqlString(registryUrl)} OR s.registry_url IS NULL)`;
    const related = rows.filter(
      (row) =>
        (row.registry_package_name ?? row.package_name) === evidence.registry_package_name &&
        (row.registry_url?.replace(/\/+$/, "") === registryUrl || row.registry_url === null),
    );
    // Compare every relevant row, including competing organizations and unknown
    // legacy registries. A new or changed row invalidates the reviewed snapshot.
    guards.push(`(SELECT COUNT(*) FROM scans s WHERE ${packagePredicate}) = ${related.length}`);
    for (const row of related) {
      guards.push(
        `EXISTS (SELECT 1 FROM scans s LEFT JOIN organizations o ON o.id = s.organization_id WHERE ${columns.map((column) => `${column === "organization_name" ? "o.name" : `s.${column}`} IS ${sqlString(row[column])}`).join(" AND ")})`,
      );
    }
    guards.push(
      `NOT EXISTS (SELECT 1 FROM npm_package_claims WHERE (registry_url = '*' OR rtrim(registry_url, '/') = ${sqlString(registryUrl)}) AND ecosystem = 'npm' AND package_name = ${sqlString(evidence.registry_package_name)} AND (organization_id IS NOT ${sqlString(evidence.organization_id)} OR registry_url != ${sqlString(registryUrl)}))`,
    );
    values.push(
      `(${[registryUrl, "npm", evidence.registry_package_name, evidence.organization_id, evidence.stage_id].map(sqlString).join(", ")})`,
    );
  }
  // One statement is atomic on SQLite/D1. An invalid JSON guard aborts the
  // entire INSERT; DO NOTHING only makes identical-owner reruns idempotent.
  const sql = `-- Private, explicitly reviewed ownership approvals. Never commit this file.\n-- Inventory SHA-256: ${audit.inventory_sha256}\n-- Missing registry URL assumption: ${audit.assumptions.missing_registry_url ?? "none"}\nWITH approved(registry_url, ecosystem, package_name, organization_id, first_stage_id) AS (VALUES\n${values.join(",\n")})\nINSERT INTO npm_package_claims (registry_url, ecosystem, package_name, organization_id, first_stage_id, claimed_at)\nSELECT registry_url, ecosystem, package_name, organization_id, first_stage_id, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM approved\nWHERE json_extract(CASE WHEN ${guards.join("\nAND ")} THEN '{"ok":1}' ELSE 'STALE_OR_CONFLICTING_PACKAGE_CLAIM_APPROVAL' END, '$.ok') = 1\nON CONFLICT(registry_url, ecosystem, package_name) DO NOTHING;\n`;
  if (Buffer.byteLength(sql, "utf8") > 90_000)
    throw new Error(
      "Approval SQL exceeds the conservative statement budget; approve fewer packages per artifact",
    );
  return sql;
}

export async function writePrivateArtifacts(output, files, repo = repositoryRoot) {
  const resolved = path.resolve(output);
  const relative = path.relative(await realpath(repo), resolved);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  )
    throw new Error("Refusing output inside repository");
  let ancestor = resolved;
  while (ancestor !== path.dirname(ancestor)) {
    const info = await lstat(ancestor).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error("Refusing symlink output path");
    ancestor = path.dirname(ancestor);
  }
  await mkdir(resolved, { mode: 0o700 });
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(path.join(resolved, name), contents, { mode: 0o600, flag: "wx" });
  }
}

export function parseAuditArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (options[flag]) throw new Error("Duplicate argument");
    if (flag === "--assume-public-npm-registry") {
      options[flag] = true;
      continue;
    }
    if (
      !["--input", "--output", "--approvals"].includes(flag) ||
      !argv[index + 1] ||
      argv[index + 1].startsWith("--")
    )
      throw new Error(
        "Usage: --query OR --input <D1 JSON> --output <new private directory> [--approvals <approved JSON>] [--assume-public-npm-registry]",
      );
    options[flag] = argv[++index];
  }
  if (!options["--input"] || !options["--output"])
    throw new Error("Input and new private output directory required");
  return options;
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === "--query") {
    process.stdout.write(`${INVENTORY_QUERY}\n`);
    return;
  }
  const options = parseAuditArgs(argv);
  const auditOptions = {
    assumePublicNpmRegistry: options["--assume-public-npm-registry"] === true,
  };
  const rows = parseInventory(JSON.parse(await readFile(options["--input"], "utf8")));
  const audit = buildAudit(rows, auditOptions);
  const files = {
    "inventory.json": `${JSON.stringify(audit, null, 2)}\n`,
    "audit.md": renderAudit(audit),
  };
  if (options["--approvals"])
    files["approved-claims.sql"] = approvalSql(
      rows,
      JSON.parse(await readFile(options["--approvals"], "utf8")),
      auditOptions,
    );
  await writePrivateArtifacts(options["--output"], files);
  process.stdout.write("Private audit artifacts written. No database changes executed.\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      "Package claims audit failed. Check input shape, explicit approvals, and private output path.\n",
    );
    process.exitCode = 1;
  });
}
