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
  "TAR_ROOT_STRIP",
];

// Sandbox entrypoints that hand the archive to the tar reader. Each call site
// has to name the strip depth its ecosystem's consumer extracts with, because
// the recorded path is the path that consumer installs.
const SANDBOX_DOWNLOAD_CALLS = /\bdownloadInSandbox(?:Inline|Stream)?\(/g;

// The one call site that cannot name a strip depth: a workflow-gate bundle's
// `.tgz`/`.tar.gz` is claimed by both npm and PyPI on filename alone, so the
// ecosystem is only decided from the parsed contents. Its default parse and the
// reason are documented at the call site.
const ECOSYSTEM_UNKNOWN_PARSE = "lib/workflow-gates/resolve.ts";

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

describe("sandbox archive-parse parity", () => {
  // AGENTS.md: fix the whole parity class. A new ecosystem that parses a tar
  // without naming its consumer's strip depth silently inherits the
  // ecosystem-unknown parse and reports paths its consumer never installs.
  test("every tar-capable sandbox call names the consumer's strip depth", () => {
    const offenders = [];
    for (const file of walkServerSources()) {
      const source = readFileSync(path.join(SERVER_DIR, file), "utf8");
      if (file === ECOSYSTEM_UNKNOWN_PARSE || file === "lib/sandbox.ts") continue;
      for (const match of source.matchAll(SANDBOX_DOWNLOAD_CALLS)) {
        const call = sliceCallArguments(source, match.index + match[0].length - 1);
        // A pinned zip/vsix format never reaches the tar reader.
        if (/archiveFormat:\s*"(?:zip|vsix)"/.test(call) || /format:\s*"(?:zip|vsix)"/.test(call)) {
          continue;
        }
        if (!/\btarRootStrip\b/.test(call)) offenders.push(`${file}:${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

function walkServerSources(dir = "") {
  return readdirSync(path.join(SERVER_DIR, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return walkServerSources(rel);
    return entry.name.endsWith(".ts") ? [rel] : [];
  });
}

function sliceCallArguments(source, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIndex, i + 1);
    }
  }
  return source.slice(openParenIndex);
}
