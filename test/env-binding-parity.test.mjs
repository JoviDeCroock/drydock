import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Cloudflare bindings are declared by hand in four places: `server/env.d.ts`
// (what the code may touch; `cf-typegen` output is not used by typecheck), the
// production `wrangler.jsonc`, the self-host template that operators copy, and
// the Miniflare config the worker tests boot with. Nothing tied them together:
// a binding added to production but not the template ships a self-host that
// fails at first request, and a binding added to `wrangler.jsonc` but not
// `env.d.ts` is invisible to the code until someone types it. AGENTS.md carried
// this as a rule to remember; this pins it so a missing declaration fails
// `pnpm run verify` and names the file.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const ENV_TYPES = "server/env.d.ts";
const PRODUCTION = "wrangler.jsonc";
const SELF_HOST = "docs/examples/wrangler.self-host.jsonc";
const TEST_CONFIG = "test/config/wrangler.jsonc";
const DEV_SERVER = "test/e2e/dev-server.mjs";

// Required in `env.d.ts` but set with `wrangler secret`, never in a config file.
const SECRETS = new Set(["BETTER_AUTH_SECRET"]);

// Vars both configs set that no server code reads, so `env.d.ts` deliberately
// omits them. Adding here needs the same justification as a new binding:
// prefer deleting the var or reading it.
const UNREAD_VARS = new Set([
  // Mirrors `packageManager` in package.json for operators; the Worker never
  // reads it (see docs/self-hosting.md).
  "PNPM_VERSION",
]);

function read(file) {
  return readFileSync(`${repoRoot}/${file}`, "utf8");
}

/**
 * Wrangler config is JSONC: `//` and block comments plus trailing commas. Strip
 * both outside string literals rather than line-wise, since the test config
 * carries trailing commas and comments after values.
 */
function parseJsonc(text) {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const end = closingQuote(text, index);
      out += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === "/" && text[index + 1] === "/") {
      index = text.indexOf("\n", index);
      if (index === -1) index = text.length;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      out += char;
      index++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function closingQuote(text, openIndex) {
  for (let index = openIndex + 1; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === '"') return index;
  }
  throw new Error("unterminated string in JSONC");
}

// Rate limits, Send Email, Durable Objects (`durable_objects.bindings`), and
// `unsafe.bindings` declare their binding under `name`; every other resource
// uses `binding`. Anything else called `name` (the Worker's own name, a queue
// name) is not a binding.
const NAME_IS_BINDING = new Set(["ratelimits", "send_email", "bindings"]);

function bindingNames(config) {
  const names = new Set();
  const walk = (node, parentKey) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, parentKey);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "binding" && typeof value === "string") names.add(value);
      else if (key === "name" && typeof value === "string" && NAME_IS_BINDING.has(parentKey)) {
        names.add(value);
      } else if (key === "vars" && value && typeof value === "object") {
        for (const name of Object.keys(value)) names.add(name);
      } else {
        walk(value, key);
      }
    }
  };
  walk(config, "");
  return names;
}

/** `NAME: type` and `NAME?: type` members of the `Cloudflare.Env` interface. */
function envDeclarations(source) {
  const body = source.match(/interface Env \{(?<body>[\s\S]*?)\n\s{4}\}/)?.groups?.body;
  if (!body) throw new Error(`${ENV_TYPES}: could not find the Cloudflare.Env interface`);
  const required = new Set();
  const optional = new Set();
  for (const match of body.matchAll(/^\s+([A-Z][A-Z0-9_]*)(\?)?:/gm)) {
    (match[2] ? optional : required).add(match[1]);
  }
  return { required, optional, all: new Set([...required, ...optional]) };
}

/**
 * The e2e dev server builds its Wrangler config as a JS object literal, so it is
 * read textually: `binding: "X"` and ratelimit `name: "X"` entries, plus the
 * keys of its `vars: { … }` block.
 */
function devServerBindings(source) {
  const names = new Set();
  for (const match of source.matchAll(/\b(?:binding|name):\s*"([A-Z][A-Z0-9_]*)"/g)) {
    names.add(match[1]);
  }
  const vars = source.match(/\bvars:\s*\{(?<body>[\s\S]*?)\n\s*\}/)?.groups?.body ?? "";
  for (const match of vars.matchAll(/^\s*([A-Z][A-Z0-9_]*):/gm)) names.add(match[1]);
  return names;
}

const sorted = (set) => [...set].sort();

describe("Cloudflare binding parity", () => {
  const env = envDeclarations(read(ENV_TYPES));
  const production = bindingNames(parseJsonc(read(PRODUCTION)));
  const selfHost = bindingNames(parseJsonc(read(SELF_HOST)));
  const testConfig = bindingNames(parseJsonc(read(TEST_CONFIG)));
  const devServer = devServerBindings(read(DEV_SERVER));

  test("the parsed sources are not empty", () => {
    expect(env.all.size).toBeGreaterThan(10);
    expect(production.size).toBeGreaterThan(10);
    expect(testConfig.size).toBeGreaterThan(3);
    expect(devServer.size).toBeGreaterThan(3);
  });

  test.each([
    [PRODUCTION, production],
    [SELF_HOST, selfHost],
    [TEST_CONFIG, testConfig],
    [DEV_SERVER, devServer],
  ])("every binding and var in %s is declared in server/env.d.ts", (file, names) => {
    const undeclared = sorted(names).filter((name) => !env.all.has(name) && !UNREAD_VARS.has(name));
    expect(
      undeclared,
      `${file} configures bindings that ${ENV_TYPES} does not declare. Typecheck cannot see ` +
        "them: add each to the Cloudflare.Env interface (optional unless every deployment has it).",
    ).toEqual([]);
  });

  test("the self-host template declares exactly the production bindings", () => {
    expect(
      sorted(selfHost),
      `${SELF_HOST} must offer operators every binding ${PRODUCTION} uses, with placeholder ids.`,
    ).toEqual(sorted(production));
  });

  test("every required env member is a production binding, var, or known secret", () => {
    const unprovided = sorted(env.required).filter(
      (name) => !production.has(name) && !SECRETS.has(name),
    );
    expect(
      unprovided,
      `${ENV_TYPES} requires members that ${PRODUCTION} never sets. Either declare the binding ` +
        "or var there, mark the member optional, or list it in SECRETS if wrangler secret sets it.",
    ).toEqual([]);
  });

  test("parses comments and trailing commas outside strings", () => {
    const parsed = parseJsonc(
      '{\n  // leading\n  "a": "http://x/y", /* block */\n  "b": ["c", "d",],\n  "e": "//not a comment",\n}',
    );
    expect(parsed).toEqual({ a: "http://x/y", b: ["c", "d"], e: "//not a comment" });
  });

  test("reads binding, ratelimit/send_email names, and vars but not other names", () => {
    const names = bindingNames({
      name: "worker",
      d1_databases: [{ binding: "DB", database_name: "x" }],
      ratelimits: [{ name: "RATE_LIMIT_10_PER_MINUTE", namespace_id: "1" }],
      send_email: [{ name: "SEND_EMAIL" }],
      durable_objects: { bindings: [{ name: "GATE_ROOM", class_name: "GateRoom" }] },
      queues: {
        producers: [{ binding: "SCAN_QUEUE", queue: "scans" }],
        consumers: [{ queue: "scans" }],
      },
      vars: { NPM_REGISTRY: "https://registry.npmjs.org" },
    });
    expect(sorted(names)).toEqual([
      "DB",
      "GATE_ROOM",
      "NPM_REGISTRY",
      "RATE_LIMIT_10_PER_MINUTE",
      "SCAN_QUEUE",
      "SEND_EMAIL",
    ]);
  });

  test("reads the dev server's binding, ratelimit name, and vars entries", () => {
    const names = devServerBindings(
      'x = {\n  name: "worker",\n  d1_databases: [{ binding: "DB" }],\n' +
        '  ratelimits: [{ name: "RATE_LIMIT_10_PER_MINUTE", simple: { limit: 10 } }],\n' +
        '  vars: {\n    NPM_REGISTRY: registryUrl,\n    AI_CACHE_AFFINITY: "e2e",\n  },\n};',
    );
    expect(sorted(names)).toEqual([
      "AI_CACHE_AFFINITY",
      "DB",
      "NPM_REGISTRY",
      "RATE_LIMIT_10_PER_MINUTE",
    ]);
  });

  test("splits required and optional Env members", () => {
    const declared = envDeclarations(
      "declare global {\n  namespace Cloudflare {\n    interface Env {\n      DB: D1Database;\n      // note\n      FLAGS?: Flagship;\n    }\n  }\n}",
    );
    expect(sorted(declared.required)).toEqual(["DB"]);
    expect(sorted(declared.optional)).toEqual(["FLAGS"]);
  });
});
