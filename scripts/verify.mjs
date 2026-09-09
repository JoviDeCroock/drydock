// Runs the verify gate (lint + format check + typecheck + knip + tests) with the
// checks in parallel instead of in series. The Cloudflare-worker test pool
// dominates wall time, so the cheap checks finish while it is still running.
// All checks always run to completion so a single pass surfaces every failure;
// output for each check is buffered and printed grouped, never interleaved.
//
// `--quick` (pnpm run verify:quick) is the iteration loop: it scopes lint and
// format check to changed files, keeps the full typecheck (tsc cannot be
// usefully scoped), keeps knip (whole-graph, ~10s, and an unused export is
// created by *removing* the last import, so a changed-file scope would miss the
// file that actually broke), and runs only Vitest tests affected by the change set
// (`--changed <merge-base>`; verified on Vitest 4 to cover committed, staged,
// unstaged, and untracked files for both the node and workers projects). Quick
// mode is not the pre-commit gate — full `pnpm run verify` is.
//
// `--file <path...>` (pnpm run verify:file <path...>) is the inner loop after
// editing one or two files: lint and format check on exactly those files, the
// full typecheck (1–2s with the native compiler, so scoping buys nothing), and
// `vitest related` for both projects, which runs only the test files that import
// the given paths (a test file relates to itself). Knip is skipped: an unused
// export is a whole-graph question that `--quick` and the full gate answer.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  filterByExtension,
  listChangedFiles,
  OXFMT_EXTENSIONS,
  OXLINT_EXTENSIONS,
  resolveMergeBase,
} from "./lib/changed-files.mjs";
import { condenseFailureOutput } from "./lib/output-truncation.mjs";

const quick = process.argv.includes("--quick");
const fileFlagIndex = process.argv.indexOf("--file");
const scopedFiles = fileFlagIndex === -1 ? null : process.argv.slice(fileFlagIndex + 1);
const label = scopedFiles !== null ? "verify --file" : quick ? "verify --quick" : "verify";

function buildFullChecks() {
  return [
    { name: "lint", args: ["run", "lint"] },
    { name: "format:check", args: ["run", "format:check"] },
    { name: "typecheck", args: ["run", "typecheck"] },
    // Unused exports were landing on main and failing CI's knip step after the
    // fact (a dozen "Fix unused … exports" commits). It costs ~10s, so it runs
    // in the local gate too rather than only in CI.
    { name: "knip", args: ["run", "knip"] },
    { name: "test", args: ["run", "test"] },
  ];
}

function buildQuickChecks() {
  const mergeBase = resolveMergeBase("origin/main");
  if (mergeBase === null) {
    process.stdout.write(
      "verify --quick: cannot resolve a merge base between origin/main and HEAD.\n" +
        "Run `git fetch origin` first, or use the full `pnpm run verify`.\n",
    );
    process.exitCode = 1;
    return null;
  }

  const changed = listChangedFiles(mergeBase);
  const lintFiles = filterByExtension(changed, OXLINT_EXTENSIONS);
  const formatFiles = filterByExtension(changed, OXFMT_EXTENSIONS);
  process.stdout.write(
    `verify --quick: ${changed.length} changed files vs merge-base ${mergeBase.slice(0, 10)}\n`,
  );
  if (lintFiles.length === 0) {
    process.stdout.write("  SKIP lint — no changed files oxlint handles\n");
  }
  if (formatFiles.length === 0) {
    process.stdout.write("  SKIP format:check — no changed files oxfmt handles\n");
  }

  // "./" keeps a hypothetical dash-leading filename from parsing as a flag;
  // both tools still apply their ignore patterns to "./"-prefixed paths.
  const asArgs = (files) => files.map((file) => `./${file}`);
  return [
    ...(lintFiles.length > 0
      ? [{ name: "lint", args: ["exec", "oxlint", ...asArgs(lintFiles)] }]
      : []),
    ...(formatFiles.length > 0
      ? [
          {
            name: "format:check",
            args: [
              "exec",
              "oxfmt",
              "--check",
              "--no-error-on-unmatched-pattern",
              ...asArgs(formatFiles),
            ],
          },
        ]
      : []),
    { name: "typecheck", args: ["run", "typecheck"] },
    { name: "knip", args: ["run", "knip"] },
    // Deletions also count as changes for Vitest's related-test resolution, so
    // these always run even when the existing-file change set above is empty.
    {
      name: "test:node:changed",
      args: ["exec", "vitest", "run", "--project", "node", "--changed", mergeBase],
    },
    {
      name: "test:workers:changed",
      args: ["exec", "vitest", "run", "--project", "workers", "--changed", mergeBase],
    },
  ];
}

function buildFileChecks(files) {
  const missing = files.filter((file) => !existsSync(file));
  if (files.length === 0 || missing.length > 0) {
    process.stdout.write(
      files.length === 0
        ? "verify --file: pass one or more repository paths, e.g. pnpm run verify:file src/pages/Diff/index.tsx\n"
        : `verify --file: no such file: ${missing.join(", ")}\n`,
    );
    process.exitCode = 1;
    return null;
  }

  const lintFiles = filterByExtension(files, OXLINT_EXTENSIONS);
  const formatFiles = filterByExtension(files, OXFMT_EXTENSIONS);
  const asArgs = (list) => list.map((file) => `./${file}`);
  return [
    ...(lintFiles.length > 0
      ? [{ name: "lint", args: ["exec", "oxlint", ...asArgs(lintFiles)] }]
      : []),
    ...(formatFiles.length > 0
      ? [
          {
            name: "format:check",
            args: [
              "exec",
              "oxfmt",
              "--check",
              "--no-error-on-unmatched-pattern",
              ...asArgs(formatFiles),
            ],
          },
        ]
      : []),
    { name: "typecheck", args: ["run", "typecheck"] },
    // `related` resolves importers through Vite's module graph, so a change to
    // a widely imported helper still fans out to every suite that depends on
    // it; a leaf file runs only its own tests. `--passWithNoTests` keeps a file
    // with no importers in one project (UI code and the workers project) green.
    {
      name: "test:node:related",
      args: [
        "exec",
        "vitest",
        "related",
        ...files,
        "--run",
        "--project",
        "node",
        "--passWithNoTests",
      ],
    },
    {
      name: "test:workers:related",
      args: [
        "exec",
        "vitest",
        "related",
        ...files,
        "--run",
        "--project",
        "workers",
        "--passWithNoTests",
      ],
    },
    // Markdown is read, not imported, so `related` cannot see the prose checks
    // (path and command references, the agent context budget). Run them by
    // name when a doc is in the set.
    ...(files.some((file) => file.endsWith(".md"))
      ? [
          {
            name: "test:prose",
            args: [
              "exec",
              "vitest",
              "run",
              "--project",
              "node",
              "test/prose-",
              "test/agent-context-budget",
            ],
          },
        ]
      : []),
  ];
}

function runCheck(check) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn("pnpm", check.args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => {
      resolve({
        name: check.name,
        command: check.args.join(" "),
        code: code ?? 1,
        output,
        seconds: (Date.now() - start) / 1000,
      });
    });
  });
}

const checks =
  scopedFiles !== null
    ? buildFileChecks(scopedFiles)
    : quick
      ? buildQuickChecks()
      : buildFullChecks();

if (checks !== null) {
  const pending = new Set(checks.map((check) => check.name));
  process.stdout.write(
    `${label}: running ${checks.length} checks in parallel (${[...pending].join(", ")})\n`,
  );

  const results = await Promise.all(
    checks.map(async (check) => {
      const result = await runCheck(check);
      pending.delete(check.name);
      const status = result.code === 0 ? "PASS" : "FAIL";
      const waiting = pending.size > 0 ? `  still running: ${[...pending].join(", ")}` : "";
      process.stdout.write(
        `  ${status} ${result.name} (${result.seconds.toFixed(1)}s)${waiting}\n`,
      );
      return result;
    }),
  );

  const failures = results.filter((result) => result.code !== 0);
  for (const failure of failures) {
    // Elide long passing/noise regions while keeping every failure line verbatim
    // (see scripts/lib/output-truncation.mjs). The test check's output is already
    // condensed by scripts/test.mjs; a second pass over it is a no-op.
    const condensed = condenseFailureOutput(failure.output, {
      rerunHint: `rerun the failing check directly for full output: pnpm ${failure.command}`,
    });
    process.stdout.write(`\n──── ${failure.name} output ────\n${condensed}\n`);
  }

  if (failures.length > 0) {
    process.stdout.write(`\n${label} failed: ${failures.map((f) => f.name).join(", ")}\n`);
    // See scripts/test.mjs: process.exit() truncates buffered stdout on a pipe.
    process.exitCode = 1;
  } else if (scopedFiles !== null) {
    process.stdout.write(
      "\nfile verify passed — run pnpm run verify:quick before pushing and pnpm run verify before committing\n",
    );
  } else if (quick) {
    process.stdout.write("\nquick verify passed — run pnpm run verify before committing\n");
  }
}
