import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function importTs(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

const ownership = await importTs("../server/lib/ownership.ts");

test("personal organization ids are stable per user", () => {
  assert.equal(ownership.personalOrganizationId("user_123"), "personal:user_123");
  assert.equal(ownership.personalOrganizationId("user_123"), ownership.personalOrganizationId("user_123"));
  assert.notEqual(ownership.personalOrganizationId("user_123"), ownership.personalOrganizationId("user_456"));
});

test("scan organization guard only allows matching organizations", () => {
  assert.equal(ownership.scanBelongsToOrganization({ organizationId: "org_a" }, "org_a"), true);
  assert.equal(ownership.scanBelongsToOrganization({ organizationId: "org_b" }, "org_a"), false);
  assert.equal(ownership.scanBelongsToOrganization({ organizationId: null }, "org_a"), false);
});
