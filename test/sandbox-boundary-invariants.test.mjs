// @ts-nocheck
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { sanitizeJsSource } from "./helpers/sanitized-source.mjs";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const SERVER_DIR = fileURLToPath(new URL("../server", import.meta.url));
const { sandboxSource } = await import("../server/lib/sandbox");

// The full set of config the dynamic sandbox worker may receive. Every key is
// a cap or public registry/format setting; anything credential-shaped has no
// business here — the npm token lives in the NpmStageGateway's props, on the
// trusted side of the `globalOutbound` boundary.
const SANDBOX_ENV_KEYS = [
  "ARCHIVE_DIGEST_ALGORITHMS",
  "ARCHIVE_FORMAT",
  "MAX_ENTRIES",
  "MAX_FILES",
  "MAX_STREAM_TAR_BYTES",
  "MAX_TAR_BYTES",
  "MAX_TEXT_SAMPLE_CHARS",
  "NPM_REGISTRY",
];

const CREDENTIAL_LEXEMES = /token|authorization|bearer|secret|password|cookie|credential|api.?key/i;

describe("sandbox credential invariants", () => {
  // AGENTS.md: npm credentials stay outside the sandbox. The rendered dynamic
  // worker is the code that actually touches hostile archives, so pin what it
  // can see: only the allowlisted env config, and no credential material at
  // all — not even a lexeme that would let one be threaded through later.
  test("the rendered sandbox worker reads only allowlisted env config", () => {
    const rendered = sandboxSource();
    const referenced = new Set(
      [...rendered.matchAll(/\benv\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]),
    );
    expect([...referenced].sort()).toEqual(SANDBOX_ENV_KEYS);
  });

  test("the rendered sandbox worker contains no credential material", () => {
    // Assert on the matched lexeme, not the whole rendered worker, so a
    // failure names the offending word instead of dumping the source.
    const lexeme = CREDENTIAL_LEXEMES.exec(sandboxSource())?.[0] ?? null;
    expect(lexeme).toBeNull();
  });

  test("every env block handed to the sandbox loader carries only allowlisted keys", () => {
    // The provisioning side of the same boundary: each `env: { … }` object in
    // the LOADER.load calls must stay within the allowlist, so a token can not
    // be handed to the sandbox under a fresh name either.
    const source = readFileSync(path.join(SERVER_DIR, "lib/sandbox.ts"), "utf8");
    const blocks = [...source.matchAll(/\benv:\s*\{([^}]*)\}/g)];
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const [, block] of blocks) {
      const keys = [...block.matchAll(/(?:^|\n)\s*([A-Za-z_$][\w$]*)\s*:/g)].map(
        (match) => match[1],
      );
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(SANDBOX_ENV_KEYS, `sandbox env key ${key} is not allowlisted`).toContain(key);
      }
    }
  });
});

describe("anonymous dependency metadata invariants", () => {
  test("dependency resolution bypasses metadata caches", () => {
    const source = readFileSync(path.join(SERVER_DIR, "lib/ecosystems/npm/broker.ts"), "utf8");
    const start = source.indexOf("async function fetchAnonymousPackageMetadata(");
    const end = source.indexOf("async function downloadAnonymousTarball(", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const anonymousRead = source.slice(start, end);
    expect(anonymousRead).toContain("fetchPackageMetadata(");
    expect(anonymousRead).not.toContain("fetchPackageMetadataCached(");
  });
});

describe("hostile-bytes execution invariants", () => {
  // AGENTS.md: package bytes are hostile evidence — never execute package
  // code. The layers that hold those bytes (archive parsing and the
  // deterministic review) must not even contain an execution primitive, so a
  // future "just eval the manifest" shortcut fails loudly. Comments, strings,
  // and the detection *regexes that match these primitives in package code*
  // are blanked before scanning.
  const HOSTILE_BYTES_SOURCES = ["lib/sandbox.ts", "lib/tar-parser.js", "lib/review"];

  const EXECUTION_PRIMITIVES = [
    /\beval\s*\(/,
    /\bnew\s+Function\s*\(/,
    /\bFunction\s*\(/,
    // Type-position `typeof import("…")` is a compile-time construct; only a
    // runtime dynamic import loads code.
    /(?<!typeof\s)\bimport\s*\(/,
    /\brequire\s*\(/,
    /child_process/,
    /node:vm/,
  ];

  function* hostileBytesFiles() {
    const stack = HOSTILE_BYTES_SOURCES.map((entry) => path.join(SERVER_DIR, entry));
    while (stack.length > 0) {
      const current = stack.pop();
      if (statSync(current).isDirectory()) {
        for (const entry of readdirSync(current)) stack.push(path.join(current, entry));
      } else if (/\.(ts|js)$/.test(current) && !current.endsWith(".d.ts")) {
        yield current;
      }
    }
  }

  test("archive parsing and deterministic review contain no execution primitives", () => {
    const violations = [];
    for (const file of hostileBytesFiles()) {
      const sanitized = sanitizeJsSource(readFileSync(file, "utf8"));
      const relative = path.relative(SERVER_DIR, file).replaceAll(path.sep, "/");
      for (const pattern of EXECUTION_PRIMITIVES) {
        if (pattern.test(sanitized)) violations.push(`${relative} contains ${pattern}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
