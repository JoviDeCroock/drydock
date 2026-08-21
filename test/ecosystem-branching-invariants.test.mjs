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
const ALLOWED_BRANCHES = [
  // /diff HTML metadata: only atpm has a verified display handle distinct from
  // the canonical name in the URL, so readCachedDisplayName short-circuits
  // every other ecosystem before touching KV. Generalizing this into a
  // PublicDiffAdapter capability is tracked in lib/public-diff/types.ts.
  'lib/public-diff/page.ts: if (spec.ecosystem !== "atpm") return undefined;',
];

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

describe("ecosystem branching invariants", () => {
  test("the ecosystem registry knows every ecosystem directory", () => {
    // The scan derives its literals from lib/ecosystems/* directory names, so
    // pin the shape that derivation relies on: one directory per ecosystem.
    expect(ecosystemIds().sort()).toEqual(["atpm", "npm", "pypi", "vscode"]);
  });

  test("routes and orchestrators do not branch on ecosystem names", () => {
    expect(branchViolations(ecosystemIds())).toEqual([...ALLOWED_BRANCHES].sort());
  });
});
