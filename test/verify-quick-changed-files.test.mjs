// Exercises the changed-file detection behind `pnpm run verify:quick` against
// a real temporary git repository: committed, staged, unstaged, and untracked
// changes are all "changed"; deletions and gitignored files are not; filenames
// with spaces survive; upstream-only commits past the merge base are excluded.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  filterByExtension,
  listChangedFiles,
  OXFMT_EXTENSIONS,
  OXLINT_EXTENSIONS,
  resolveMergeBase,
} from "../scripts/lib/changed-files.mjs";

const repo = mkdtempSync(path.join(tmpdir(), "drydock-changed-files-"));

function git(...args) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(repo, ".no-global-gitconfig"),
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

function write(relative, content) {
  const absolute = path.join(repo, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

let forkSha = "";

beforeAll(() => {
  git("init", "-b", "main");
  git("config", "commit.gpgsign", "false");

  write(".gitignore", "ignored.log\n");
  write("kept.ts", "export const kept = 1;\n");
  write("to-delete.ts", "export const gone = 1;\n");
  write("to-modify.ts", "export const version = 1;\n");
  git("add", "-A");
  git("commit", "-m", "base");
  forkSha = git("rev-parse", "HEAD").trim();

  // Feature branch: one commit plus staged, unstaged, and untracked changes.
  git("checkout", "-b", "feature");
  write("to-modify.ts", "export const version = 2;\n");
  write("committed-new.md", "# new\n");
  git("rm", "--quiet", "to-delete.ts");
  git("add", "-A");
  git("commit", "-m", "feature work");

  // Upstream moves past the fork point; merge-base detection must not pull
  // main-only changes into the feature change set.
  git("checkout", "main");
  write("upstream.ts", "export const upstream = 1;\n");
  git("add", "-A");
  git("commit", "-m", "upstream work");
  git("checkout", "feature");

  write("staged.mjs", "export const staged = true;\n");
  git("add", "staged.mjs");
  write("kept.ts", "export const kept = 2;\n"); // unstaged
  write("new file.tsx", "export const spaced = true;\n"); // untracked, space in name
  write("ignored.log", "noise\n"); // untracked but gitignored
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("resolveMergeBase", () => {
  it("resolves the fork point, not the base branch tip", () => {
    expect(resolveMergeBase("main", repo)).toBe(forkSha);
    expect(resolveMergeBase("main", repo)).not.toBe(git("rev-parse", "main").trim());
  });

  it("returns null for an unresolvable ref", () => {
    expect(resolveMergeBase("no/such-ref", repo)).toBeNull();
  });
});

describe("listChangedFiles", () => {
  it("unions committed, staged, unstaged, and untracked; drops deletions, ignored, and upstream-only files", () => {
    expect(listChangedFiles(forkSha, repo)).toEqual([
      "committed-new.md",
      "kept.ts",
      "new file.tsx",
      "staged.mjs",
      "to-modify.ts",
    ]);
  });
});

describe("filterByExtension", () => {
  const changed = ["a.ts", "b.md", "c file.tsx", "d.sql", "e.json", "f.mjs", "g.html", "h.svg"];

  it("keeps only lintable files for oxlint", () => {
    expect(filterByExtension(changed, OXLINT_EXTENSIONS)).toEqual(["a.ts", "c file.tsx", "f.mjs"]);
  });

  it("keeps oxfmt's wider set for format checking", () => {
    expect(filterByExtension(changed, OXFMT_EXTENSIONS)).toEqual([
      "a.ts",
      "b.md",
      "c file.tsx",
      "e.json",
      "f.mjs",
      "g.html",
    ]);
  });
});
