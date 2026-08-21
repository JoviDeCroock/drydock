// Shared input parsing for the agent-harness hook scripts in this directory.
//
// The scripts are tool-agnostic: they accept the edited/target file either as
// argv[2] (so any harness or a human can invoke them directly) or as a JSON
// payload on stdin. The stdin shape follows Claude Code's hook contract
// (PreToolUse/PostToolUse: `tool_input.file_path` for Edit/Write), which
// OpenAI Codex CLI's Claude-compatible hooks engine also speaks — except that
// Codex serializes file edits as the `apply_patch` tool whose `tool_input` is
// `{ command: "*** Begin Patch ..." }`, so we also extract file paths from
// that patch envelope.
import path from "node:path";
import { fileURLToPath } from "node:url";

// scripts/hooks/hook-input.mjs -> repo root, independent of the process cwd.
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Hook harnesses write the payload and close stdin immediately; the timeout
// only guards against being spawned with an open, silent stdin.
const STDIN_TIMEOUT_MS = 3000;

function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    const finish = () => {
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

const PATCH_FILE_LINE = /^\*{3} (?:Add|Update|Delete) File: (.+)$/;
const PATCH_MOVE_LINE = /^\*{3} Move to: (.+)$/;

/**
 * Resolves the file paths a tool call is about to touch (or just touched).
 *
 * Returns `{ files, parsed }` with absolute paths. `parsed: false` means the
 * input could not be understood at all (no argv path and empty or malformed
 * stdin); callers decide whether that fails open or closed.
 */
export async function resolveTargetFiles(argv = process.argv) {
  if (typeof argv[2] === "string" && argv[2].length > 0) {
    return { files: [path.resolve(argv[2])], parsed: true };
  }
  const raw = await readStdin();
  if (raw.trim() === "") return { files: [], parsed: false };
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { files: [], parsed: false };
  }
  if (payload === null || typeof payload !== "object") return { files: [], parsed: false };
  const cwd =
    typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : process.cwd();
  const toolInput = payload.tool_input;
  if (toolInput === null || typeof toolInput !== "object") return { files: [], parsed: true };
  // Claude Code Edit/Write (and anything speaking the same contract).
  if (typeof toolInput.file_path === "string" && toolInput.file_path.length > 0) {
    return { files: [path.resolve(cwd, toolInput.file_path)], parsed: true };
  }
  // Codex CLI apply_patch: raw patch text listing the files it touches.
  if (typeof toolInput.command === "string" && toolInput.command.includes("*** Begin Patch")) {
    const files = [];
    for (const line of toolInput.command.split("\n")) {
      const match = PATCH_FILE_LINE.exec(line) ?? PATCH_MOVE_LINE.exec(line);
      if (match !== null) files.push(path.resolve(cwd, match[1].trim()));
    }
    return { files, parsed: true };
  }
  return { files: [], parsed: true };
}

/** Repo-relative posix-style path, or null when the file is outside the repo. */
export function repoRelative(absolute) {
  const relative = path.relative(repoRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}
