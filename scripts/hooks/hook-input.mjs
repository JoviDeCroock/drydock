import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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
  if (typeof toolInput.file_path === "string" && toolInput.file_path.length > 0) {
    return { files: [path.resolve(cwd, toolInput.file_path)], parsed: true };
  }
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

export function repoRelative(absolute) {
  const relative = path.relative(repoRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}
