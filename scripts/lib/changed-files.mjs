import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const OXLINT_EXTENSIONS = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"];

export const OXFMT_EXTENSIONS = [
  ...OXLINT_EXTENSIONS,
  ".json",
  ".jsonc",
  ".md",
  ".css",
  ".yaml",
  ".yml",
  ".html",
];

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function resolveMergeBase(baseRef, cwd = process.cwd()) {
  try {
    return git(["merge-base", baseRef, "HEAD"], cwd).trim() || null;
  } catch {
    return null;
  }
}

export function listChangedFiles(mergeBase, cwd = process.cwd()) {
  const seen = new Set();
  const commands = [
    ["diff", "--name-only", "-z", mergeBase, "HEAD"],
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
