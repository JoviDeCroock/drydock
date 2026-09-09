import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { tokenizeJs } from "../server/lib/platform/js-lexer";

// Prose in this repo also navigates by command: AGENTS.md says which script to
// iterate with, docs/ tells an operator how to seed, migrate, or eval, and
// skills cite the exact script to run before finishing. A renamed or removed
// package.json script leaves those references pointing at nothing, and the
// failure only shows up when the next reader types the command. This is the
// command-shaped sibling of test/prose-path-references.test.mjs: every
// `pnpm <script>` / `pnpm run <script>` in Markdown or a source comment must be a
// real script, and every script must be documented in docs/tooling.md, which
// docs/repository-map.md promises is the complete table.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Matches the `run <script>` and bare `<script>` spellings, with or without
// trailing arguments. Flags never match; built-in sub-commands are filtered
// through PNPM_BUILTINS. A `run` followed by a placeholder rather than a name
// (prose explaining the spelling itself) matches nothing.
const COMMAND_REFERENCE = /\bpnpm(?:\s+run)?\s+(?!run\b)([A-Za-z][\w:.-]*)/g;

// Built-in sub-commands that are not package.json scripts. The `test` and
// `start` built-ins alias the script of the same name, so they are resolved as
// scripts rather than listed here.
const PNPM_BUILTINS = new Set([
  "add",
  "approve-builds",
  "audit",
  "bin",
  "config",
  "create",
  "dedupe",
  "dlx",
  "env",
  "exec",
  "fetch",
  "i",
  "import",
  "init",
  "install",
  "licenses",
  "link",
  "list",
  "ls",
  "outdated",
  "pack",
  "patch",
  "prune",
  "publish",
  "rebuild",
  "remove",
  "root",
  "self-update",
  "setup",
  "store",
  "uninstall",
  "unlink",
  "up",
  "update",
  "why",
]);

function repoFiles() {
  const list = (args) =>
    execFileSync("git", ["ls-files", "-z", ...args], { cwd: repoRoot, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
  return [...new Set([...list([]), ...list(["--others", "--exclude-standard"])])].sort();
}

function isSourceFile(file) {
  return /^(server|src|scripts|tooling|test)\/.*\.(?:[cm]?js|tsx?)$/.test(file);
}

function commandReferences(text, { commentsOnly }) {
  const segments = commentsOnly
    ? tokenizeJs(text, { sourceGoal: "module" })
        .filter((token) => token.type === "comment")
        .map((token) => ({ start: token.start, text: text.slice(token.start, token.end) }))
    : [{ start: 0, text }];

  return segments.flatMap((segment) =>
    [...segment.text.matchAll(COMMAND_REFERENCE)].map((match) => ({
      script: match[1],
      line: text.slice(0, segment.start + match.index).split("\n").length,
    })),
  );
}

async function unknownCommands(files, scripts, { commentsOnly }) {
  const unknown = [];
  await Promise.all(
    files.map(async (file) => {
      const text = await readFile(path.join(repoRoot, file), "utf8");
      for (const { script, line } of commandReferences(text, { commentsOnly })) {
        if (PNPM_BUILTINS.has(script) || scripts.has(script)) continue;
        unknown.push(`${file}:${line}: \`pnpm ${script}\``);
      }
    }),
  );
  return unknown.sort();
}

async function packageScripts() {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  return new Set(Object.keys(pkg.scripts ?? {}));
}

describe("prose command references", () => {
  const files = repoFiles();

  test("every pnpm command named in markdown is a package.json script", async () => {
    const scripts = await packageScripts();
    const markdown = files.filter((file) => file.endsWith(".md"));
    expect(markdown.length).toBeGreaterThan(20);

    const unknown = await unknownCommands(markdown, scripts, { commentsOnly: false });
    expect(
      unknown,
      "Markdown names pnpm scripts that package.json does not define. Rename the reference " +
        "to the script's new name, or add the script.",
    ).toEqual([]);
  });

  test("every pnpm command named in a source comment is a package.json script", async () => {
    const scripts = await packageScripts();
    const source = files.filter(isSourceFile);
    expect(source.length).toBeGreaterThan(50);

    const unknown = await unknownCommands(source, scripts, { commentsOnly: true });
    expect(unknown, "Source comments name pnpm scripts that package.json does not define.").toEqual(
      [],
    );
  });

  test("docs/tooling.md documents every package.json script", async () => {
    const scripts = await packageScripts();
    const tooling = await readFile(path.join(repoRoot, "docs/tooling.md"), "utf8");
    const documented = new Set([...tooling.matchAll(COMMAND_REFERENCE)].map((match) => match[1]));

    const missing = [...scripts].filter((script) => !documented.has(script)).sort();
    expect(
      missing,
      "docs/repository-map.md promises that docs/tooling.md holds the complete script table. " +
        "Add a row (or a sentence) for each new script.",
    ).toEqual([]);
  });

  test("recognizes run, bare, and argument-carrying spellings", () => {
    const prose =
      "Use `pnpm run verify:quick`, then `pnpm test -- test/x.test.mjs`, `pnpm db:generate`, " +
      "and `pnpm install --frozen-lockfile`.";
    expect(commandReferences(prose, { commentsOnly: false }).map((ref) => ref.script)).toEqual([
      "verify:quick",
      "test",
      "db:generate",
      "install",
    ]);
  });

  test("extracts commands from comments without treating strings as comments", () => {
    const source = [
      'const hint = "run pnpm run missing-script";',
      "run(); // see pnpm run verify",
      "/* pnpm test -- <file> */",
    ].join("\n");

    expect(commandReferences(source, { commentsOnly: true })).toEqual([
      { script: "verify", line: 2 },
      { script: "test", line: 3 },
    ]);
  });
});
