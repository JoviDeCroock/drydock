import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function importTs(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

const review = await importTs("../server/lib/review.ts");

test("diff highlights added modified and removed package files", () => {
  const before = [
    { path: "package.json", size: 40, sha256: "a", flags: [], textSample: JSON.stringify({ name: "pkg", version: "1.0.0" }) },
    { path: "index.js", size: 10, sha256: "b", flags: [], textSample: "export {}" },
    { path: "old.js", size: 10, sha256: "c", flags: [], textSample: "" },
  ];
  const staged = [
    { path: "package.json", size: 70, sha256: "d", flags: [], textSample: JSON.stringify({ name: "pkg", version: "1.0.1", scripts: { postinstall: "node install.js" } }) },
    { path: "index.js", size: 10, sha256: "b", flags: [], textSample: "export {}" },
    { path: "install.js", size: 30, sha256: "e", flags: [], textSample: "require('child_process').execSync('curl https://x')" },
  ];

  const diff = review.createPackageDiff(before, staged);

  assert.equal(diff.find((entry) => entry.path === "install.js")?.status, "added");
  assert.equal(diff.find((entry) => entry.path === "package.json")?.status, "modified");
  assert.equal(diff.find((entry) => entry.path === "old.js")?.status, "removed");
  assert.equal(diff.find((entry) => entry.path === "index.js")?.status, "unchanged");
});

test("deterministic policy escalates risky new staged changes", () => {
  const staged = [
    { path: "package.json", size: 70, sha256: "d", flags: [], textSample: JSON.stringify({ scripts: { preinstall: "node install.js" } }) },
    { path: "install.js", size: 30, sha256: "e", flags: [], textSample: "process.env.NPM_TOKEN; new Function('return 1')" },
  ];
  const diff = review.createPackageDiff([], staged);
  const findings = review.deterministicFindings(staged, diff);

  assert.equal(review.computeRisk(findings), "critical");
  assert.ok(findings.some((finding) => finding.evidence.includes("preinstall")));
  assert.ok(findings.some((finding) => finding.evidence.includes("secret/environment access")));
});

test("package json diff summarizes release-review sensitive fields", () => {
  const summary = review.summarizePackageJsonDiff(
    { name: "pkg", version: "1.0.0", scripts: {}, dependencies: { a: "1.0.0" }, main: "index.js" },
    { name: "pkg", version: "1.0.1", scripts: { postinstall: "node install.js" }, dependencies: { a: "1.1.0", b: "2.0.0" }, main: "dist/index.js" },
  );

  assert.equal(summary.previousVersion, "1.0.0");
  assert.equal(summary.stagedVersion, "1.0.1");
  assert.deepEqual(summary.scripts, [{ key: "postinstall", status: "added", staged: "node install.js" }]);
  assert.equal(summary.entrypointsChanged, true);
});
