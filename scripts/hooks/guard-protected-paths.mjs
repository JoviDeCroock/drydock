// PreToolUse guard: blocks agent Edit/Write tools from touching hand-forbidden
// paths. D1 migrations under drizzle/ are generated artifacts — AGENTS.md says
// to never hand-write SQL migrations: change server/db/schema.ts and run
// `pnpm db:generate` instead (that runs via Bash, which this guard does not
// intercept, so the legitimate workflow is unaffected).
//
// Exit contract (Claude Code hooks, mirrored by Codex CLI's hooks engine):
// exit 2 blocks the tool call and feeds stderr back to the model; exit 0
// allows it. On unparseable or empty input this guard fails OPEN (exit 0):
// blocking every edit because one payload failed to parse would be worse than
// missing a guarded path, and `pnpm run verify` plus review still catch drift.
// It only blocks when a resolved path clearly matches a protected pattern.
//
// Usage: guard-protected-paths.mjs [file] (or hook JSON on stdin).
import path from "node:path";
import { repoRelative, repoRoot, resolveTargetFiles } from "./hook-input.mjs";

// Protected patterns: drizzle/**/*.sql and drizzle/meta/**. Compared
// case-insensitively so a differently-cased spelling cannot slip through on
// case-insensitive filesystems (macOS); the repo has no legitimately
// different-cased sibling paths.
function isProtected(absolute) {
  const relative = repoRelative(absolute);
  if (relative === null) return false; // outside the repo — not ours to guard
  const lower = relative.toLowerCase();
  if (lower === "drizzle/meta" || lower.startsWith("drizzle/meta/")) return true;
  return lower.startsWith("drizzle/") && lower.endsWith(".sql");
}

const { files } = await resolveTargetFiles();
const blocked = files.filter(isProtected);
if (blocked.length === 0) process.exit(0);

const listed = blocked.map((file) => path.relative(repoRoot, file)).join(", ");
process.stderr.write(
  `Blocked write to generated D1 migration path: ${listed}. ` +
    "Never hand-edit drizzle/**/*.sql or drizzle/meta/** (AGENTS.md). " +
    "Edit server/db/schema.ts and run `pnpm db:generate` to produce the migration.\n",
);
process.exit(2);
