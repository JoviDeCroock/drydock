// Tests for the agent-harness hook scripts in scripts/hooks/. Each script is
// invoked as a child process, exactly as Claude Code / Codex CLI would run it:
// hook JSON on stdin or a file path as argv[2]. The scripts must give accurate
// exit codes (2 = violation/block, 0 = allow), fail open on malformed input,
// and never execute the target file's code.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guardScript = path.join(repoRoot, "scripts", "hooks", "guard-protected-paths.mjs");
const checkScript = path.join(repoRoot, "scripts", "hooks", "post-edit-check.mjs");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "drydock-agent-hooks-"));
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function runHook(script, { stdin, args = [] } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    input: stdin ?? "",
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

function editPayload(filePath) {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    cwd: repoRoot,
    tool_input: { file_path: filePath, old_string: "a", new_string: "b" },
  });
}

describe("guard-protected-paths", () => {
  test("blocks Edit payloads targeting drizzle SQL migrations", () => {
    const target = path.join(repoRoot, "drizzle", "0000_initial.sql");
    const result = runHook(guardScript, { stdin: editPayload(target) });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("drizzle/0000_initial.sql");
    expect(result.stderr).toContain("pnpm db:generate");
  });

  test("blocks relative drizzle/meta paths resolved against the payload cwd", () => {
    const result = runHook(guardScript, {
      stdin: editPayload("drizzle/meta/0000_snapshot.json"),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("drizzle/meta/0000_snapshot.json");
  });

  test("blocks protected paths passed as argv for non-JSON harnesses", () => {
    const result = runHook(guardScript, {
      args: [path.join(repoRoot, "drizzle", "9999_new_migration.sql")],
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("pnpm db:generate");
  });

  test("blocks Codex apply_patch payloads touching migrations", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: drizzle/0001_org-ownership.sql",
      "@@",
      "-a",
      "+b",
      "*** End Patch",
    ].join("\n");
    const result = runHook(guardScript, {
      stdin: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        cwd: repoRoot,
        tool_input: { command: patch },
      }),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("drizzle/0001_org-ownership.sql");
  });

  test("allows edits to regular repo files", () => {
    const result = runHook(guardScript, {
      stdin: editPayload(path.join(repoRoot, "server", "index.ts")),
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("allows .sql files outside the repo", () => {
    const result = runHook(guardScript, {
      stdin: editPayload(path.join(tempDir, "scratch.sql")),
    });
    expect(result.status).toBe(0);
  });

  test("fails open (does not block) on malformed stdin", () => {
    const result = runHook(guardScript, { stdin: "definitely not json" });
    expect(result.status).toBe(0);
  });

  test("fails open on empty stdin", () => {
    const result = runHook(guardScript, { stdin: "" });
    expect(result.status).toBe(0);
  });
});

describe("post-edit-check", () => {
  test("passes a clean, formatted file", () => {
    const file = path.join(tempDir, "clean.ts");
    fs.writeFileSync(file, "export const answer = 42;\n");
    const result = runHook(checkScript, { args: [file] });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("reports formatting violations with exit 2", () => {
    const file = path.join(tempDir, "unformatted.ts");
    fs.writeFileSync(file, "const   x=1;\nexport { x };\n");
    const result = runHook(checkScript, { stdin: editPayload(file) });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("oxfmt --check failed");
  });

  test("reports lint violations with exit 2", () => {
    const file = path.join(tempDir, "lint-violation.ts");
    fs.writeFileSync(file, "export const a = 1;\ndebugger;\n");
    const result = runHook(checkScript, { stdin: editPayload(file) });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no-debugger");
  });

  test("handles paths containing spaces", () => {
    const file = path.join(tempDir, "has space.ts");
    fs.writeFileSync(file, "export const a = 1;\ndebugger;\n");
    const result = runHook(checkScript, { stdin: editPayload(file) });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no-debugger");
  });

  test("never executes the target file", () => {
    const marker = path.join(tempDir, "executed.marker");
    const file = path.join(tempDir, "side-effect.mjs");
    fs.writeFileSync(
      file,
      `import fs from "node:fs";\n\nfs.writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
    );
    runHook(checkScript, { stdin: editPayload(file) });
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("skips files the repo lint/format configs ignore", () => {
    // In-repo fixture with intentional lint violations; explicitly ignored by
    // .oxlintrc.json, so the hook must not report it.
    const file = path.join(repoRoot, "test", "fixtures", "oxlint-signals", "conditional-jsx.tsx");
    const result = runHook(checkScript, { stdin: editPayload(file) });
    expect(result.status).toBe(0);
  });

  test("ignores non-lintable extensions", () => {
    const file = path.join(tempDir, "notes.md");
    fs.writeFileSync(file, "# notes\n");
    const result = runHook(checkScript, { stdin: editPayload(file) });
    expect(result.status).toBe(0);
  });

  test("fails open when the file no longer exists", () => {
    const result = runHook(checkScript, {
      stdin: editPayload(path.join(tempDir, "deleted-since-edit.ts")),
    });
    expect(result.status).toBe(0);
  });

  test("fails open on malformed stdin", () => {
    const result = runHook(checkScript, { stdin: "{ truncated" });
    expect(result.status).toBe(0);
  });

  test("fails open on payloads without a file path", () => {
    const result = runHook(checkScript, {
      stdin: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {} }),
    });
    expect(result.status).toBe(0);
  });
});
