// @ts-check
import { posix, win32 } from "node:path";

/**
 * How `approve` starts the user's npm without a shell, from an explicit PATH
 * lookup that never considers the current directory. cmd.exe, which Windows
 * needs to start the `npm.cmd` shim, resolves a bare `npm` against the working
 * directory before PATH, and on any platform an empty or relative PATH entry
 * means the working directory; either way an `npm` planted in a checked-out
 * repository would run with the user's terminal and npm credentials. On Windows
 * the shim is skipped entirely: npm's own `npm-cli.js` beside it is run with
 * node, which is what the shim does.
 *
 * @param {{ platform: string; path: string | undefined; cwd: string; execPath: string; isFile: (path: string) => boolean }} host
 * @returns {{ command: string; args: string[] } | null} null when no npm is on PATH
 */
export function resolveNpmCommand({ platform, path, cwd, execPath, isFile }) {
  const windows = platform === "win32";
  const { delimiter, isAbsolute, join, resolve } = windows ? win32 : posix;
  const here = resolve(cwd);
  for (const entry of (path ?? "").split(delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    // An empty or relative entry means the current directory (or one under it).
    if (!dir || !isAbsolute(dir) || sameDir(resolve(dir), here, windows)) continue;
    if (!windows) {
      const npm = join(dir, "npm");
      if (isFile(npm)) return { command: npm, args: [] };
      continue;
    }
    if (!isFile(join(dir, "npm.cmd"))) continue;
    const cli = join(dir, "node_modules", "npm", "bin", "npm-cli.js");
    if (!isFile(cli)) continue;
    const node = join(dir, "node.exe");
    return { command: isFile(node) ? node : execPath, args: [cli] };
  }
  return null;
}

/**
 * @param {string} a
 * @param {string} b
 * @param {boolean} windows paths there are case-insensitive
 */
function sameDir(a, b, windows) {
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}
