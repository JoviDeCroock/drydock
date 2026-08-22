import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { tokenizeJs } from "../server/lib/platform/js-lexer";

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
const PATH_REFERENCE = /`([A-Za-z0-9_./@-]+\.(?:ts|tsx|mjs|cjs|js|json|jsonc|md|sql|css|ya?ml))`/g;

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
  const exactFiles = new Set(files);
  const suffixCounts = new Map();
  for (const file of files) {
    const segments = file.split("/");
    for (let i = 0; i < segments.length; i++) {
      const suffix = segments.slice(i).join("/");
      suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
    }
  }
  return (reference, fromFile) => {
    if (reference.startsWith("./") || reference.startsWith("../")) {
      if (!fromFile) return false;
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(fromFile), reference),
      );
      if (resolved === ".." || resolved.startsWith("../") || path.posix.isAbsolute(resolved)) {
        return false;
      }
      return exactFiles.has(resolved) || existsSync(path.join(repoRoot, resolved));
    }
    return (
      exactFiles.has(reference) ||
      existsSync(path.join(repoRoot, reference)) ||
      suffixCounts.get(reference) === 1
    );
  };
}

function isCheckable(reference, { commentsOnly }) {
  if (!reference.includes("/")) return false;
  // URLs and package specifiers are not repository paths. Explicit relative
  // Markdown links already use Markdown's own resolution conventions; relative
  // paths in source comments are checked against the source file instead.
  // Dot-directories such as `.claude/` and `.github/` are repository paths.
  if (/^(https?:|@)/.test(reference)) return false;
  if (/^\.\.?\//.test(reference)) return commentsOnly;
  return !NON_REPO_PREFIXES.some((prefix) => reference.startsWith(prefix));
}

function isSourceFile(file) {
  return /^(server|src|scripts|tooling|test)\/.*\.(?:[cm]?js|tsx?)$/.test(file);
}

function pathReferences(text, { commentsOnly }) {
  const segments = commentsOnly
    ? tokenizeJs(text, { sourceGoal: "module" })
        .filter((token) => token.type === "comment")
        .map((token) => ({ start: token.start, text: text.slice(token.start, token.end) }))
    : [{ start: 0, text }];

  return segments.flatMap((segment) =>
    [...segment.text.matchAll(PATH_REFERENCE)].map((match) => ({
      reference: match[1],
      line: text.slice(0, segment.start + match.index).split("\n").length,
    })),
  );
}

async function staleReferences(files, resolve, { commentsOnly }) {
  const stale = [];
  await Promise.all(
    files.map(async (file) => {
      const text = await readFile(path.join(repoRoot, file), "utf8");
      for (const { reference, line } of pathReferences(text, { commentsOnly })) {
        if (!isCheckable(reference, { commentsOnly })) continue;
        if (resolve(reference, file)) continue;
        stale.push(`${file}:${line}: \`${reference}\``);
      }
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
        "dependency, or a gitignored output dir) — add a narrow non-repository exception here.",
    ).toEqual([]);
  });

  test("every path named in a source comment points at a file that exists", async () => {
    const source = files.filter(isSourceFile);
    expect(source.length).toBeGreaterThan(50);

    const stale = await staleReferences(source, resolve, { commentsOnly: true });
    expect(stale, "Source comments name files that no longer exist.").toEqual([]);
  });

  test("recognizes Markdown and dot-directory repository paths", () => {
    const prose = "Read `docs/security-model.md` and `.claude/skills/pre-pr/SKILL.md`.";
    const references = [...prose.matchAll(PATH_REFERENCE)].map((match) => match[1]);

    expect(references).toEqual(["docs/security-model.md", ".claude/skills/pre-pr/SKILL.md"]);
    expect(references.every((reference) => isCheckable(reference, { commentsOnly: false }))).toBe(
      true,
    );
  });

  test("requires shorthand paths to identify exactly one tracked file", () => {
    const resolve = buildResolver(["server/routes/scans.ts", "test/routes/scans.ts"]);
    expect(resolve("server/routes/scans.ts")).toBe(true);
    expect(resolve("routes/scans.ts")).toBe(false);
  });

  test("resolves relative source-comment paths from the containing file", () => {
    const resolve = buildResolver([
      "server/lib/ecosystems/record.ts",
      "server/lib/ecosystems/stage-record.ts",
    ]);

    expect(isCheckable("./record.ts", { commentsOnly: true })).toBe(true);
    expect(isCheckable("./record.ts", { commentsOnly: false })).toBe(false);
    expect(resolve("./record.ts", "server/lib/ecosystems/stage-record.ts")).toBe(true);
    expect(resolve("./missing.ts", "server/lib/ecosystems/stage-record.ts")).toBe(false);
  });

  test("includes JavaScript and TypeScript source files in the comment scan", () => {
    expect(
      ["server/parser.js", "scripts/check.cjs", "tooling/rule.mjs", "src/view.tsx"].every(
        isSourceFile,
      ),
    ).toBe(true);
  });

  test("extracts inline and JSX comments without treating strings as comments", () => {
    const source = [
      'const prose = "Read `server/routes/missing.ts`.";',
      "run(); // Read `server/routes/scans.ts`.",
      "const view = <div>{/* Read `src/components/Card.tsx`. */}</div>;",
    ].join("\n");

    expect(pathReferences(source, { commentsOnly: true })).toEqual([
      { reference: "server/routes/scans.ts", line: 2 },
      { reference: "src/components/Card.tsx", line: 3 },
    ]);
  });
});
