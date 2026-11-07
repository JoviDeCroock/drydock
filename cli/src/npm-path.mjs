// @ts-check
import { posix, win32 } from "node:path";

/**
 * How `approve` starts the user's npm without a shell, from an explicit PATH
 * lookup that never considers the current directory. cmd.exe, which Windows
 * needs to start the `npm.cmd` shim, resolves a bare `npm` against the working
 * directory before PATH, and on any platform an empty or relative PATH entry
 * means the working directory; either way an `npm` planted in a checked-out
 * repository would run with the user's terminal and npm credentials. For the
 * same reason a `node_modules` bin directory, which `npm run`, `npx`, and
 * direnv put on PATH as an absolute path, is skipped: any dependency can ship
 * an `npm` or `node` bin there. On Windows
 * the shim is skipped entirely: npm's own `npm-cli.js` beside it is run with
 * node, which is what the shim does. npm then runs with the same PATH minus
 * those entries, because the POSIX `npm` starts `node` through `env`, which
 * searches PATH too.
 *
 * @param {{ platform: string; path: string | undefined; cwd: string; execPath: string; isFile: (path: string) => boolean }} host
 * @returns {{ command: string; args: string[]; path: string } | null} null when no npm is on PATH
 */
export function resolveNpmCommand({ platform, path, cwd, execPath, isFile }) {
  const windows = platform === "win32";
  const { delimiter, isAbsolute, join, resolve } = windows ? win32 : posix;
  const here = resolve(cwd);
  const dirs = [];
  for (const entry of (path ?? "").split(delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    // An empty or relative entry means the current directory (or one under it).
    if (!dir || !isAbsolute(dir) || sameDir(resolve(dir), here, windows)) continue;
    if (dir.split(/[\\/]/).some((segment) => segment.toLowerCase() === "node_modules")) continue;
    dirs.push(dir);
  }
  const safePath = dirs.join(delimiter);
  for (const dir of dirs) {
    if (!windows) {
      const npm = join(dir, "npm");
      if (isFile(npm)) return { command: npm, args: [], path: safePath };
      continue;
    }
    if (!isFile(join(dir, "npm.cmd"))) continue;
    const cli = join(dir, "node_modules", "npm", "bin", "npm-cli.js");
    if (!isFile(cli)) continue;
    const node = join(dir, "node.exe");
    return { command: isFile(node) ? node : execPath, args: [cli], path: safePath };
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
