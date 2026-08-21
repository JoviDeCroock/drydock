// PostToolUse check: after an agent edits a file, run the repo's formatter and
// linter (`oxfmt --check`, `oxlint`) scoped to that file and feed violations
// back to the model via exit 2 + a concise stderr message.
//
// Deliberately report-only: a hook that rewrites the file in place right after
// an Edit invalidates the harness's file-state tracking and causes "file
// modified since read" friction on the model's next edit. So this reports and
// lets the model apply the fix itself.
//
// The target file is never executed: it is only passed as an argument to
// oxfmt/oxlint, which parse it as text. No infinite-loop risk either — the
// hook mutates nothing, so it cannot re-trigger itself.
//
// Fails OPEN (exit 0) on anything that is not a real violation: unparseable
// payload, missing/deleted file, unsupported extension, ignored path, missing
// tool binaries, tool crash or timeout. `pnpm run verify` stays authoritative.
//
// Usage: post-edit-check.mjs [file] (or hook JSON on stdin).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { repoRelative, repoRoot, resolveTargetFiles } from "./hook-input.mjs";

const LINT_EXTENSIONS = new Set([".js", ".jsx", ".cjs", ".mjs", ".ts", ".tsx"]);
const FORMAT_EXTENSIONS = new Set([...LINT_EXTENSIONS, ".css"]);
// Mirrors the ignorePatterns of .oxlintrc.json / .oxfmtrc.json that name repo
// paths; explicitly-passed files bypass the tools' own ignore handling.
const SKIPPED_REPO_PREFIXES = [
  "dist/",
  ".wrangler/",
  "drizzle/",
  "node_modules/",
  ".claude/",
  ".agents/",
  "test/fixtures/oxlint-signals/",
];
const TOOL_TIMEOUT_MS = 30_000;
const MAX_STDERR_CHARS = 4000;

function shouldSkip(absolute) {
  if (absolute.endsWith(".d.ts")) return true;
  const relative = repoRelative(absolute);
  // Outside the repo (e.g. scratch files): still checkable, nothing to skip.
  if (relative === null) return absolute.includes(`${path.sep}node_modules${path.sep}`);
  return (
    SKIPPED_REPO_PREFIXES.some((prefix) => relative.startsWith(prefix)) ||
    relative.includes("/node_modules/")
  );
}

/** Runs a repo-local binary; returns null (fail open) when it cannot run. */
function runTool(binary, args) {
  const bin = path.join(repoRoot, "node_modules", ".bin", binary);
  if (!fs.existsSync(bin)) return null;
  const result = spawnSync(bin, args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: TOOL_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.signal !== null) return null;
  return result;
}

const NOISE_LINE = /^(Checking formatting|Finished in |Found \d+ warning)/;

function trimmedOutput(result) {
  const lines = `${result.stdout}${result.stderr}`
    .split("\n")
    .filter((line) => line.trim() !== "" && !NOISE_LINE.test(line));
  return lines.join("\n").slice(0, MAX_STDERR_CHARS);
}

const { files } = await resolveTargetFiles();
const problems = [];

for (const file of files) {
  const extension = path.extname(file);
  if (!FORMAT_EXTENSIONS.has(extension)) continue;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
  if (shouldSkip(file)) continue;
  const label = repoRelative(file) ?? file;

  const format = runTool("oxfmt", ["--check", "--", file]);
  if (format !== null && format.status !== 0) {
    problems.push(
      `${label}: oxfmt --check failed — not formatted (or unparseable). ` +
        `Fix the formatting in your next edit, or run \`pnpm exec oxfmt "${label}"\` and re-read the file.`,
    );
  }

  if (LINT_EXTENSIONS.has(extension)) {
    const lint = runTool("oxlint", ["--", file]);
    if (lint !== null && lint.status !== 0) {
      problems.push(`${label}: oxlint reported errors:\n${trimmedOutput(lint)}`);
    }
  }
}

if (problems.length === 0) process.exit(0);
process.stderr.write(`${problems.join("\n").slice(0, MAX_STDERR_CHARS)}\n`);
process.exit(2);
