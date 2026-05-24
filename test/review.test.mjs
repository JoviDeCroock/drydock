import { describe, expect, test } from "vitest";
import {
  annotateFindingsWithDiffStatus,
  computeRisk,
  createPackageDiff,
  deterministicFindings,
  packageJsonDiffFindings,
  summarizePackageJsonDiff,
} from "../server/lib/review.ts";

describe("review", () => {
  test("diff highlights added modified and removed package files", () => {
    const before = [
      {
        path: "package.json",
        size: 40,
        sha256: "a",
        flags: [],
        textSample: JSON.stringify({ name: "pkg", version: "1.0.0" }),
      },
      { path: "index.js", size: 10, sha256: "b", flags: [], textSample: "export {}" },
      { path: "old.js", size: 10, sha256: "c", flags: [], textSample: "" },
    ];
    const staged = [
      {
        path: "package.json",
        size: 70,
        sha256: "d",
        flags: [],
        textSample: JSON.stringify({
          name: "pkg",
          version: "1.0.1",
          scripts: { postinstall: "node install.js" },
        }),
      },
      { path: "index.js", size: 10, sha256: "b", flags: [], textSample: "export {}" },
      {
        path: "install.js",
        size: 30,
        sha256: "e",
        flags: [],
        textSample: "require('child_process').execSync('curl https://x')",
      },
    ];

    const diff = createPackageDiff(before, staged);

    expect(diff.find((entry) => entry.path === "install.js")?.status).toBe("added");
    expect(diff.find((entry) => entry.path === "package.json")?.status).toBe("modified");
    expect(diff.find((entry) => entry.path === "old.js")?.status).toBe("removed");
    expect(diff.find((entry) => entry.path === "index.js")?.status).toBe("unchanged");
  });

  test("deterministic policy escalates risky new staged changes", () => {
    const staged = [
      {
        path: "package.json",
        size: 70,
        sha256: "d",
        flags: [],
        textSample: JSON.stringify({ scripts: { preinstall: "node install.js" } }),
      },
      {
        path: "install.js",
        size: 30,
        sha256: "e",
        flags: [],
        textSample: "process.env.NPM_TOKEN; new Function('return 1')",
      },
    ];
    const diff = createPackageDiff([], staged);
    const findings = deterministicFindings(staged, diff);

    expect(computeRisk(findings)).toBe("critical");
    expect(findings.some((finding) => finding.evidence.includes("preinstall"))).toBe(true);
    expect(findings.some((finding) => finding.evidence.includes("secret/environment access"))).toBe(
      true,
    );
  });

  test("adds best-effort line numbers and diff annotations to findings", () => {
    const before = [
      {
        path: "index.js",
        size: 20,
        sha256: "old",
        flags: [],
        textSample: "export const value = 1;\n",
      },
    ];
    const staged = [
      {
        path: "package.json",
        size: 120,
        sha256: "pkg",
        flags: [],
        textSample: `{
  "name": "pkg",
  "scripts": {
    "postinstall": "node install.js"
  }
}`,
      },
      {
        path: "index.js",
        size: 80,
        sha256: "new",
        flags: [],
        textSample: "export const value = 1;\nfetch('/debug');\n",
      },
    ];
    const diff = createPackageDiff(before, staged);
    const findings = deterministicFindings(staged, diff);

    expect(findings).toContainEqual(
      expect.objectContaining({
        file: "package.json",
        evidence: "postinstall: node install.js",
        line: 4,
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        file: "index.js",
        evidence: "new/changed modified file: network-capable code path",
        line: 2,
      }),
    );

    const annotated = annotateFindingsWithDiffStatus(findings, diff);
    expect(annotated.find((finding) => finding.file === "index.js")).toMatchObject({
      diffStatus: "modified",
      releaseDelta: true,
    });
    expect(annotated.find((finding) => finding.file === "package.json")).toMatchObject({
      diffStatus: "added",
      releaseDelta: true,
    });
  });

  test("keeps modified-file findings contextual when the finding line did not change", () => {
    const previous = [
      {
        path: "src/server.ts",
        size: 60,
        sha256: "old",
        flags: [],
        textSample: "fetch('/existing-risk');\nexport const value = 1;\n",
      },
    ];
    const staged = [
      {
        path: "src/server.ts",
        size: 60,
        sha256: "new",
        flags: [],
        textSample: "fetch('/existing-risk');\nexport const value = 2;\n",
      },
    ];
    const diff = createPackageDiff(previous, staged);
    const annotated = annotateFindingsWithDiffStatus(
      [
        {
          id: "existing-risk",
          severity: "medium",
          file: "src/server.ts",
          line: 1,
          evidence: "network-capable code path",
          reason: "existing network path",
        },
        {
          id: "changed-line",
          severity: "medium",
          file: "src/server.ts",
          line: 2,
          evidence: "changed value",
          reason: "changed release line",
        },
      ],
      diff,
      { previousFiles: previous, stagedFiles: staged },
    );

    expect(annotated.find((finding) => finding.id === "existing-risk")).toMatchObject({
      diffStatus: "modified",
      releaseDelta: false,
    });
    expect(annotated.find((finding) => finding.id === "changed-line")).toMatchObject({
      diffStatus: "modified",
      releaseDelta: true,
    });
  });

  test("keeps modified-file findings release scoped when a later matching line changed", () => {
    const previous = [
      {
        path: "src/server.ts",
        size: 60,
        sha256: "old",
        flags: [],
        textSample: "fetch('/existing-risk');\nexport const value = 1;\n",
      },
    ];
    const staged = [
      {
        path: "src/server.ts",
        size: 90,
        sha256: "new",
        flags: [],
        textSample:
          "fetch('/existing-risk');\nexport const value = 1;\nfetch('https://example.invalid/new-risk');\n",
      },
    ];
    const diff = createPackageDiff(previous, staged);
    const findings = deterministicFindings(staged, diff);
    const annotated = annotateFindingsWithDiffStatus(findings, diff, {
      previousFiles: previous,
      stagedFiles: staged,
    });

    expect(annotated.find((finding) => finding.ruleId === "code.network-access")).toMatchObject({
      line: 1,
      diffStatus: "modified",
      releaseDelta: true,
    });
  });

  test("package json diff summarizes release-review sensitive fields", () => {
    const summary = summarizePackageJsonDiff(
      {
        name: "pkg",
        version: "1.0.0",
        scripts: {},
        dependencies: { a: "1.0.0" },
        main: "index.js",
      },
      {
        name: "pkg",
        version: "1.0.1",
        scripts: { postinstall: "node install.js" },
        dependencies: { a: "1.1.0", b: "2.0.0" },
        main: "dist/index.js",
      },
    );

    expect(summary.previousVersion).toBe("1.0.0");
    expect(summary.stagedVersion).toBe("1.0.1");
    expect(summary.scripts).toEqual([
      { key: "postinstall", status: "added", staged: "node install.js" },
    ]);
    expect(summary.entrypointsChanged).toBe(true);
  });

  test("flags unusual dependency specs in package json diffs", () => {
    const diff = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { safe: "^1.0.0" } },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: {
          safe: "github:example/safe#main",
          remote: "https://example.invalid/pkg.tgz",
          local: "file:../local.tgz",
          alias: "npm:other-package@^1.0.0",
        },
      },
    );

    const findings = packageJsonDiffFindings(diff);

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "high",
        file: "package.json",
        evidence: "alias: npm:other-package@^1.0.0",
        ruleId: "dependency.unusual-spec",
      }),
      expect.objectContaining({
        evidence: "local: file:../local.tgz",
        ruleId: "dependency.unusual-spec",
      }),
      expect.objectContaining({
        evidence: "remote: https://example.invalid/pkg.tgz",
        ruleId: "dependency.unusual-spec",
      }),
      expect.objectContaining({
        evidence: "safe: github:example/safe#main",
        ruleId: "dependency.unusual-spec",
      }),
    ]);
    expect(
      packageJsonDiffFindings({
        ...diff,
        dependencies: [{ key: "safe", status: "added", staged: "^1.0.0" }],
      }),
    ).toEqual([]);
  });

  test("flags large package size anomalies compared to previous version", () => {
    const previous = [
      { path: "dist/index.js", size: 800_000, sha256: "before", flags: [], textSample: "" },
    ];
    const staged = [
      { path: "dist/index.js", size: 3_100_000, sha256: "after", flags: [], textSample: "" },
    ];
    const findings = deterministicFindings(staged, createPackageDiff(previous, staged));

    expect(findings).toContainEqual(
      expect.objectContaining({
        severity: "high",
        file: "package",
        evidence: "unpacked size grew from 800000 to 3100000 bytes (3.9x)",
        ruleId: "package.size-anomaly",
      }),
    );
  });

  test("flags unexpected large root-level JavaScript payloads", () => {
    const staged = [
      {
        path: "router_init.js",
        size: 2_341_681,
        sha256: "payload",
        flags: [],
        textSample: "console.log('payload');",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings).toContainEqual(
      expect.objectContaining({
        severity: "high",
        file: "router_init.js",
        evidence: "new/changed added file: 2341681 byte root-level JavaScript payload",
        ruleId: "file.root-large-javascript",
      }),
    );
  });

  test("flags large obfuscator-style JavaScript payloads", () => {
    const obfuscatedSample = `const _0x1111=_0x2222;
(function(_0x3333,_0x4444){while(!![]){try{parseInt(_0x1111(0x123));break;}catch(e){}}})(_0x5555,0x123);
_0xaaaa();_0xbbbb();_0xcccc();_0xdddd();_0xeeee();_0xffff();_0xabcd();_0xbcde();`;
    const staged = [
      {
        path: "dist/router_init.js",
        size: 2_341_681,
        sha256: "payload",
        flags: [],
        textSample: obfuscatedSample,
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings).toContainEqual(
      expect.objectContaining({
        severity: "high",
        file: "dist/router_init.js",
        line: 1,
        evidence: "new/changed added file: large obfuscated JavaScript payload",
        ruleId: "code.obfuscated-large-js",
      }),
    );
  });

  test("flags files outside package.json files allowlist", () => {
    const staged = [
      {
        path: "package.json",
        size: 72,
        sha256: "pkg",
        flags: [],
        textSample: JSON.stringify({ name: "pkg", version: "1.0.1", files: ["dist"] }),
      },
      { path: "dist/index.js", size: 20, sha256: "dist", flags: [], textSample: "export {};" },
      {
        path: "router_init.js",
        size: 2048,
        sha256: "payload",
        flags: [],
        textSample: "console.log('init');",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings).toContainEqual(
      expect.objectContaining({
        severity: "high",
        file: "router_init.js",
        evidence: "new/changed added file: file is not matched by package.json files allowlist",
        ruleId: "file.outside-files-list",
      }),
    );
    expect(findings).not.toContainEqual(
      expect.objectContaining({ file: "dist/index.js", ruleId: "file.outside-files-list" }),
    );
  });

  test("flags optional external dependency lifecycle risk", () => {
    const stagedPackageJsonText = `{
  "name": "pkg",
  "version": "1.0.1",
  "optionalDependencies": {
    "@tanstack/setup": "github:tanstack/router#79ac49eedf774dd4b0cfa308722bc463cfe5885c"
  }
}`;
    const diff = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0" },
      JSON.parse(stagedPackageJsonText),
    );

    const findings = packageJsonDiffFindings(diff, stagedPackageJsonText);

    expect(findings).toContainEqual(
      expect.objectContaining({
        severity: "critical",
        file: "package.json",
        line: 5,
        evidence:
          "@tanstack/setup: github:tanstack/router#79ac49eedf774dd4b0cfa308722bc463cfe5885c",
        ruleId: "dependency.optional-lifecycle-risk",
      }),
    );
  });

  test("flags newly added optional dependencies", () => {
    const stagedPackageJsonText = `{
  "name": "pkg",
  "version": "1.0.1",
  "optionalDependencies": {
    "existing": "^1.0.0",
    "maybe": "^2.0.0"
  }
}`;
    const diff = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", optionalDependencies: { existing: "^1.0.0" } },
      JSON.parse(stagedPackageJsonText),
    );

    const findings = packageJsonDiffFindings(diff, stagedPackageJsonText);

    expect(diff.dependencies).toContainEqual({
      key: "maybe",
      status: "added",
      staged: "^2.0.0",
      section: "optionalDependencies",
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        severity: "high",
        file: "package.json",
        line: 6,
        evidence: "maybe: ^2.0.0",
        ruleId: "dependency.optional-added",
      }),
    );
  });

  test("flags npm's implicit node-gyp install hook from root gyp files", () => {
    const staged = [
      {
        path: "package.json",
        size: 40,
        sha256: "pkg",
        flags: [],
        textSample: JSON.stringify({ name: "pkg", version: "1.0.1" }),
      },
      { path: "binding.gyp", size: 2, sha256: "gyp", flags: [], textSample: "{}" },
    ];
    const diff = createPackageDiff([], staged);
    const findings = deterministicFindings(staged, diff);

    expect(findings).toContainEqual(
      expect.objectContaining({
        severity: "high",
        file: "binding.gyp",
        evidence: "implicit install: node-gyp rebuild",
        ruleId: "install-script.implicit-node-gyp",
      }),
    );
  });

  test("does not flag implicit node-gyp when npm suppressors are present", () => {
    const withPreinstall = [
      {
        path: "package.json",
        size: 40,
        sha256: "pkg",
        flags: [],
        textSample: JSON.stringify({ scripts: { preinstall: "node setup.js" } }),
      },
      { path: "binding.gyp", size: 2, sha256: "gyp", flags: [], textSample: "{}" },
    ];
    const withGypfileFalse = [
      {
        path: "package.json",
        size: 40,
        sha256: "pkg",
        flags: [],
        textSample: JSON.stringify({ gypfile: false }),
      },
      { path: "binding.gyp", size: 2, sha256: "gyp", flags: [], textSample: "{}" },
    ];

    expect(
      deterministicFindings(withPreinstall, createPackageDiff([], withPreinstall)),
    ).not.toContainEqual(expect.objectContaining({ ruleId: "install-script.implicit-node-gyp" }));
    expect(
      deterministicFindings(withGypfileFalse, createPackageDiff([], withGypfileFalse)),
    ).not.toContainEqual(expect.objectContaining({ ruleId: "install-script.implicit-node-gyp" }));
  });

  test("warns instead of inferring implicit node-gyp when package.json cannot be parsed", () => {
    const staged = [
      {
        path: "package.json",
        size: 40,
        sha256: "pkg",
        flags: [],
        textSample: "{not-json",
      },
      { path: "binding.gyp", size: 2, sha256: "gyp", flags: [], textSample: "{}" },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings).toContainEqual(
      expect.objectContaining({
        severity: "medium",
        file: "package.json",
        evidence: "package.json parse failed",
        ruleId: "package-json.parse-failed",
      }),
    );
    expect(findings).not.toContainEqual(
      expect.objectContaining({ ruleId: "install-script.implicit-node-gyp" }),
    );
  });

  test("uses staged metadata to flag implicit node-gyp even when the gyp file is absent from the tarball", () => {
    const staged = [
      {
        path: "package.json",
        size: 40,
        sha256: "pkg",
        flags: [],
        textSample: JSON.stringify({ name: "pkg", version: "1.0.1" }),
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged), {
      name: "pkg",
      version: "1.0.1",
      scripts: { install: "node-gyp rebuild" },
      implicitScripts: { install: "node-gyp rebuild" },
      gypfile: true,
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        severity: "high",
        file: "package.json",
        evidence: "implicit install: node-gyp rebuild",
        ruleId: "install-script.implicit-node-gyp",
      }),
    );
    expect(findings).not.toContainEqual(
      expect.objectContaining({ ruleId: "install-script.lifecycle" }),
    );
  });
});
