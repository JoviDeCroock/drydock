import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  approvalSql,
  buildAudit,
  INVENTORY_QUERY,
  parseInventory,
  parseAuditArgs,
  renderAudit,
  writePrivateArtifacts,
} from "../scripts/package-claims-audit.mjs";

const row = (overrides = {}) => ({
  id: "scan-1",
  stage_id: "stage-1",
  organization_id: "org-1",
  organization_name: "Example",
  organization_is_personal: 0,
  package_name: "example",
  staged_version: "1.0.0",
  registry_url: "https://registry.npmjs.org",
  registry_package_name: "example",
  registry_version: "1.0.0",
  source: "manual",
  status: "complete",
  created_at: 1,
  ...overrides,
});
const parse = (rows: unknown[]) => parseInventory([{ success: true, results: rows }]);
const approve = (rows: ReturnType<typeof row>[], overrides = {}) => ({
  inventory_sha256: buildAudit(rows).inventory_sha256,
  approvals: [
    {
      registry_url: rows[0].registry_url,
      package_name: rows[0].registry_package_name,
      organization_id: rows[0].organization_id,
      evidence_scan_id: rows[0].id,
      ...overrides,
    },
  ],
});
function database(rows: ReturnType<typeof row>[]) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE organizations(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL);
    CREATE TABLE scans(id TEXT PRIMARY KEY, stage_id TEXT, organization_id TEXT, package_name TEXT, staged_version TEXT, registry_url TEXT, registry_package_name TEXT, registry_version TEXT, source TEXT, status TEXT, created_at INTEGER);
    CREATE TABLE npm_package_claims(registry_url TEXT, ecosystem TEXT, package_name TEXT, organization_id TEXT, first_stage_id TEXT, claimed_at INTEGER, management_confirmed_at INTEGER, PRIMARY KEY(registry_url, ecosystem, package_name));`);
  for (const scan of rows) {
    db.prepare("INSERT OR IGNORE INTO organizations VALUES (?, ?, ?)").run(
      scan.organization_id,
      scan.organization_name,
      "owner-1",
    );
    db.prepare("INSERT INTO scans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      scan.id,
      scan.stage_id,
      scan.organization_id,
      scan.package_name,
      scan.staged_version,
      scan.registry_url,
      scan.registry_package_name,
      scan.registry_version,
      scan.source,
      scan.status,
      scan.created_at,
    );
  }
  return db;
}

describe("explicit public npm registry assumption", () => {
  const options = { assumePublicNpmRegistry: true };
  it("merges missing-URL history without modifying raw evidence or inferring package/version", () => {
    const rows = parse([
      row(),
      row({
        id: "legacy",
        organization_id: "other",
        registry_url: null,
        registry_package_name: null,
        registry_version: null,
      }),
    ]);
    const strict = buildAudit(rows);
    const assumed = buildAudit(rows, options);
    expect(assumed.assumptions).toEqual({ missing_registry_url: "https://registry.npmjs.org" });
    expect(assumed.inventory_sha256).not.toBe(strict.inventory_sha256);
    expect(assumed.packages).toHaveLength(1);
    expect(assumed.packages[0].collision).toBe(true);
    expect(assumed.packages[0].scans).toContainEqual(
      expect.objectContaining({
        id: "legacy",
        registry_url: null,
        registry_url_assumed: true,
        registry_package_name: null,
        registry_version: null,
        issues: [
          "missing_registry_url",
          "missing_registry_package_name",
          "missing_registry_version",
        ],
      }),
    );
    expect(renderAudit(assumed)).toContain("Explicit operator assumption");
    const selection = {
      ...approve(rows, { evidence_scan_id: "legacy", organization_id: "other" }),
      inventory_sha256: assumed.inventory_sha256,
    };
    expect(() => approvalSql(rows, selection, options)).toThrow(/evidence/);
  });
  it("allows missing URL alone only with assumption-bound approvals and revalidates raw NULL", () => {
    const rows = parse([row({ registry_url: null })]);
    const selection = {
      ...approve(rows, { registry_url: "https://registry.npmjs.org" }),
      inventory_sha256: buildAudit(rows, options).inventory_sha256,
    };
    expect(() => approvalSql(rows, selection)).toThrow(/Explicit/);
    expect(() => approvalSql(rows, approve(rows), options)).toThrow(/Explicit/);
    const sql = approvalSql(rows, selection, options);
    expect(sql).toContain("Missing registry URL assumption: https://registry.npmjs.org");
    const db = database(rows);
    db.exec(sql);
    expect(db.prepare("SELECT registry_url FROM npm_package_claims").get()?.registry_url).toBe(
      "https://registry.npmjs.org",
    );
    db.exec(
      "DELETE FROM npm_package_claims; UPDATE scans SET registry_url = 'https://registry.npmjs.org'",
    );
    expect(() => db.exec(sql)).toThrow(/malformed JSON/);
    db.close();
  });
  it.each(["https://custom.example", "http://localhost:8080", "not-a-url"])(
    "rejects a contradictory recorded registry: %s",
    (registry_url) => {
      const rows = parse([row({ registry_url })]);
      expect(() => buildAudit(rows, options)).toThrow(/contradicts/);
      expect(() => approvalSql(rows, approve(rows), options)).toThrow(/contradicts/);
      expect(() => buildAudit(rows)).not.toThrow();
    },
  );
  it("parses the assumption as an explicit boolean flag and rejects malformed arguments", () => {
    expect(
      parseAuditArgs([
        "--input",
        "input.json",
        "--assume-public-npm-registry",
        "--output",
        "private",
      ]),
    ).toEqual({
      "--input": "input.json",
      "--output": "private",
      "--assume-public-npm-registry": true,
    });
    expect(parseAuditArgs(["--input", "input.json", "--output", "private"])).not.toHaveProperty(
      "--assume-public-npm-registry",
    );
    expect(() =>
      parseAuditArgs(["--input", "--assume-public-npm-registry", "--output", "private"]),
    ).toThrow();
    expect(() =>
      parseAuditArgs([
        "--input",
        "input.json",
        "--output",
        "private",
        "--assume-public-npm-registry",
        "false",
      ]),
    ).toThrow();
  });
});

describe("private package ownership inventory", () => {
  it("groups collisions and preserves unknown registries without assigning owners", () => {
    const rows = parse([
      row(),
      row({
        id: "scan-2",
        organization_id: "org-2",
        organization_name: "Second",
        source: "auto_discovery",
        created_at: 5,
      }),
      row({
        id: "legacy",
        registry_url: null,
        registry_package_name: null,
        registry_version: null,
      }),
    ]);
    const audit = buildAudit(rows);
    expect(audit.packages).toHaveLength(2);
    expect(audit.packages.find((group) => group.registry_url !== null)?.related_history).toEqual([
      { registry_url: null, organization_ids: ["org-1"], scan_count: 1 },
    ]);
    expect(audit.packages.find((group) => group.registry_url !== null)?.collision).toBe(true);
    expect(audit.packages.find((group) => group.registry_url === null)?.scans[0].issues).toContain(
      "missing_registry_url",
    );
    expect(renderAudit(audit)).toContain("No owners have been approved");
  });
  it("rejects unexpected fields, failed exports, duplicate scans, and foreign sources", () => {
    expect(() => parse([row({ token: "never-output-this" })])).toThrow(/unexpected columns/);
    expect(() => parseInventory([{ success: false, results: [] }])).toThrow();
    expect(() => parse([row(), row()])).toThrow(/duplicate/);
    expect(() => parse([row({ source: "public_diff" })])).toThrow(/unsupported/);
  });
  it("requires explicit snapshot-bound approvals with matching organization and immutable identity", () => {
    const rows = parse([row()]);
    expect(() => approvalSql(rows, { ...approve(rows), approvals: [] })).toThrow(/Explicit/);
    expect(() => approvalSql(rows, { ...approve(rows), inventory_sha256: "old" })).toThrow(
      /Explicit/,
    );
    expect(() => approvalSql(rows, approve(rows, { organization_id: "other" }))).toThrow(
      /evidence/,
    );
    for (const change of [
      { registry_url: null },
      { registry_package_name: null },
      { package_name: "forged" },
      { staged_version: "9.0.0" },
    ]) {
      const invalid = parse([row(change)]);
      expect(() => approvalSql(invalid, approve(invalid))).toThrow(/evidence/);
    }
  });
});

describe("personal and shared approval management", () => {
  it("derives claim type from the organization's actual owner and writes all seven claim columns", () => {
    const rows = parse([
      row({ organization_id: "personal:owner-1", organization_is_personal: 1 }),
      row({
        id: "scan-2",
        organization_id: "shared-org",
        package_name: "second",
        registry_package_name: "second",
      }),
    ]);
    const audit = buildAudit(rows);
    expect(audit.packages.map((group) => group.organizations[0].claim_type)).toEqual([
      "personal_provisional",
      "shared_durable",
    ]);
    expect(renderAudit(audit)).toContain("personal_provisional");
    const db = database(rows);
    expect(parseInventory([{ success: true, results: db.prepare(INVENTORY_QUERY).all() }])).toEqual(
      rows,
    );
    const selected = approve(rows);
    selected.approvals.push({
      ...selected.approvals[0],
      organization_id: "shared-org",
      evidence_scan_id: "scan-2",
      package_name: "second",
    });
    db.exec(approvalSql(rows, selected));
    const claims = db.prepare("SELECT * FROM npm_package_claims ORDER BY package_name").all();
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({
      organization_id: "personal:owner-1",
      management_confirmed_at: null,
    });
    expect(claims[1]).toMatchObject({
      organization_id: "shared-org",
      management_confirmed_at: claims[1].claimed_at,
    });
    expect(claims[1].management_confirmed_at).toBeGreaterThan(0);
    db.close();
  });
  it("does not mistake an unmatched personal-looking organization ID for a personal workspace", () => {
    const rows = parse([row({ organization_id: "personal:someone-else" })]);
    const db = database(rows);
    expect(parseInventory([{ success: true, results: db.prepare(INVENTORY_QUERY).all() }])).toEqual(
      rows,
    );
    db.exec(approvalSql(rows, approve(rows)));
    expect(
      db.prepare("SELECT management_confirmed_at FROM npm_package_claims").get()
        ?.management_confirmed_at,
    ).toBeGreaterThan(0);
    db.close();
  });
  it("fails if personal workspace classification changes after the inventory was reviewed", () => {
    const rows = parse([row({ organization_id: "personal:owner-1", organization_is_personal: 1 })]);
    const db = database(rows);
    const sql = approvalSql(rows, approve(rows));
    db.exec("UPDATE organizations SET owner_user_id = 'new-owner'");
    expect(() => db.exec(sql)).toThrow(/malformed JSON/);
    expect(db.prepare("SELECT COUNT(*) AS count FROM npm_package_claims").get()?.count).toBe(0);
    db.close();
  });
  it("preserves a personal management decision and original claim evidence on repeated application", () => {
    const rows = parse([row({ organization_id: "personal:owner-1", organization_is_personal: 1 })]);
    const db = database(rows);
    const sql = approvalSql(rows, approve(rows));
    db.exec(sql);
    const original = db.prepare("SELECT * FROM npm_package_claims").get();
    db.exec("UPDATE npm_package_claims SET management_confirmed_at = 1234");
    db.exec(sql);
    expect(db.prepare("SELECT * FROM npm_package_claims").get()).toEqual({
      ...original,
      management_confirmed_at: 1234,
    });
    db.exec("UPDATE npm_package_claims SET organization_id = 'shared-owner'");
    expect(() => db.exec(sql)).toThrow(/malformed JSON/);
    expect(
      db.prepare("SELECT organization_id FROM npm_package_claims").get()?.organization_id,
    ).toBe("shared-owner");
    db.close();
  });
  it("rejects older exports without verified workspace classification", () => {
    const { organization_is_personal: _classification, ...oldRow } = row();
    expect(() => parse([oldRow])).toThrow(/unexpected columns/);
  });
});

describe("reviewed SQL applies atomically", () => {
  it("groups trailing-slash history under a canonical claim and revalidates both organizations", () => {
    const rows = parse([
      row({ registry_url: "https://registry.npmjs.org/" }),
      row({ id: "scan-2", organization_id: "other", organization_name: "Other" }),
    ]);
    expect(buildAudit(rows).packages).toHaveLength(1);
    expect(buildAudit(rows).packages[0]).toMatchObject({
      registry_url: "https://registry.npmjs.org",
      collision: true,
    });
    const selection = approve(rows, { registry_url: "https://registry.npmjs.org" });
    const sql = approvalSql(rows, selection);
    const db = database(rows);
    db.exec(sql);
    expect(db.prepare("SELECT registry_url FROM npm_package_claims").get()?.registry_url).toBe(
      "https://registry.npmjs.org",
    );
    db.exec(
      "DELETE FROM npm_package_claims; UPDATE scans SET status = 'failed' WHERE id = 'scan-2'",
    );
    expect(() => db.exec(sql)).toThrow(/malformed JSON/);
    expect(db.prepare("SELECT COUNT(*) AS count FROM npm_package_claims").get()?.count).toBe(0);
    db.close();
  });
  it.each([
    "https://REGISTRY.npmjs.org",
    "https://registry.npmjs.org:443",
    "https://registry.npmjs.org?token=secret",
    "https://user:secret@registry.npmjs.org",
    "http://registry.npmjs.org",
    "https://registry.npmjs.org#fragment",
    " https://registry.npmjs.org",
    "not-a-url",
    "https://registry.npmjs.org/path?",
    "https://registry.npmjs.org/path#",
  ])(
    "flags unsupported or noncanonical historical registry without approving it: %s",
    (registry_url) => {
      const rows = parse([row({ registry_url })]);
      expect(buildAudit(rows).packages[0].scans[0].issues).toContain(
        "unsupported_or_noncanonical_registry_url",
      );
      expect(() => approvalSql(rows, approve(rows))).toThrow(/evidence/);
    },
  );
  it("includes newly added slash-equivalent scans and conflicting claim keys in stale checks", () => {
    const rows = parse([row()]);
    const sql = approvalSql(rows, approve(rows));
    const db = database(rows);
    db.exec(
      "INSERT INTO scans SELECT 'new', stage_id, organization_id, package_name, staged_version, registry_url || '/', registry_package_name, registry_version, source, status, created_at FROM scans",
    );
    expect(() => db.exec(sql)).toThrow(/malformed JSON/);
    db.exec(
      "DELETE FROM scans WHERE id = 'new'; INSERT INTO npm_package_claims(registry_url, ecosystem, package_name, organization_id, first_stage_id, claimed_at) VALUES ('https://registry.npmjs.org/', 'npm', 'example', 'org-1', 'stage', 1)",
    );
    expect(() => db.exec(sql)).toThrow(/malformed JSON/);
    db.close();
  });

  it("uses the same projection as the export and safely quotes hostile SQL text", () => {
    const rows = parse([
      row({
        organization_id: "org'; DROP TABLE organizations; --",
        organization_name: "A <script>|name",
        stage_id: "a' OR 1=1 --",
      }),
    ]);
    const db = database(rows);
    expect(parseInventory([{ success: true, results: db.prepare(INVENTORY_QUERY).all() }])).toEqual(
      rows,
    );
    const sql = approvalSql(rows, approve(rows));
    db.exec(sql);
    db.exec(sql);
    expect(db.prepare("SELECT COUNT(*) AS count FROM organizations").get()?.count).toBe(1);
    expect(db.prepare("SELECT * FROM npm_package_claims").all()).toMatchObject([
      { organization_id: rows[0].organization_id, first_stage_id: rows[0].stage_id },
    ]);
    expect(renderAudit(buildAudit(rows))).not.toContain("<script>");
    db.close();
  });
  it.each([
    "UPDATE scans SET registry_package_name = 'changed'",
    "UPDATE scans SET status = 'failed'",
    "UPDATE organizations SET name = 'changed'",
    "DELETE FROM scans",
    "INSERT INTO scans SELECT 'new', stage_id, 'new-org', package_name, staged_version, registry_url, registry_package_name, registry_version, source, status, created_at FROM scans",
    "INSERT INTO scans SELECT 'legacy-new', stage_id, 'new-org', package_name, staged_version, NULL, NULL, NULL, source, status, created_at FROM scans",
    "INSERT INTO npm_package_claims(registry_url, ecosystem, package_name, organization_id, first_stage_id, claimed_at) VALUES ('https://registry.npmjs.org', 'npm', 'example', 'other', 'other-stage', 1)",
    "INSERT INTO npm_package_claims(registry_url, ecosystem, package_name, organization_id, first_stage_id, claimed_at) VALUES ('https://registry.npmjs.org', 'npm', 'example', NULL, 'other-stage', 1)",
    "INSERT INTO npm_package_claims(registry_url, ecosystem, package_name, organization_id, first_stage_id, claimed_at) VALUES ('*', 'npm', 'example', NULL, 'other-stage', 1)",
  ])("rejects stale or conflicting state: %s", (mutation) => {
    const rows = parse([row()]);
    const sql = approvalSql(rows, approve(rows));
    const db = database(rows);
    db.exec(mutation);
    expect(() => db.exec(sql)).toThrow(/malformed JSON/);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM npm_package_claims WHERE organization_id = 'org-1'")
        .get()?.count,
    ).toBe(0);
    db.close();
  });
  it("refuses oversized SQL artifacts before an operator can apply them", () => {
    const rows = parse(Array.from({ length: 300 }, (_, index) => row({ id: `scan-${index}` })));
    expect(() => approvalSql(rows, approve(rows))).toThrow(/statement budget/);
  });
  it("rolls back all package inserts if one approval has stale evidence", () => {
    const rows = parse([
      row(),
      row({ id: "scan-2", package_name: "second", registry_package_name: "second" }),
    ]);
    const selection = approve(rows);
    selection.approvals.push({
      ...selection.approvals[0],
      package_name: "second",
      evidence_scan_id: "scan-2",
    });
    const db = database(rows);
    const sql = approvalSql(rows, selection);
    db.exec("UPDATE scans SET status = 'failed' WHERE id = 'scan-2'");
    expect(() => db.exec(sql)).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM npm_package_claims").get()?.count).toBe(0);
    db.close();
  });
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
describe("private artifacts", () => {
  it("uses restrictive modes and refuses repository paths, symlinks, and overwrites", async () => {
    const base = await mkdtemp(path.join(await realpath(tmpdir()), "package-claims-test-"));
    directories.push(base);
    const output = path.join(base, "private");
    await writePrivateArtifacts(output, { "audit.md": "private" });
    expect((await stat(output)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(output, "audit.md"))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(output, "audit.md"), "utf8")).toBe("private");
    await expect(writePrivateArtifacts(output, { "audit.md": "overwrite" })).rejects.toThrow();
    await expect(
      writePrivateArtifacts(path.join(process.cwd(), "private-audit"), {}),
    ).rejects.toThrow(/repository/);
    await symlink(process.cwd(), path.join(base, "alias"));
    await expect(
      writePrivateArtifacts(path.join(base, "alias", "private-audit"), {}),
    ).rejects.toThrow(/symlink/);
  });
});
