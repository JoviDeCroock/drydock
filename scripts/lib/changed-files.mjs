// Changed-file detection for `scripts/verify.mjs --quick`. "Changed" means the
// union of commits since the merge-base with the base ref plus staged, unstaged,
// and untracked working-tree files. All git output is NUL-separated so filenames
// containing spaces (or newlines) survive, and results are filtered to paths
// that still exist on disk so deletions and rename-old-paths never reach the
// linters.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Extensions oxlint lints. Other files passed explicitly are silently skipped
// ("No files found to lint", exit 0), but filtering keeps the skip decision and
// the output honest.
export const OXLINT_EXTENSIONS = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"];

// oxfmt also formats JSON, Markdown, CSS, and YAML (verified against oxfmt
// 0.62: a misformatted file of each kind fails `--check`). `.oxfmtrc.json`
// ignorePatterns still apply; --no-error-on-unmatched-pattern keeps explicitly
// passed ignored files from turning into an error.
export const OXFMT_EXTENSIONS = [
  ...OXLINT_EXTENSIONS,
  ".json",
  ".jsonc",
  ".md",
  ".css",
  ".yaml",
  ".yml",
];

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Sha of the merge base between baseRef and HEAD, or null when it cannot be
 * resolved (no such ref, unrelated histories, not a git checkout). */
export function resolveMergeBase(baseRef, cwd = process.cwd()) {
  try {
    return git(["merge-base", baseRef, "HEAD"], cwd).trim() || null;
  } catch {
    return null;
  }
}

/** Repo-relative paths changed since mergeBase (committed + staged + unstaged +
 * untracked), deduped, filtered to files that still exist, sorted. */
export function listChangedFiles(mergeBase, cwd = process.cwd()) {
  const seen = new Set();
  const commands = [
    ["diff", "--name-only", "-z", mergeBase, "HEAD"],
    // Staged and unstaged changes to tracked files, in one diff against HEAD.
    ["diff", "--name-only", "-z", "HEAD"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ];
  for (const args of commands) {
    for (const file of git(args, cwd).split("\0")) {
      if (file.length > 0) {
        seen.add(file);
      }
    }
  }
  return [...seen].filter((file) => existsSync(path.join(cwd, file))).sort();
}

export function filterByExtension(files, extensions) {
  const wanted = new Set(extensions);
  return files.filter((file) => wanted.has(path.extname(file).toLowerCase()));
}
