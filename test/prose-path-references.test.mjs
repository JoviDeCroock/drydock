import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Prose in this repo navigates by path: AGENTS.md routes an agent to the right
// module, docs/ names the file that owns a behavior, and .claude/skills/ steps
// cite the exact file to edit. Those references break silently when a module
// moves or is renamed — nothing type-checks a backtick — and every stale one
// sends the next reader (human or agent) to a file that no longer exists.
// Several review passes have landed "correct the … path" commits after the
// fact; this check makes the rename fail at `pnpm run verify` instead.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Backtick-quoted, extension-bearing, contains a separator. A bare `index.ts`
// is a name, not a location, so it is not checked.
const PATH_REFERENCE = /`([A-Za-z0-9_./@-]+\.(?:ts|tsx|mjs|cjs|js|json|jsonc|sql|css|ya?ml))`/g;

// Paths that are deliberately not repo files. Each names bytes that live
// somewhere else: inside a package under review, inside a dependency, or in a
// gitignored output directory a command produces.
const NON_REPO_PREFIXES = [
  "node_modules/", // dependency sources quoted by the signals skills
  "dist/", // a *reviewed package's* build output, not ours
  "extension/", // a path inside a .vsix bundle
  "agent-tour-output/", // gitignored artifacts from `pnpm run agent:tour`
  ".context/", // gitignored agent scratch space
  ".wrangler/", // gitignored local Wrangler state
];

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

/**
 * Prose cites paths at whatever root reads best in context — AGENTS.md's
 * `server/` section writes `routes/scans.ts`, docs/ usually writes the full
 * `server/routes/scans.ts`. Both are unambiguous, so a reference resolves if it
 * is a real path *or* a trailing path segment of exactly one tracked file.
 */
function buildResolver(files) {
  const suffixes = new Set();
  for (const file of files) {
    const segments = file.split("/");
    for (let i = 0; i < segments.length; i++) {
      suffixes.add(segments.slice(i).join("/"));
    }
  }
  return (reference) => suffixes.has(reference) || existsSync(path.join(repoRoot, reference));
}

function isCheckable(reference) {
  if (!reference.includes("/")) return false;
  // URLs, package specifiers, and relative links (already resolved by the
  // markdown link checker's own conventions) are not repo-root paths.
  if (/^(https?:|@|\.)/.test(reference)) return false;
  return !NON_REPO_PREFIXES.some((prefix) => reference.startsWith(prefix));
}

/** Line-level comment detection: enough to skip string literals in code. */
function isCommentLine(line) {
  return /^\s*(\/\/|\/\*|\*)/.test(line);
}

async function staleReferences(files, resolve, { commentsOnly }) {
  const stale = [];
  await Promise.all(
    files.map(async (file) => {
      const text = await readFile(path.join(repoRoot, file), "utf8");
      text.split("\n").forEach((line, index) => {
        if (commentsOnly && !isCommentLine(line)) return;
        for (const match of line.matchAll(PATH_REFERENCE)) {
          const reference = match[1];
          if (!isCheckable(reference)) continue;
          if (resolve(reference)) continue;
          stale.push(`${file}:${index + 1}: \`${reference}\``);
        }
      });
    }),
  );
  return stale.sort();
}

describe("prose path references", () => {
  const files = trackedFiles();
  const resolve = buildResolver(files);

  test("every path named in markdown points at a file that exists", async () => {
    const markdown = files.filter((file) => file.endsWith(".md"));
    expect(markdown.length).toBeGreaterThan(20);

    const stale = await staleReferences(markdown, resolve, { commentsOnly: false });
    expect(
      stale,
      "Markdown names files that no longer exist. Update the reference to the file's new home, " +
        "or — if it names something outside the repo (a path inside a reviewed package, a " +
        "dependency, or a gitignored output dir) — add its prefix to NON_REPO_PREFIXES here.",
    ).toEqual([]);
  });

  test("every path named in a source comment points at a file that exists", async () => {
    const source = files.filter((file) =>
      /^(server|src|scripts|tooling|test)\/.*\.(ts|tsx|mjs)$/.test(file),
    );
    expect(source.length).toBeGreaterThan(50);

    const stale = await staleReferences(source, resolve, { commentsOnly: true });
    expect(stale, "Source comments name files that no longer exist.").toEqual([]);
  });
});
