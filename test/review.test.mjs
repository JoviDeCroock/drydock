import { describe, expect, test } from "vitest";
import {
  computeRisk,
  createPackageDiff,
  deterministicFindings,
  summarizePackageJsonDiff,
} from "../server/lib/review.ts";

describe("review", () => {
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

    const diff = createPackageDiff(before, staged);

    expect(diff.find((entry) => entry.path === "install.js")?.status).toBe("added");
    expect(diff.find((entry) => entry.path === "package.json")?.status).toBe("modified");
    expect(diff.find((entry) => entry.path === "old.js")?.status).toBe("removed");
    expect(diff.find((entry) => entry.path === "index.js")?.status).toBe("unchanged");
  });

  test("deterministic policy escalates risky new staged changes", () => {
    const staged = [
      { path: "package.json", size: 70, sha256: "d", flags: [], textSample: JSON.stringify({ scripts: { preinstall: "node install.js" } }) },
      { path: "install.js", size: 30, sha256: "e", flags: [], textSample: "process.env.NPM_TOKEN; new Function('return 1')" },
    ];
    const diff = createPackageDiff([], staged);
    const findings = deterministicFindings(staged, diff);

    expect(computeRisk(findings)).toBe("critical");
    expect(findings.some((finding) => finding.evidence.includes("preinstall"))).toBe(true);
    expect(findings.some((finding) => finding.evidence.includes("secret/environment access"))).toBe(true);
  });

  test("package json diff summarizes release-review sensitive fields", () => {
    const summary = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", scripts: {}, dependencies: { a: "1.0.0" }, main: "index.js" },
      { name: "pkg", version: "1.0.1", scripts: { postinstall: "node install.js" }, dependencies: { a: "1.1.0", b: "2.0.0" }, main: "dist/index.js" },
    );

    expect(summary.previousVersion).toBe("1.0.0");
    expect(summary.stagedVersion).toBe("1.0.1");
    expect(summary.scripts).toEqual([{ key: "postinstall", status: "added", staged: "node install.js" }]);
    expect(summary.entrypointsChanged).toBe(true);
  });
});
