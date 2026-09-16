// @ts-nocheck
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { sanitizeJsSource } from "./helpers/sanitized-source.mjs";

const SERVER_DIR = fileURLToPath(new URL("../server", import.meta.url));

// AGENTS.md: an ecosystem is added through the `lib/ecosystems/` registry —
// never by branching on the ecosystem name in a route or orchestrator. These
// are the route/orchestrator layers that must stay ecosystem-generic.
const ORCHESTRATOR_DIRS = ["routes", "lib/scan", "lib/public-diff", "lib/workflow-gates"];

// Branches that predate the check, individually justified. Adding a new entry
// here needs the same justification an `EcosystemModule` capability field
// would get — prefer extending the registry or the adapter interface instead.
const ALLOWED_BRANCHES = [];

// Value imports that reach into one ecosystem's directory from shared code.
// Each is a place a second staged ecosystem would have to touch today; the
// audit item names the fix. Entries may only be removed, never added: a new
// consumer goes through the registry or an adapter hook instead.
const ALLOWED_ECOSYSTEM_IMPORTS = [
  // C1: Worker entrypoint must export the npm broker class and wire the npm
  // discovery cron; both need a registry-level "staged discovery" capability.
  "index.ts: ./lib/ecosystems/npm",
  "index.ts: ./lib/ecosystems/npm/connection",
  "index.ts: ./lib/ecosystems/npm/staged-publishes-discovery",
  // C1: compare-cache downloads published npm tarballs directly instead of
  // through the published-pair adapter.
  "lib/compare-cache.ts: ./ecosystems/npm/published-tarball",
  // C1: stage-id validation is npm's grammar but gates notify/scan-input/sandbox.
  "lib/notify/index.ts: ../ecosystems/npm/stage-id",
  "lib/sandbox.ts: ./ecosystems/npm/stage-id",
  "lib/scan/input.ts: ../ecosystems/npm/stage-id",
  // C1: scan list/overview/package-release persistence reads npm version
  // status vocabulary; needs an ecosystem-neutral release-outcome shape.
  "db/scan-list.ts: ../lib/ecosystems/npm/version-status",
  "db/scan-query.ts: ../lib/ecosystems/npm/version-status",
  "db/scan-overview.ts: ../lib/ecosystems/npm/version-status",
  "db/scan-package-releases.ts: ../lib/ecosystems/npm/version-status",
  // C1: generic scan routes still speak npm for connection, compare, and
  // staged-publish lifecycle; each is a registry capability waiting to exist.
  "routes/scans/compare.ts: ../../lib/ecosystems/npm/connection",
  "routes/scans/compare.ts: ../../lib/ecosystems/npm/published-tarball",
  "routes/scans/compare.ts: ../../lib/ecosystems/npm/registry",
  "routes/scans/compare.ts: ../../lib/ecosystems/npm/registry-cache",
  "routes/scans/lifecycle.ts: ../../lib/ecosystems/npm/connection",
  "routes/scans/lifecycle.ts: ../../lib/ecosystems/npm/staged-publishes",
  "routes/staged-publishes.ts: ../lib/ecosystems/npm/connection",
  "routes/staged-publishes.ts: ../lib/ecosystems/npm/staged-publishes-discovery",
];

// Route files whose basename does not carry the ecosystem prefix but are
// ecosystem-facing today (C1). Temporary: shrink by moving the npm/atpm
// specifics behind PublicDiffAdapter hooks.
const ECOSYSTEM_FACING_ROUTE_BASENAMES = new Set(["public-diff.ts", "og.ts"]);

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|js)$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function ecosystemIds() {
  const ecosystemsDir = path.join(SERVER_DIR, "lib/ecosystems");
  return readdirSync(ecosystemsDir).filter((entry) =>
    statSync(path.join(ecosystemsDir, entry)).isDirectory(),
  );
}

function branchViolations(ids) {
  const literal = `["'](?:${ids.join("|")})["']`;
  // An ecosystem-name literal used as a *decision*: an (in)equality test on
  // either side, a switch case, or a string/array membership probe. Literal
  // *values* (`ecosystem: "npm"`, `getStagedAdapter("npm")`, defaults) are the
  // registry pattern working as intended and stay legal.
  const branchPatterns = [
    new RegExp(`[=!]==?\\s*${literal}`, "g"),
    new RegExp(`${literal}\\s*[=!]==?`, "g"),
    new RegExp(`\\bcase\\s*${literal}`, "g"),
    new RegExp(`\\.(?:includes|startsWith|endsWith)\\(\\s*${literal}`, "g"),
  ];
  const keepEcosystemLiterals = (value) => ids.includes(value);

  const violations = [];
  for (const dir of ORCHESTRATOR_DIRS) {
    for (const file of sourceFiles(path.join(SERVER_DIR, dir))) {
      const source = readFileSync(file, "utf8");
      const sanitized = sanitizeJsSource(source, keepEcosystemLiterals);
      const relative = path.relative(SERVER_DIR, file).replaceAll(path.sep, "/");
      for (const pattern of branchPatterns) {
        for (const match of sanitized.matchAll(pattern)) {
          // Identify the branch by file plus line *text* (not line number), so
          // unrelated edits elsewhere in an allowlisted file do not churn the
          // allowlist.
          const line = sanitized.slice(0, match.index).split("\n").length;
          const text = source.split("\n")[line - 1].trim();
          violations.push(`${relative}: ${text}`);
        }
      }
    }
  }
  return [...new Set(violations)].sort();
}

// An `import`/`export … from` that carries at least one value binding. Inline
// `type` specifiers are elided by the compiler and do not couple runtime code.
function isValueImport(clause) {
  const trimmed = clause.trim();
  if (trimmed === "" || /^type\s/.test(trimmed)) return false;
  const named = trimmed.match(/\{([^}]*)\}/);
  const outsideBraces = trimmed
    .replace(/\{[^}]*\}/, "")
    .replace(/,/g, "")
    .trim();
  if (outsideBraces) return true;
  if (!named) return true;
  return named[1]
    .split(",")
    .map((entry) => entry.trim())
    .some((entry) => entry && !/^type\s/.test(entry));
}

function ecosystemImportViolations(ids) {
  const ecosystemsRoot = path.join(SERVER_DIR, "lib/ecosystems");
  const importStatement = /\b(import|export)\s+([^;]*?)\s+from\s*(["'])([^"']+)\3/g;
  const keepImportSpecifiers = (value) => value.includes("ecosystems/");

  const violations = [];
  for (const file of sourceFiles(SERVER_DIR)) {
    if (file.startsWith(ecosystemsRoot + path.sep)) continue;
    const relative = path.relative(SERVER_DIR, file).replaceAll(path.sep, "/");
    const source = readFileSync(file, "utf8");
    const sanitized = sanitizeJsSource(source, keepImportSpecifiers);
    for (const match of sanitized.matchAll(importStatement)) {
      const [, , clause, , specifier] = match;
      if (!specifier.startsWith(".") || !isValueImport(clause)) continue;
      const resolved = path
        .relative(ecosystemsRoot, path.resolve(path.dirname(file), specifier))
        .replaceAll(path.sep, "/");
      const [ecosystem] = resolved.split("/");
      if (resolved.startsWith("..") || !ids.includes(ecosystem)) continue;
      const basename = path.basename(file);
      const routeOwnedByEcosystem =
        relative.startsWith("routes/") &&
        (basename.startsWith(`${ecosystem}-`) || ECOSYSTEM_FACING_ROUTE_BASENAMES.has(basename));
      if (routeOwnedByEcosystem) continue;
      violations.push(`${relative}: ${specifier}`);
    }
  }
  return [...new Set(violations)].sort();
}

describe("ecosystem branching invariants", () => {
  test("the ecosystem registry knows every ecosystem directory", () => {
    // The scan derives its literals from lib/ecosystems/* directory names, so
    // pin the shape that derivation relies on: one directory per ecosystem.
    expect(ecosystemIds().sort()).toEqual(["atpm", "npm", "pypi", "vscode"]);
  });

  test("routes and orchestrators do not branch on ecosystem names", () => {
    expect(
      branchViolations(ecosystemIds()),
      "An ecosystem is one directory under server/lib/ecosystems/ plus one registry " +
        "entry in its index.ts — shared code must not test the ecosystem name. If a " +
        "route or orchestrator needs per-ecosystem behavior, make it an optional method " +
        "on the adapter contract and let the registry supply it. See the add-ecosystem skill.",
    ).toEqual([...ALLOWED_BRANCHES].sort());
  });

  test("shared code does not value-import from one ecosystem's directory", () => {
    expect(
      ecosystemImportViolations(ecosystemIds()),
      "Runtime code outside server/lib/ecosystems/ reaches an ecosystem through the " +
        "registry (lib/ecosystems/index.ts) or an adapter hook, not by importing " +
        "lib/ecosystems/<id>/… directly. Routes named <id>-*.ts are that ecosystem's " +
        "own surface and may. See the add-ecosystem skill.",
    ).toEqual([...ALLOWED_ECOSYSTEM_IMPORTS].sort());
  });
});
